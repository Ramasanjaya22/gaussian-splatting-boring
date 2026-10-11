import { defineConfig } from "vite";

// Deploy target lives under a subpath (rmsjya.pages.dev/boring), so the
// build bakes that in:  PAGES_BASE=/boring/ pnpm build
// Local dev keeps root base and is unaffected.
export default defineConfig({
  base: process.env.PAGES_BASE || "/",
  server: { host: "127.0.0.1", port: 5173 },
  build: { target: "esnext" },
  // MediaPipe ships prebuilt wasm glue; pre-bundling breaks its dynamic loading.
  optimizeDeps: { exclude: ["@mediapipe/tasks-vision"] },
});