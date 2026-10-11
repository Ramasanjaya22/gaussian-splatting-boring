/**
 * Verifies the thing that matters: the rendered pixels actually change when the
 * virtual head moves, and the camera/audit counters behave.
 */
import { chromium } from "playwright";
import fs from "node:fs";

const OUT = process.env.OUT || "shots";
fs.mkdirSync(OUT, { recursive: true });
const SPLAT = process.env.SPLAT || "small.ply";
const META = process.env.META || "small.json";

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
         "--ignore-gpu-blocklist", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
const ctx = await browser.newContext({ viewport: { width: 800, height: 500 }, permissions: ["camera"] });
const page = await ctx.newPage();

const errors = [], thirdParty = [], csp = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
  if (/Content Security Policy|Refused to/i.test(m.text())) csp.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("request", (r) => {
  const u = new globalThis.URL(r.url());
  if (u.host && u.host !== "127.0.0.1:5173") thirdParty.push(`${r.method()} ${u.host}${u.pathname}`);
});

await page.goto(`http://127.0.0.1:5173/?readback=1&splat=${SPLAT}&meta=${META}`,
                { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
await page.waitForTimeout(1200);

async function grab(name) {
  const b64 = await page.evaluate(() => {
    window.__three.renderer.render(window.__three.scene, window.__three.camera);
    return window.__three.renderer.domElement.toDataURL("image/png");
  });
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(b64.split(",")[1], "base64"));
  return b64;
}
async function setPose(xyz, rxyz = [0, 0, 0]) {
  await page.evaluate(([a, b]) => window.__setPose(a, b), [xyz, rxyz]);
  await page.waitForTimeout(350);
}

await setPose([0, 0, 0]);
const neutral = await grab("1-neutral");

await setPose([-0.28, 0, 0], [0, -0.4, 0]);
const left = await grab("2-lean-left");

await setPose([0.28, 0, 0], [0, 0.4, 0]);
const right = await grab("3-lean-right");

await setPose([0, 0, -0.45]);
const inward = await grab("4-lean-in");

// pixel difference between viewpoints, measured in-page
const diffLR = await page.evaluate(async () => {
  const { renderer, scene, camera } = window.__three;
  const px = () => {
    renderer.render(scene, camera);
    const c = renderer.domElement;
    const t = document.createElement("canvas");
    t.width = 160; t.height = 100;
    t.getContext("2d").drawImage(c, 0, 0, 160, 100);
    return t.getContext("2d").getImageData(0, 0, 160, 100).data;
  };
  const set = (x) => window.__setPose([x, 0, 0], [0, 0, 0]);
  set(-0.28); await new Promise(r => setTimeout(r, 250)); const a = px();
  set(0.28); await new Promise(r => setTimeout(r, 250)); const b = px();
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) sum += Math.abs(a[i] - b[i]);
  return +(sum / (a.length / 4)).toFixed(2);
});

// camera on, audit counters live
await page.click("#btnEnable");
await page.waitForTimeout(7000);
const stats = await page.evaluate(() => {
  const g = (id) => document.getElementById(id)?.textContent;
  return { sinceArmed: g("sSince"), frames: g("sFrames"), storage: g("sStore"),
           third: g("sThird"), mode: document.getElementById("modeLabel")?.textContent };
});

await page.click("#btnAudit");
await page.waitForTimeout(500);
const b64 = await page.evaluate(() => window.__three.renderer.domElement.toDataURL("image/png"));
fs.writeFileSync(`${OUT}/5-camera-on.png`, Buffer.from(b64.split(",")[1], "base64"));

console.log(JSON.stringify({
  splat: SPLAT,
  meanDeltaLeftVsRight: diffLR,
  auditWhileCameraOn: stats,
  thirdPartyRequests: thirdParty,
  cspViolations: csp,
  errors: errors.slice(0, 10),
  shots: fs.readdirSync(OUT),
}, null, 2));
await browser.close();