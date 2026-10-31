/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: { port: 9245, strictPort: true },
  // The bundle is loaded from disk inside the desktop app, not over a network;
  // heavy editors (Monaco) are split out with dynamic import() when added.
  build: { target: "es2022", chunkSizeWarningLimit: 1024 },
  // Unit tests (npm test): plain modules in Node, no browser. The app as a
  // whole is tested end to end with Playwright (e2e/).
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
