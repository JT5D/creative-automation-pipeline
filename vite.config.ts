import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const API = "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The UI reads real files straight off disk through the API server.
    proxy: { "/api": API, "/outputs": API },
  },
  build: { outDir: "dist" },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Several tests render full campaigns (dozens of 2K composites).
    testTimeout: 60_000,
  },
});
