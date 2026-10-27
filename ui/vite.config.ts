import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

// Relative base so the same build works when served over HTTP and when
// loaded from local assets inside the Android WebView shell.
export default defineConfig({
  base: "./",
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
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
