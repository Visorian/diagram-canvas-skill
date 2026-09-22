import vue from "@vitejs/plugin-vue";
import unoCSS from "unocss/vite";
import { defineConfig } from "vite";

// `--mode vdom` builds the same app without Vapor for comparison.
export default defineConfig(({ mode }) => ({
  plugins: [unoCSS(), vue({ features: { vapor: mode !== "vdom" } })],
}));
