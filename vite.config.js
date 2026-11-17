import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import { execFileSync } from "node:child_process";
const host = process.env.TAURI_DEV_HOST;

/** Short commit hash for Help > About; "unknown" outside a git checkout or without git. */
function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

// https://vite.dev/config/
export default defineConfig(() => ({
  // Plain Svelte single-page app: index.html loads src/main.ts; `vite build` writes dist/, which Tauri bundles.
  // Svelte options (preprocess) are in svelte.config.js, which svelte-check also reads.
  plugins: [svelte()],
  // The bundle is read from inside the exe, not downloaded, so a ~600 kB main chunk (CodeMirror + markdown-it) is fine.
  build: { chunkSizeWarningLimit: 1024 },

  // Build stamps read by src/lib/buildInfo.ts.
  define: {
    __CIRTH_COMMIT__: JSON.stringify(gitCommit()),
    __CIRTH_BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
