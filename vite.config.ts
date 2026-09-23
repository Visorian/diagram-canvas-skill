import vue from "@vitejs/plugin-vue";
import unoCSS from "unocss/vite";
import { defineConfig, type Plugin } from "vite";
import { diagramsPlugin } from "./server/diagrams.ts";

// Inlines the built JS and CSS into index.html, so each build is a single file.
function singleFile(): Plugin {
  return {
    name: "single-file",
    apply: "build",
    enforce: "post",
    generateBundle(_, bundle) {
      const page = bundle["index.html"];
      if (page?.type !== "asset") return;
      let html = String(page.source);
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type === "chunk") {
          // A literal `</script` inside the code would end the inline script early.
          const code = output.code.replaceAll("</script", String.raw`<\/script`);
          html = html.replace(
            new RegExp(`<script[^>]*src="[^"]*${fileName}"[^>]*></script>`),
            () => `<script type="module">${code}</script>`,
          );
        } else if (fileName.endsWith(".css")) {
          html = html.replace(
            new RegExp(`<link[^>]*href="[^"]*${fileName}"[^>]*>`),
            () => `<style>${String(output.source)}</style>`,
          );
        } else continue;
        delete bundle[fileName];
      }
      page.source = html;
    },
  };
}

// `--mode viewer` builds the read-only viewer; `--mode vapor` compiles SFCs in Vapor mode.
export default defineConfig(({ mode }) => ({
  plugins: [
    unoCSS(),
    vue({ features: { vapor: mode === "vapor" } }),
    diagramsPlugin(),
    singleFile(),
  ],
  // Everything ends up inline in one file anyway.
  build: { chunkSizeWarningLimit: 4000, assetsInlineLimit: Number.POSITIVE_INFINITY },
}));
