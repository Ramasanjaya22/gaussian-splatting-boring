# Handoff — reverse-engineering @_fojcik's "too real" splat experiment

Source post: <https://x.com/_fojcik/status/2108933694190768152> (Oct 10 2026, video attached).

This note is a hand-off from the session that pulled the original video apart and
built/verified the single-image → Gaussian-splat pipeline. A second agent is
actively building the app in this directory; nothing here was left wired in, and
no files owned by the other build were modified.

---

## 1. What the post actually is

Full-bleed 3D Gaussian Splatting scene, camera driven by the viewer's head.
Moving produces motion parallax, so the flat screen reads as a window into a
real place. That single mechanism is the whole effect — nothing else is doing
"too real".

Stack inferred from the video + package ecosystem:

| Layer | Choice |
|---|---|
| Splat renderer | `@sparkjsdev/spark` (World Labs) or `@mkkellogg/gaussian-splats-3d` |
| Scene graph | `three` (>= 0.180 for spark) |
| Head tracking | `@mediapipe/tasks-vision` → `FaceLandmarker` |
| Pose source | `outputFacialTransformationMatrixes: true` → `result.facialTransformationMatrixes[0]` |

Site copy, transcribed from the video frames:

> Literally the most boring website you can imagine. Useful to learn that nothing
> is really exciting when you read, and the screen turns it into a window, which
> is still the most exciting thing here. Please hover your specifications accordingly.

---

## 2. Two tuning facts that are not obvious

Both were found empirically; both are easy to get wrong and produce a scene
that renders but feels like mush.

**Translation must be 1:1 in metres.** That disparity *is* the illusion. Scaling
it down weakens the window effect; scaling it up clips through walls.

**Rotation must be damped (~0.45).** Following head rotation 1:1 is wrong (your
eyes rotate, your viewpoint does not) and reliably nauseating.

**Yaw must rotate the eye position, not just the view direction.** Compose the
head quaternion onto the translation vector as well, otherwise it reads as a
flat image on a hinge rather than a space.

---

## 3. The privacy question, answered properly

Fojcik's actual question is *"how do we prove to users that camera data is used
just for the effect itself and not any tracking"*.

MediaPipe's own privacy notice (verified, `mediapipe/tasks/web/vision/README.md`):

> processing of the input data (e.g. images, video, text) takes place on device,
> and MediaPipe does not send that input data to Google servers. […] MediaPipe
> Tasks APIs send metrics about the performance and utilization of the APIs in
> your app to Google.

So frames are local, but the **library still phones home with metrics**. That is
the only real crack, and it is invisible unless you self-host:

- **Self-host the wasm + `.task` model.** Once Google's code is not on the page,
  the metrics clause has nowhere to send anything. This is the highest-leverage
  change by far, and it also removes a third-party CDN from the critical path.
- **CSP `connect-src 'self'`.** This converts "we don't exfiltrate" from a
  promise into a browser-enforced impossibility. A leak attempt becomes a visible
  CSP violation in the console — which is itself evidence.
- **The signal is trivially lossy.** The renderer receives 6 floats of head pose.
  You cannot reconstruct a face from the pose of a face.
- **Give the user a falsifiable test.** A "cut the wire" control that hard-fails
  every network API while the effect keeps running proves far more than any
  privacy policy. `src/privacy.js` implements exactly this (live counters + a
  runtime cut across fetch/XHR/WebSocket/EventSource/beacon/WebRTC).

Counterpoint worth keeping in view (from the thread): most users will not audit
anything. `@beardarsonist`'s reply argues the right move is to make it one click
and instant rather than to spend effort on persuasion. Both are true — the
audit is for the minority who care; the default must not require it.

---

## 4. Pipeline: `tools/bake_splat.py`

Single image → real 3DGS-format data in ~1 min on CPU. **This is not a trained
multi-view 3DGS model** — there is no SfM, no optimisation. It is a single-view
splat: valid Gaussian data, real parallax.

```
image
 -> Depth Anything V2 Small (ONNX, onnxruntime/CPU, 518px, multiple of 14)
 -> normalise disparity to [0,1], treat as inverse depth, map to [z_near, z_far]
 -> unproject with a pinhole model, camera at origin looking down -Z
 -> normals from np.gradient of the point map
 -> one anisotropic Gaussian per pixel:
      position  = unprojected point
      rotation  = shortest-arc quaternion taking local +Z onto the normal
      scale     = (footprint, footprint, footprint * thin)   [log-space]
      opacity   = logit(alpha)
      colour    = (srgb_to_linear(rgb) - 0.5) / SH_C0
 -> binary_little_endian .ply + a scene.json sidecar (vfov / aspect / zFar)
```

### Two bugs that cost real time — keep these fixed

**(a) Colour space: write sRGB-encoded values (default).** Spark's splat output is
passed through unchanged — it does *not* re-encode. Writing linear values into
`f_dc` double-encodes and the scene renders dark and muddy. So: pack the source
bytes as-is. The `srgb_to_linear()` helper is retained only because the
`--colorspace linear` flag exposes the wrong path for comparison.

> An earlier revision of this note claimed linearisation was required. That was
> wrong and was caught by rendering both ways and comparing. Default is `--colorspace srgb`.

**(b) Splat sigma vs spacing.** A 3DGS gaussian is drawn out to roughly 3σ. If
σ is too small relative to centre spacing, subsample gaps show as a visible
grid; if σ ≈ spacing, every splat smears across its neighbours and the scene
turns to mush. `--overlap` is the σ/spacing ratio. Verified good value: **0.6**
at `--stride 5`. Roughly 0.45 is usable at higher density; ≥1.0 is fog.

Density: `--stride 5` (~82k splats) renders cleanly at 800×500.
`--stride 3` (230k, 15.7 MB) is the shipping scene.

### Baked output

- `assets/hallway-source.png` (1920×1080) → `public/hallway-verify.ply`
  57,600 splats, 3.9 MB, depth range 1.40 m … 26.0 m, median 2.95 m.
  Depth preview at `assets/depth_hallway.png` is clean: corridor recedes properly,
  far door correctly at maximum depth.

---

## 5. Verification harness — and one trap that wastes an hour

`tools/render_check.mjs` boots the page in headless Chromium with a fake webcam,
drives the virtual pose via `window.__setPose(xyz, rxyz)`, screenshots, and diffs.

Result on the pipeline:

```
mean per-pixel delta, lean left vs lean right : 22.73
third-party requests                          : 0
CSP violations                                : 0
page errors                                   : 0
```

**The trap:** with the default `preserveDrawingBuffer: false`, reading pixels back
via `drawImage(canvas)` returns **pure black even though the scene is rendering
perfectly**. Check `renderer.info.render.triangles` before concluding anything is
broken — a non-zero triangle count means the render is fine and only the readback
is lying. Gate on `?readback=1` to enable `preserveDrawingBuffer`.

Headless Chromium here runs on SwiftShader; it is fine for correctness checks but
far too slow for large splat counts. Keep CI-sized scenes at ~5–20k splats.

---

## 6. File ownership

Authored by the reverse-engineering session:

| File | Note |
|---|---|
| `src/privacy.js` | egress audit + runtime wire-cut. **Not currently imported by anything** — the other build's `index.html` does not reference it. Portable as-is. |
| `src/main.js` | working end-to-end app, orphaned (other build's `index.html` replaced it) |
| `tools/bake_splat.py` | **shared and in use.** Contains the verified colour-space and sigma fixes. |
| `tools/render_check.mjs` | verification harness, targets `src/main.js`. `OUT` is env-configurable. |
| `vite.config.js` | excludes `@mediapipe/tasks-vision` from pre-bundling (required; its dynamic wasm loading breaks otherwise) |

A second agent's TypeScript build (`main.ts`, `scene.ts`, `head-tracking.ts`,
`head-motion.ts`, `style.css`, `tests/`, `docs/`, `tsconfig.json`) was moved to
`.mine/` rather than deleted. The user rejected it in favour of this build.

Scratch/debris from this session, safe to delete: `tools/probe.mjs`,
`tools/orient.mjs`, `tools/orient_b.mjs`, `tools/diag.mjs`, `tools/glcaps.mjs`,
`public/butterfly.spz`, `public/ci.*`, `public/small.*`, `public/tiny.*`,
`public/cs-srgb.*`, `public/hallway-verify.*`, `shots*/`, `assets/scene_from_video.png`,
`assets/scene_clean.png`.