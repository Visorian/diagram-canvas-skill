// Bun macro, run while bundling canvas.js: inlines the built page brotli-compressed as base64,
// which is about a third of its size.
import { readFileSync } from "node:fs";
import { brotliCompressSync } from "node:zlib";

export const compressedHtml = () =>
  brotliCompressSync(readFileSync(new URL("../dist/app/index.html", import.meta.url))).toString(
    "base64",
  );
