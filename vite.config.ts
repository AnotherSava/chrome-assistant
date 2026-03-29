import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@core": resolve(import.meta.dirname, "packages/core"),
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
