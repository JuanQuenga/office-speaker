import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The window is a static bundle loaded from disk by Electron.
export default defineConfig({
  root: resolve(import.meta.dirname, "renderer"),
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": resolve(import.meta.dirname, "renderer/src") },
  },
  build: {
    outDir: resolve(import.meta.dirname, "dist-renderer"),
    emptyOutDir: true,
    target: "chrome140",
  },
});
