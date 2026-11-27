import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * The UI version sent as `hello.clientVersion` (docs/13 §6.1, T12.3): env
 * `UI_VERSION` (`X.Y` or `X.Y.Z`, e.g. set by a release build), else the base
 * `X.Y` from the repo-root `VERSION` file, the only source of `X.Y`. A missing
 * or malformed source gives "0.0.0-dev", which the Core never compares.
 */
function uiVersion(): string {
  const valid = (v: string | undefined) => (v !== undefined && /^\d+\.\d+(?:\.\d+)?$/.test(v) ? v : undefined);
  const fromEnv = valid(process.env.UI_VERSION?.trim());
  if (fromEnv) return fromEnv;
  try {
    const first = readFileSync(new URL("../VERSION", import.meta.url), "utf8").split(/\r?\n/, 1)[0]?.trim();
    return valid(first) ?? "0.0.0-dev";
  } catch {
    return "0.0.0-dev";
  }
}

// Relative base so the same build works when served over HTTP and when
// loaded from local assets inside the Android WebView shell.
export default defineConfig({
  base: "./",
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(uiVersion()),
  },
  build: {
    // The three.js chunk (~190 kB gzip) is loaded lazily with the 3D scene;
    // the initial app chunk stays far below this.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        // three.js in its own long-cacheable chunk, separate from app code.
        manualChunks(id) {
          if (id.includes("node_modules/three/")) return "three";
          return undefined;
        },
      },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
