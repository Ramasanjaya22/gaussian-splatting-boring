import * as THREE from "three";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { Audit } from "./privacy.js";

// Must exist before any module-level network call, so nothing slips past it.
const audit = new Audit();

const $ = (id) => document.getElementById(id);
const reticle = $("reticle");

// --- head -> camera coupling -------------------------------------------------
// Translation is 1:1 in metres: your eye really does move that far, and that
// disparity is the whole illusion. Rotation is damped - following head rotation
// 1:1 is both wrong (your eyes rotate, not your viewpoint) and nauseating.
const POS_GAIN = 1.0;
const ROT_GAIN = 0.45;

// Pointer fallback uses a smaller range: a mouse can't lean.
const MOUSE_RANGE = 0.13;

const CALIBRATION_FRAMES = 24;

const params = new URLSearchParams(location.search);

let scene, camera, renderer, spark, splat;
let mode = "splat";            // "splat" | "mouse" | "camera"
let stream = null;
let landmarker = null;
let video = null;

// live head pose, in metres, relative to the calibrated rest pose
const pose = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 };
const rest = { samples: [], matrix: null };
let lastVideoTime = -1;

// ---------------------------------------------------------------------------
// one-euro filter: low lag when you move, low jitter when you don't
// ---------------------------------------------------------------------------
class OneEuro {
  constructor({ minCutoff = 1.2, beta = 0.012, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = null;
    this.dx = 0;
  }
  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(v, dt) {
    if (this.x === null) { this.x = v; this.dx = 0; return v; }
    const aD = OneEuro.alpha(this.dCutoff, dt);
    this.dx = aD * (v - this.x) / dt + (1 - aD) * this.dx;
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    const a = OneEuro.alpha(cutoff, dt);
    this.x = a * v + (1 - a) * this.x;
    return this.x;
  }
  reset() { this.x = null; this.dx = 0; }
}

const filters = {
  x: new OneEuro(), y: new OneEuro(), z: new OneEuro(),
  rx: new OneEuro({ minCutoff: 1.0, beta: 0.006 }),
  ry: new OneEuro({ minCutoff: 1.0, beta: 0.006 }),
  rz: new OneEuro({ minCutoff: 1.0, beta: 0.006 }),
};

// ---------------------------------------------------------------------------
// scene
// ---------------------------------------------------------------------------
function fail(stage, err) {
  // A dead WebGL context or an unreadable splat previously meant a silent black
  // screen. Say what broke instead.
  console.error(`[scene] ${stage} failed`, err);
  const box = $("fatal");
  if (box) {
    box.querySelector("code").textContent = String(err?.message || err);
    box.querySelector("span").textContent = stage;
    box.hidden = false;
  }
  window.__ready = true;
}

async function initScene() {
  const q = params;
  // BASE_URL is "/" in dev, "/boring/" in the Pages build - so the same code
  // works at both roots without hardcoded absolute paths.
  const base = import.meta.env.BASE_URL;
  const splatUrl = q.get("splat") || `${base}scene.ply`;
  const metaUrl = q.get("meta") || `${base}scene.json`;

  let meta;
  try {
    const res = await fetch(metaUrl);
    if (!res.ok) throw new Error(`${metaUrl} -> HTTP ${res.status}`);
    meta = await res.json();
  } catch (err) {
    fail("loading scene metadata", err);
    return;
  }

  scene = new THREE.Scene();
  scene.userData.meta = meta;
  camera = new THREE.PerspectiveCamera(meta.vfov, innerWidth / innerHeight, 0.05, meta.zFar);

  // preserveDrawingBuffer costs a little perf, so only when a test asks for readback.
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer: params.has("readback"),
    });
  } catch (err) {
    fail("creating the WebGL context", err);
    return;
  }
  if (!renderer.getContext()) {
    fail("creating the WebGL context", new Error("WebGL unavailable"));
    return;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  document.body.appendChild(renderer.domElement);

  // Losing the context (GPU reset, driver hiccup) leaves a black canvas too.
  renderer.domElement.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    fail("the GPU dropped the WebGL context", new Error("context lost - reload the page"));
  });

  spark = new SparkRenderer({ renderer });
  scene.add(spark);

  splat = new SplatMesh({ url: splatUrl });
  scene.add(splat);
  splat.addEventListener?.("error", (e) => fail(`loading ${splatUrl}`, e.detail || e));
  splat.addEventListener?.("load", () => {
    $("fatal").hidden = true;
    window.__ready = true;
  });

  addEventListener("resize", onResize);
  onResize(meta);
  renderer.setAnimationLoop(frame);

  // debug/inspection handle
  window.__three = { THREE, scene, camera, renderer, splat, spark };
  console.log("[scene] loaded", meta, splatUrl);

  // Readiness signal for the render check: wait until splats are actually on screen.
  const markReady = () => { window.__ready = true; };
  const poll = setInterval(() => {
    const tris = renderer.info.render.triangles;
    if (tris > 0 || splat.loaded) { clearInterval(poll); markReady(); }
  }, 250);
  setTimeout(() => { clearInterval(poll); markReady(); }, 12000);
}

function onResize(meta = scene?.userData?.meta) {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h);

  // "contain" fit: at rest, the render reproduces the source image exactly.
  const target = w / h;
  const source = meta?.aspect ?? target;
  if (target > source) {
    camera.fov = meta?.vfov ?? 40;
  } else {
    const vfov = meta?.vfov ?? 40;
    camera.fov = THREE.MathUtils.radToDeg(
      2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(vfov) / 2) * (source / target))
    );
  }
  camera.aspect = target;
  camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------------------
// pointer fallback (no camera, and the privacy-friendly default)
// ---------------------------------------------------------------------------
addEventListener("pointermove", (e) => {
  if (mode !== "mouse") return;
  const nx = (e.clientX / innerWidth) * 2 - 1;
  const ny = (e.clientY / innerHeight) * 2 - 1;
  pose.x = nx * MOUSE_RANGE;
  pose.y = -ny * MOUSE_RANGE * 0.7;
  pose.z = -Math.abs(nx) * MOUSE_RANGE * 0.5;
  pose.rx = ny * 0.05;
  pose.ry = nx * 0.09;
  pose.rz = 0;
  reticle.style.transform = `translate(${e.clientX - 11}px, ${e.clientY - 11}px)`;
});

// ---------------------------------------------------------------------------
// MediaPipe face landmarker - all assets served from this origin
// ---------------------------------------------------------------------------
async function startCamera() {
  $("modeLabel").textContent = "starting camera…";

  stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
    audio: false,
  });

  // The same stream element is shown in the debug panel, so "what the camera
  // sees" is literally visible instead of being a black box.
  video = document.createElement("video");
  video.playsInline = true;
  video.muted = true;
  video.srcObject = stream;
  $("dbgVideo").replaceWith(video);
  video.id = "dbgVideo";
  video.addEventListener("loadedmetadata", () => {
    const wrap = video.parentElement;
    wrap.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
    const c = $("dbgCanvas");
    c.width = video.videoWidth;
    c.height = video.videoHeight;
  });
  await video.play();

  const { FilesetResolver, FaceLandmarker } = await import("@mediapipe/tasks-vision");
  const base = import.meta.env.BASE_URL;
  const vision = await FilesetResolver.forVisionTasks(`${base}mediapipe/wasm`);
  landmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: `${base}mediapipe/face_landmarker.task`, delegate: "GPU" },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: true,
  });

  Object.values(filters).forEach((f) => f.reset());
  rest.samples.length = 0;
  rest.matrix = null;
  lastVideoTime = -1;
  lostFrames = 0;

  mode = "camera";
  audit.arm();
  $("modeLabel").textContent = "head tracking · local";
  $("btnCam").textContent = "Stop camera";
  $("gate").classList.remove("show");
  reticle.classList.add("live");
  $("sPose").textContent = "0, 0, 0";
  $("debug").classList.add("show");
}

function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video?.remove();
  video = null;
  landmarker?.close?.();
  landmarker = null;
  mode = "splat";
  Object.values(filters).forEach((f) => f.reset());
  $("modeLabel").textContent = "splat only";
  $("btnCam").textContent = "Camera";
  reticle.classList.remove("live");
  $("debug").classList.remove("show");
}

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qr = new THREE.Quaternion();
const _e = new THREE.Euler();
const _off = new THREE.Vector3();

// Tracking-loss handling. When the face disappears the head is by definition
// at an extreme (turned far, out of frame) - freezing the pose there wedges the
// camera staring at empty space: a black screen that never recovers. Instead
// the pose eases back to neutral while lost, so the view always drifts home.
let lostFrames = 0;
// fraction of the pose shed per second while lost (~0.3s to mostly recenter)
const LOST_DECAY = 8;
// after this many lost frames the filters are stale; reset on reacquire
const LOST_RESET_AFTER = 15;

// Hard limits on the pose so the camera can never leave the scene geometry,
// even at the wildest head angle. Position in metres, rotation in radians
// (pre-gain values).
const POSE_LIMIT = {
  x: 0.45, y: 0.35, z: 0.45,
  rx: 0.9, ry: 0.9, rz: 0.6,
};

function clampPose() {
  pose.x = THREE.MathUtils.clamp(pose.x, -POSE_LIMIT.x, POSE_LIMIT.x);
  pose.y = THREE.MathUtils.clamp(pose.y, -POSE_LIMIT.y, POSE_LIMIT.y);
  pose.z = THREE.MathUtils.clamp(pose.z, -POSE_LIMIT.z, POSE_LIMIT.z);
  pose.rx = THREE.MathUtils.clamp(pose.rx, -POSE_LIMIT.rx, POSE_LIMIT.rx);
  pose.ry = THREE.MathUtils.clamp(pose.ry, -POSE_LIMIT.ry, POSE_LIMIT.ry);
  pose.rz = THREE.MathUtils.clamp(pose.rz, -POSE_LIMIT.rz, POSE_LIMIT.rz);
}

function updatePoseReadout() {
  const dPose = $("dPose");
  if (dPose) {
    dPose.textContent =
      `${pose.x.toFixed(3)}, ${pose.y.toFixed(3)}, ${pose.z.toFixed(3)} · ` +
      `${pose.rx.toFixed(2)}, ${pose.ry.toFixed(2)}, ${pose.rz.toFixed(2)}`;
  }
  $("sPose").textContent =
    `${pose.x.toFixed(3)}, ${pose.y.toFixed(3)}, ${pose.z.toFixed(3)} m`;

  const cx = innerWidth / 2 + pose.x * 900;
  const cy = innerHeight / 2 - pose.y * 900;
  reticle.style.transform = `translate(${cx - 11}px, ${cy - 11}px)`;
}

// How far the camera sits *inside* the scene (negative z). The nearest splat is
// ~1.4 m out; parking the camera 0.8 m in front of it makes the image read as
// "standing in the corridor" rather than "looking at a picture on a wall".
const CAM_Z = parseFloat(params.get("camz")) || -0.8;

// Draw the camera feed + landmark overlay into the debug panel, and show the
// raw-vs-calibrated numbers so tracking accuracy is inspectable.
function drawDebug(res) {
  const c = $("dbgCanvas");
  if (!c || !video) return;
  const ctx = c.getContext("2d");
  const w = c.width, h = c.height;
  if (!w || !h) return;

  // mirrored to match the CSS transform on the video
  ctx.save();
  ctx.scale(-1, 1);
  ctx.translate(-w, 0);
  ctx.drawImage(video, 0, 0, w, h);
  ctx.restore();

  const faces = res.faceLandmarks || [];
  const set = (id, v, cls) => {
    const el = $(id);
    if (!el) return;
    el.textContent = v;
    el.className = `val ${cls || ""}`;
  };

  set("dFace", faces.length ? "yes" : "no", faces.length ? "ok" : "warn");
  set("dCount", faces.length ? String(faces[0].length) : "0");
  set("dVid", `${video.videoWidth}×${video.videoHeight}`);

  if (!faces.length) return;

  // landmarks are normalised to the video frame; mirror x to match the video
  ctx.fillStyle = "rgba(110,231,168,.85)";
  for (const p of faces[0]) {
    ctx.beginPath();
    ctx.arc((1 - p.x) * w, p.y * h, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

function pollFace(dt) {
  if (!landmarker || !video || video.readyState < 2) return;
  if (video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;

  const res = landmarker.detectForVideo(video, performance.now());
  const mats = res.facialTransformationMatrixes;

  drawDebug(res);

  if (!mats?.length) {
    // Face lost: don't freeze at the (extreme) last pose. Ease back to
    // neutral so the view recovers to the scene instead of blackness.
    lostFrames++;
    const k = Math.exp(-LOST_DECAY * dt);
    pose.x *= k; pose.y *= k; pose.z *= k;
    pose.rx *= k; pose.ry *= k; pose.rz *= k;
    updatePoseReadout();
    const dFace = $("dFace");
    if (dFace) {
      dFace.textContent = `lost ${lostFrames}`;
      dFace.className = "val warn";
    }
    reticle.classList.remove("live");
    return;
  }
  if (lostFrames >= LOST_RESET_AFTER) {
    // Filters hold stale velocity from before the loss; a fresh start avoids
    // a snap when the face reappears somewhere else.
    Object.values(filters).forEach((f) => f.reset());
  }
  lostFrames = 0;
  reticle.classList.add("live");

  _m.fromArray(mats[0].data);
  _m.decompose(_p, _q, new THREE.Vector3());

  // MediaPipe face space is X right, Y up, Z toward the viewer, in centimetres.
  const x = _p.x / 100, y = _p.y / 100, z = -_p.z / 100;

  const dRaw = $("dRaw");
  if (dRaw) dRaw.textContent = `${(_p.x).toFixed(1)}, ${(_p.y).toFixed(1)}, ${(_p.z).toFixed(1)}`;
  const dYaw = $("dYaw");
  if (dYaw) {
    // yaw straight from the matrix, before calibration - the sign tells you if
    // turning your head left makes ry go positive or negative.
    _e.setFromQuaternion(_q, "YXZ");
    dYaw.textContent = `${THREE.MathUtils.radToDeg(_e.y).toFixed(1)}°`;
  }

  // First N detections define the rest pose, so "sitting square to the screen"
  // is the origin and the effect is symmetric.
  if (rest.samples.length < CALIBRATION_FRAMES) {
    rest.samples.push([x, y, z, _q.x, _q.y, _q.z, _q.w]);
    const dCalib = $("dCalib");
    if (dCalib) {
      dCalib.textContent = `sampling ${rest.samples.length}/${CALIBRATION_FRAMES}`;
      dCalib.className = "val warn";
    }
    if (rest.samples.length === CALIBRATION_FRAMES) {
      const med = (i) => {
        const col = rest.samples.map((s) => s[i]).sort((a, b) => a - b);
        return col[col.length >> 1];
      };
      rest.matrix = rest.samples[0].map((_, i) => med(i));
      if (dCalib) {
        dCalib.textContent = "done";
        dCalib.className = "val ok";
      }
    }
    return;
  }
  const r = rest.matrix;
  if (!r) return;

  pose.x = filters.x.filter(x - r[0], dt);
  pose.y = filters.y.filter(y - r[1], dt);
  pose.z = filters.z.filter(z - r[2], dt);

  // Rotation relative to rest. Component-wise subtraction is meaningless for
  // quaternions; the relative rotation is q_rel = q_rest^-1 * q_current.
  _qr.set(r[3], r[4], r[5], r[6]).invert();
  _q.premultiply(_qr);
  _e.setFromQuaternion(_q, "YXZ");
  pose.rx = filters.rx.filter(_e.x, dt);
  pose.ry = filters.ry.filter(_e.y, dt);
  pose.rz = filters.rz.filter(_e.z, dt);
  clampPose();
  updatePoseReadout();
}

// ---------------------------------------------------------------------------
// frame
// ---------------------------------------------------------------------------
let prev = performance.now();

// Test hook: drive the pose without a camera so the effect is verifiable
// in CI (and on machines with no webcam). Tracking yields while it's set.
let manualPose = false;
window.__setPose = (xyz = [0, 0, 0], rxyz = [0, 0, 0]) => {
  manualPose = true;
  Object.assign(pose, { x: xyz[0], y: xyz[1], z: xyz[2], rx: rxyz[0], ry: rxyz[1], rz: rxyz[2] });
};
window.__releasePose = () => { manualPose = false; };

function frame() {
  const now = performance.now();
  const dt = Math.min((now - prev) / 1000, 0.1);
  prev = now;

  if (mode === "camera" && !manualPose) pollFace(dt);

  // Head yaw rotates the eye position as well as the view - that coupling is
  // what stops it feeling like a flat image on a hinge.
  _e.set(pose.rx * ROT_GAIN, pose.ry * ROT_GAIN, pose.rz * ROT_GAIN, "YXZ");
  _q.setFromEuler(_e);
  _off.set(pose.x, pose.y, pose.z).multiplyScalar(POS_GAIN).applyQuaternion(_q);

  camera.position.set(_off.x, _off.y, _off.z + CAM_Z);
  camera.quaternion.copy(_q);

  renderer.render(scene, camera);
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
function renderAudit() {
  const set = (id, v, cls) => {
    const el = $(id);
    if (!el) return;
    el.textContent = v;
    el.className = `val ${cls}`;
  };
  const log = $("log");
  if (log) {
    log.innerHTML = audit.entries
      .slice(-80)
      .reverse()
      .map((e) => `<div><span class="tag">${e.kind}</span>${e.self ? "" : "⚠ "}${e.url}${
        e.detail ? ` <em style="color:var(--warn)">${e.detail}</em>` : ""
      }</div>`)
      .join("");
  }
  if (!audit.ready) return;
  const s = audit.stats();
  // Split by origin: same-origin asset loads (the shipped JS/wasm) are not
  // exfiltration, and lumping them in makes a clean bill of health look dirty.
  set("sSince", `${s.substantiveSinceArmed} off-origin / ${s.sinceArmed} total`,
      s.substantiveSinceArmed === 0 ? "ok" : "warn");
  set("sFrames", s.frameAttempts, s.frameAttempts === 0 ? "ok" : "warn");
  set("sStore", `${s.storageBytes} B`, s.storageBytes === 0 ? "ok" : "warn");
  set("sThird", s.thirdParty, s.thirdParty === 0 ? "ok" : "warn");
}

function wireUi() {
  audit.onChange = renderAudit;

  $("btnEnable").onclick = () => startCamera().catch((err) => {
    $("modeLabel").textContent = "camera denied";
    console.warn("[camera]", err);
  });
  $("btnMouse").onclick = () => {
    mode = "mouse";
    $("modeLabel").textContent = "pointer parallax";
    $("gate").classList.remove("show");
  };
  $("btnCam").onclick = () => (mode === "camera" ? stopCamera() : startCamera().catch(console.warn));
  const toggleAudit = () => $("audit").classList.toggle("show");
  $("btnLearn").onclick = toggleAudit;
  $("btnAudit").onclick = toggleAudit;
  $("btnAudit2").onclick = toggleAudit;
  // The nav Debug button is "show" (not toggle) so a hidden panel can be
  // reliably brought back; the ✕ inside the panel is what hides it.
  $("btnDebug").onclick = () => $("debug").classList.add("show");
  $("btnDebugHide").onclick = () => $("debug").classList.remove("show");
  $("btnRecalib").onclick = () => {
    Object.values(filters).forEach((f) => f.reset());
    rest.samples.length = 0;
    rest.matrix = null;
    lastVideoTime = -1;
  };
  $("btnCut").onclick = () => {
    audit.setCut(!audit.cut);
    $("btnCut").textContent = audit.cut ? "Reconnect" : "Cut the wire";
    $("btnCut").classList.toggle("danger", audit.cut);
  };
  $("btnReset").onclick = () => {
    audit.setCut(false);
    $("btnCut").textContent = "Cut the wire";
    $("btnCut").classList.remove("danger");
  };
}

// Modules run before the parser finishes, so wait for the DOM before wiring.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    audit.ready = true;
    wireUi();
    renderAudit();
  });
} else {
  audit.ready = true;
  wireUi();
  renderAudit();
}

initScene().then(() => {
  $("gate").classList.add("show");
  renderAudit();
}).catch((err) => {
  console.error("[scene] init failed", err);
  $("modeLabel").textContent = "render failed";
});