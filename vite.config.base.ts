import { resolve } from "path";
import { cpSync, existsSync } from "fs";
import type { UserConfig, Plugin } from "vite";

const root = resolve(import.meta.dirname!);

export function copyIcons(iconDir: string, outDir: string): Plugin {
  return {
    name: "copy-icons",
    writeBundle() {
      if (existsSync(iconDir)) {
        cpSync(iconDir, resolve(outDir, "icons"), { recursive: true });
      }
    },
  };
}

export function baseConfig(siteDir: string, iconDir: string): UserConfig {
  const outDir = resolve(siteDir, "dist");
  return {
    root: siteDir,
    base: "./",
    build: {
      outDir,
      emptyOutDir: true,
      rollupOptions: {
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
    plugins: [copyIcons(iconDir, outDir)],
    resolve: {
      alias: {
        "@core": resolve(root, "packages/core/src"),
      },
    },
  };
}
