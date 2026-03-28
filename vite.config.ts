import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  base: "./",
  build: {
    outDir: "packages/site-gmail/dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, "packages/site-gmail/src/background.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name].js",
        assetFileNames: "assets/[name].[ext]",
      },
    },
    target: "es2022",
    minify: false,
    sourcemap: true,
  },
  resolve: {
    alias: {
      "@core": resolve(__dirname, "packages/core"),
      "@gmail": resolve(__dirname, "packages/site-gmail/src"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    coverage: {
      include: ["packages/**/*.ts"],
      exclude: ["**/__tests__/**"],
    },
  },
});
