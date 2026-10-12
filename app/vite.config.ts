import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";
// Vite 8 (Rolldown) handles top-level await natively with an esnext target.
export default defineConfig({
  base: "./",
  plugins: [wasm()],
  build: { target: "esnext", chunkSizeWarningLimit: 4000 },
  esbuild: { target: "esnext" },
  optimizeDeps: { exclude: ["@tari-project/ootle-wasm"], esbuildOptions: { target: "esnext" } },
  test: { testTimeout: 60000, pool: "forks", poolOptions: { forks: { singleFork: true } } },
} as any);
