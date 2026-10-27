import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Relative base so the same build works when served over HTTP and when
// loaded from local assets inside the Android WebView shell.
export default defineConfig({
  base: "./",
  plugins: [react()],
});
