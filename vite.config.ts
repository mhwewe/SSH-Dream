// vite.config.ts — Tauri expects a fixed dev port (must match devUrl in src-tauri/tauri.conf.json).
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // IMPORTANT: do not let Vite watch the Rust folder. `cargo` constantly creates/locks files in
    // src-tauri/target (build scripts, .exe files) and on Windows Vite's file watcher crashes with
    // "EBUSY: resource busy or locked, watch ...build_script_build-....exe", which kills `npm run tauri dev`.
    // Tauri itself already watches src-tauri and rebuilds Rust when it changes.
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
