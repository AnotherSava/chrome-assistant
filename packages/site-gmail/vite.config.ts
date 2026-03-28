import { defineConfig } from "vite";
import { resolve } from "path";
import { baseConfig } from "../../vite.config.base.js";

const siteDir = import.meta.dirname!;
const base = baseConfig(siteDir, resolve(siteDir, "../../assets/extension/gmail"));

export default defineConfig({
  ...base,
  build: {
    ...base.build,
    rollupOptions: {
      ...base.build!.rollupOptions,
      input: {
        background: resolve(siteDir, "src/background.ts"),
        sidepanel: resolve(siteDir, "sidepanel.html"),
      },
    },
  },
});
