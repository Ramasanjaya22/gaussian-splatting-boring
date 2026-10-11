# BORING — too real

A replica of [@_fojcik's experiment](https://x.com/_fojcik/status/2108933694190768152):
a hallway render baked into a single-image Gaussian splat, rendered with
Three.js + Spark, with head-tracked motion parallax via a local MediaPipe
Face Landmarker. Move your head and the corridor behaves like a window.

Camera frames never leave the tab. The privacy claim is enforced, not promised:
a `connect-src 'self'` CSP plus a live egress audit and a "cut the wire" button
that hard-fails every network API while the effect keeps running.

## Run locally

Requirements: Node.js 24+, pnpm.

```sh
pnpm install
pnpm dev
```

Open http://127.0.0.1:5173. The camera stays off until you click
**Use my camera**; **Just move the mouse** works without any camera.

## Build & deploy

```sh
pnpm build          # root deployment (/)
PAGES_BASE=/boring/ pnpm build   # subpath deployment (/boring/)
```

`dist/` is fully static. Runtime asset paths (`scene.ply`, MediaPipe wasm/model)
follow `import.meta.env.BASE_URL`, so the same code works at any root.

## Re-bake the scene (optional)

`public/scene.ply` is a baked artifact from `assets/hallway-source.png`
(230k splats, sRGB, sigma ≈ 0.6× spacing). To re-bake you need Python with
NumPy, OpenCV, ONNX Runtime, Pillow, plus the Depth Anything V2 small ONNX
weights at `tools/models/depth_anything_v2_small.onnx` (not committed —
94 MB; export from the official Depth Anything V2 release yourself):

```sh
python tools/bake_splat.py --image assets/hallway-source.png --strip-overlay 0 \
  --stride 3 --colorspace srgb --overlap 0.6 --out public/scene.ply \
  --depth-preview assets/depth.png
```

Depth comes from one image, so this is a single-view approximation: limited
parallax, no unseen geometry. It is not a trained multi-view 3DGS model.

## Camera privacy

Head tracking is off until explicitly enabled. After consent, frames are
processed in-tab by the self-hosted MediaPipe model (`public/mediapipe/`,
no Google contact). Only a 6-float head pose reaches the renderer.
The audit panel counts every outbound request live; **Cut the wire** kills
fetch / XHR / WebSocket / EventSource / WebRTC / beacon to prove the effect
survives with no network at all.
