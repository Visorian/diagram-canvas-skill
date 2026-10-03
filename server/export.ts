// `canvas.js export`: the canvas page with the diagrams embedded, which makes it a read-only viewer
// that works as a single file, e.g. on GitHub Pages.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { partNames, toDiagramFiles, type PartSuffix } from "../src/diagram/format.ts";
import { renderSvg } from "./svg.ts";

const suffixes: PartSuffix[] = [".txt", ".layout.json", ".notes.md", ".marks"];

async function readDiagrams(dir: string) {
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
  return { names, diagrams };
}

export async function exportSvg(dir: string, name?: string, against?: string) {
  const { diagrams } = await readDiagrams(dir);
  const current = name ? diagrams.find((diagram) => diagram.name === name) : diagrams[0];
  if (!name && diagrams.length > 1)
    throw new Error("SVG export needs --diagram when there are multiple diagrams.");
  if (!current) throw new Error(`No diagram found${name ? `: ${name}` : ""}.`);
  const base = against ? diagrams.find((diagram) => diagram.name === against) : undefined;
  if (against && !base) throw new Error(`No comparison diagram found: ${against}.`);
  return renderSvg(current, base);
}

export async function exportPage(page: string, dir: string) {
  const { names, diagrams } = await readDiagrams(dir);
  // With `<` escaped, no diagram text can end the script element early.
  const data = JSON.stringify(diagrams).replaceAll("<", "\\u003c");
  const script = `<script type="application/json" id="diagram-data">${data}</script>`;
  // The first `<head>` is the page's own; the inlined code comes after it.
  return { html: page.replace("<head>", () => `<head>${script}`), names };
}
