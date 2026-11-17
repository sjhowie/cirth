import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
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
  // SvelteKit 3 takes its config here (svelte.config.js is no longer read).
  // Tauri has no Node.js server for SSR, so adapter-static with an index.html fallback runs the app as an SPA:
  // https://svelte.dev/docs/kit/single-page-apps and https://v2.tauri.app/start/frontend/sveltekit/
  plugins: [
    sveltekit({
      preprocess: vitePreprocess(),
      adapter: adapter({ fallback: "index.html" }),
      // Kit 3 polls for a new deployment hourly by default; the app ships inside the exe and updates through the Tauri updater.
      version: { pollInterval: 0 },
    }),
  ],

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
