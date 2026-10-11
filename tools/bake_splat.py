#!/usr/bin/env python3
"""
Bake a Gaussian Splatting scene (.ply) from a single image.

  image -> monocular depth (Depth Anything V2, onnxruntime/CPU)
        -> unproject to 3D
        -> one camera-facing anisotropic Gaussian per pixel

This is NOT a trained 3DGS model (no multi-view SfM). It is a single-view
splat: depth-positioned splats give limited parallax, baked in ~1 min on CPU.

  python tools/bake_splat.py --image assets/scene.png --out public/scene.ply
"""
import argparse
import json
import os
import sys

import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
MODEL = os.path.join(HERE, "models", "depth_anything_v2_small.onnx")

# 3DGS spherical-harmonics DC constant and its inverse.
SH_C0 = 0.28209479177387814

IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], np.float32)


def depth_anything(image: Image.Image, side: int = 518) -> np.ndarray:
    """Relative *inverse* depth (disparity). Larger = closer."""
    sess = ort.InferenceSession(MODEL, providers=["CPUExecutionProvider"])
    name = sess.get_inputs()[0].name

    w, h = image.size
    scale = side / max(w, h)
    nw, nh = int(round(w * scale / 14)) * 14, int(round(h * scale / 14)) * 14
    nw, nh = max(nw, 14), max(nh, 14)

    rgb = np.asarray(image.convert("RGB").resize((nw, nh), Image.BICUBIC), np.float32) / 255.0
    x = ((rgb - IMAGENET_MEAN) / IMAGENET_STD).transpose(2, 0, 1)[None]

    disp = sess.run(None, {name: x})[0][0]  # (nh, nw)
    return cv2.resize(disp, (w, h), interpolation=cv2.INTER_CUBIC)


def disparity_to_depth(disp: np.ndarray, z_near: float, z_far: float,
                       lo_pct: float, hi_pct: float) -> np.ndarray:
    """Normalise disparity to [0,1], then treat it as inverse depth."""
    lo, hi = np.percentile(disp, [lo_pct, hi_pct])
    d = np.clip((disp - lo) / max(hi - lo, 1e-6), 0.0, 1.0)
    # disp == 1 -> z_near, disp -> 0 -> z_far
    return z_near / np.maximum(d, z_near / z_far)


def unproject(depth: np.ndarray, fov_deg: float) -> tuple[np.ndarray, float]:
    """Pixels -> camera-space points.

    Camera sits at the origin looking down -Z (Three.js convention), +X right,
    +Y up. Baking in camera-relative coords means the neutral head pose renders
    pixel-for-pixel back to the source image.
    """
    h, w = depth.shape
    fx = (0.5 * w) / np.tan(0.5 * np.deg2rad(fov_deg))
    fy = fx
    cx, cy = w * 0.5, h * 0.5

    u, v = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    z = -depth
    distance = -z
    x = (u - cx) * distance / fx
    y = (cy - v) * distance / fy
    return np.stack([x, y, z], -1).reshape(-1, 3), fx


def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    """Source pixels are sRGB-encoded; splat colours are linear.

    Skip this and the renderer re-encodes already-encoded values, which shows up
    as washed-out pastel.
    """
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def find_overlay_mask(arr: np.ndarray, top_frac: float, thresh: int,
                      tol: int) -> np.ndarray:
    """Bright, desaturated pixels in the lower band = burned-in site copy."""
    h, w = arr.shape[:2]
    y0 = int(h * top_frac)
    band = arr[y0:]
    mx = band.max(axis=2).astype(np.int16)
    mn = band.min(axis=2).astype(np.int16)
    mask = ((mx >= thresh) & ((mx - mn) <= tol)).astype(np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    mask = cv2.dilate(mask, np.ones((3, 3), np.uint8), iterations=2)
    full = np.zeros((h, w), np.uint8)
    full[y0:] = mask
    return full


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", default=os.path.join(ROOT, "assets", "scene_from_video.png"))
    ap.add_argument("--out", default=os.path.join(ROOT, "public", "scene.ply"))
    ap.add_argument("--side", type=int, default=518, help="depth model input side")
    ap.add_argument("--stride", type=int, default=2, help="pixel stride (splats = px/stride^2)")
    ap.add_argument("--fov", type=float, default=62.0, help="assumed horizontal FOV (deg)")
    ap.add_argument("--z-near", type=float, default=1.4)
    ap.add_argument("--z-far", type=float, default=26.0)
    ap.add_argument("--overlap", type=float, default=0.45,
                    help="splat sigma as a fraction of centre spacing (x2*spacing would tile)")
    ap.add_argument("--thin", type=float, default=0.035, help="splat thickness along the normal")
    ap.add_argument("--opacity", type=float, default=0.97)
    ap.add_argument("--strip-overlay", type=int, default=1,
                    help="inpaint burned-in bright site copy in the lower band")
    ap.add_argument("--colorspace", choices=("srgb", "linear"), default="srgb",
                    help="srgb (default, verified): write encoded values, which Spark "
                         "passes through unchanged. 'linear' double-encodes and goes dark.")
    ap.add_argument("--depth-preview", default=os.path.join(ROOT, "assets", "depth.png"))
    args = ap.parse_args()

    if not os.path.exists(MODEL):
        print(f"missing model: {MODEL}", file=sys.stderr)
        return 1

    image = Image.open(args.image).convert("RGB")
    W, H = image.size
    print(f"image   {args.image}  {W}x{H}")

    rgb_full = np.asarray(image, np.float32)
    if args.strip_overlay:
        mask = find_overlay_mask(rgb_full.astype(np.uint8), 0.52, 200, 30)
        frac = mask.mean()
        print(f"overlay {frac * 100:.2f}% of pixels flagged, inpainting")
        rgb_clean = cv2.inpaint(rgb_full.astype(np.uint8), mask, 7,
                                cv2.INPAINT_TELEA).astype(np.float32)
        Image.fromarray(rgb_clean.astype(np.uint8)).save(
            os.path.join(ROOT, "assets", "scene_clean.png"))
    else:
        rgb_clean = rgb_full

    disp = depth_anything(Image.fromarray(rgb_clean.astype(np.uint8)), args.side)
    if args.strip_overlay:
        disp = cv2.inpaint(disp, mask, 21, cv2.INPAINT_NS)
    depth = disparity_to_depth(disp, args.z_near, args.z_far, 2.0, 98.0)
    print(f"depth   near={depth.min():.2f}m  median={np.median(depth):.2f}m  far={depth.max():.2f}m")

    points, fx = unproject(depth, args.fov)

    rgb = rgb_clean.reshape(-1, 3) / 255.0
    if args.colorspace == "linear":
        rgb = srgb_to_linear(rgb)

    # Subsample on a regular stride so splats stay evenly spaced.
    s = args.stride
    sel = np.zeros((H, W), bool)
    sel[::s, ::s] = True
    keep = sel.reshape(-1)

    p = points[keep]
    n = np.zeros((len(p), 3), dtype=np.float32)
    n[:, 2] = -1.0
    c = rgb[keep]

    # Gaussian footprint. A 3DGS gaussian is drawn out to ~3 sigma, so sigma must
    # be roughly half the centre spacing or every splat smears over its
    # neighbours and the whole scene turns to mush.
    z = np.maximum(-p[:, 2], 1e-3)
    footprint = (z / fx) * s * args.overlap
    scales = np.stack([footprint, footprint, footprint * args.thin], axis=1)
    scales = np.log(np.maximum(scales, 1e-7)).astype(np.float32)

    quats = np.zeros((len(p), 4), dtype=np.float32)
    quats[:, 1] = 1.0  # 180° about X: local +Z faces the camera at -Z.
    f_dc = ((c - 0.5) / SH_C0).astype(np.float32)

    op = float(args.opacity)
    opacity = np.full((len(p), 1), np.log(op / (1 - op)), np.float32)

    extent = np.ptp(p, axis=0)
    print(f"scene   {len(p):,} splats   extent={extent.round(2)}")

    write_ply(args.out, p, n, f_dc, opacity, scales, quats)

    vfov = float(np.rad2deg(2 * np.arctan(np.tan(np.deg2rad(args.fov) / 2) / (W / H))))
    meta = {
        "hfov": args.fov,
        "vfov": vfov,
        "aspect": W / H,
        "zNear": args.z_far,          # furthest splat
        "zFar": max(args.z_far * 4, 100.0),
        "splats": int(len(p)),
        "source": os.path.basename(args.image),
    }
    meta_path = os.path.splitext(args.out)[0] + ".json"
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
    print(f"wrote   {meta_path}")

    if args.depth_preview:
        vis = cv2.applyColorMap(
            (np.clip(depth, args.z_near, args.z_far) / args.z_far * 255).astype(np.uint8),
            cv2.COLORMAP_TURBO)
        Image.fromarray(cv2.cvtColor(vis, cv2.COLOR_BGR2RGB)).save(args.depth_preview)
        print(f"wrote   {args.depth_preview}")
    print(f"wrote   {args.out}  ({os.path.getsize(args.out) / 1e6:.1f} MB)")
    return 0


def write_ply(path: str, p, n, f_dc, opacity, scales, quats) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    count = len(p)
    header = (
        "ply\n"
        "format binary_little_endian 1.0\n"
        f"element vertex {count}\n"
        "property float x\nproperty float y\nproperty float z\n"
        "property float nx\nproperty float ny\nproperty float nz\n"
        "property float f_dc_0\nproperty float f_dc_1\nproperty float f_dc_2\n"
        "property float opacity\n"
        "property float scale_0\nproperty float scale_1\nproperty float scale_2\n"
        "property float rot_0\nproperty float rot_1\nproperty float rot_2\nproperty float rot_3\n"
        "end_header\n"
    )
    with open(path, "wb") as f:
        f.write(header.encode())
        # PLY binary payloads store each vertex's properties together, in header order.
        vertices = np.concatenate((p, n, f_dc, opacity, scales, quats), axis=1).astype(
            "<f4", copy=False
        )
        vertices.tofile(f)


if __name__ == "__main__":
    raise SystemExit(main())