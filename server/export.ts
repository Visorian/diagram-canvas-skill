// `canvas.js export`: the canvas page with the diagrams embedded, which makes it a read-only viewer
// that works as a single file, e.g. on GitHub Pages.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { partNames, toDiagramFiles, type PartSuffix } from "../src/diagram/format.ts";

const suffixes: PartSuffix[] = [".txt", ".layout.json", ".notes.md", ".marks"];

export async function exportPage(page: string, dir: string) {
  const names = partNames(await readdir(dir).catch(() => []), ".txt").toSorted();
  const diagrams = await Promise.all(
    names.map(async (name) => {
      const parts = await Promise.all(
        suffixes.map(async (suffix) => {
          const content = await readFile(join(dir, `${name}${suffix}`), "utf8").catch(
            () => undefined,
          );
          return [suffix, content] as const;
        }),
      );
      return toDiagramFiles(name, Object.fromEntries(parts));
    }),
  );
  // With `<` escaped, no diagram text can end the script element early.
  const data = JSON.stringify(diagrams).replaceAll("<", "\\u003c");
  const script = `<script type="application/json" id="diagram-data">${data}</script>`;
  // The first `<head>` is the page's own; the inlined code comes after it.
  return { html: page.replace("<head>", () => `<head>${script}`), names };
}
