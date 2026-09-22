import vue from "@vitejs/plugin-vue";
import unoCSS from "unocss/vite";
import { defineConfig } from "vite";
import { diagramsPlugin } from "./server/diagrams.ts";

// `--mode vapor` compiles SFCs in Vapor mode for comparison.
export default defineConfig(({ mode }) => ({
  plugins: [unoCSS(), vue({ features: { vapor: mode === "vapor" } }), diagramsPlugin()],
  // elkjs alone is ~1.4 MB; fine for a local tool.
  build: { chunkSizeWarningLimit: 2000 },
}));
