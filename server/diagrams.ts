import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { text } from "node:stream/consumers";
import type { Plugin } from "vite";
import {
  applyOps,
  isLayout,
  isOps,
  type DiagramFiles,
  type DiagramState,
  type Layout,
  type Op,
} from "../src/diagram/format.ts";

const namePattern = /^[\w-]+$/;

async function readOptional(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

// One entry per line keeps layout diffs small.
function serializeLayout(layout: Layout) {
  const entries = Object.entries(layout).map(
    ([id, [x, y]]) => `  ${JSON.stringify(id)}: [${x}, ${y}]`,
  );
  return entries.length === 0 ? "" : `{\n${entries.join(",\n")}\n}\n`;
}

const serializeMarks = (marks: string[]) => marks.map((mark) => `${mark}\n`).join("");

// File per part of a diagram; an empty part has no file.
const parts: { suffix: string; serialize: (state: DiagramState) => string }[] = [
  { suffix: ".txt", serialize: (state) => state.source },
  { suffix: ".layout.json", serialize: (state) => serializeLayout(state.layout) },
  { suffix: ".notes.md", serialize: (state) => state.notes },
  { suffix: ".marks", serialize: (state) => serializeMarks(state.marks) },
];
const partSuffix = /(\.txt|\.layout\.json|\.notes\.md|\.marks)$/;

// Serves and edits `diagrams/<name>.*`: model, pinned positions, notes and marks.
export function diagramsPlugin(dir = "diagrams"): Plugin {
  const root = resolve(dir);
  const path = (name: string, suffix: string) => join(root, `${name}${suffix}`);

  const list = async () => {
    await mkdir(root, { recursive: true });
    const files = await readdir(root);
    return files
      .filter((file) => file.endsWith(".txt"))
      .map((file) => basename(file, ".txt"))
      .filter((name) => namePattern.test(name));
  };

  const load = async (name: string): Promise<DiagramFiles> => {
    const layout: unknown = JSON.parse((await readOptional(path(name, ".layout.json"))) ?? "{}");
    const marks = (await readOptional(path(name, ".marks"))) ?? "";
    return {
      name,
      source: (await readOptional(path(name, ".txt"))) ?? "",
      layout: isLayout(layout) ? layout : {},
      notes: (await readOptional(path(name, ".notes.md"))) ?? "",
      marks: marks.split("\n").filter((mark) => mark.trim() !== ""),
    };
  };

  const save = async (name: string, ops: Op[]) => {
    const current = await load(name);
    const next = applyOps(current, ops);
    await Promise.all(
      parts.map(async ({ suffix, serialize }) => {
        const content = serialize(next);
        if (content === serialize(current)) return;
        if (content === "" && suffix !== ".txt") await rm(path(name, suffix), { force: true });
        else await writeFile(path(name, suffix), content);
      }),
    );
    return { name, ...next };
  };

  return {
    name: "diagrams",
    apply: "serve",
    configureServer(server) {
      server.watcher.add(root);
      const notify = async (file: string) => {
        if (!file.startsWith(root)) return;
        const name = basename(file).replace(partSuffix, "");
        if (!namePattern.test(name)) return;
        server.ws.send("diagrams:change", { names: await list(), diagram: await load(name) });
      };
      for (const event of ["add", "change", "unlink"]) {
        server.watcher.on(event, (file: string) => void notify(file));
      }

      server.middlewares.use("/__diagrams", (request, response, next) => {
        const name = decodeURIComponent(request.url?.slice(1) ?? "");
        const send = (body: unknown) => {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify(body));
        };
        const handle = async () => {
          if (name === "") return send(await list());
          if (!namePattern.test(name)) {
            response.statusCode = 400;
            return send({ error: "invalid diagram name" });
          }
          if (request.method === "POST") {
            const ops: unknown = JSON.parse(await text(request));
            if (isOps(ops)) return send(await save(name, ops));
            response.statusCode = 400;
            return send({ error: "invalid ops" });
          }
          return send(await load(name));
        };
        handle().catch(next);
      });
    },
  };
}
