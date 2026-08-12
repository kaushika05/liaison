import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@shared": new URL("./src/shared", import.meta.url).pathname } },
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:3000", "/health": "http://localhost:3000", "/ready": "http://localhost:3000" } },
});
