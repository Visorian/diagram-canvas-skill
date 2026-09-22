import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { text } from "node:stream/consumers";
import type { Plugin } from "vite";
import {
  applyOps,
  isLayout,
  isOps,
  type DiagramFiles,
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
  return entries.length === 0 ? undefined : `{\n${entries.join(",\n")}\n}\n`;
}

// Serves and edits `diagrams/<name>.txt` (model) and `diagrams/<name>.layout.json` (pinned positions).
export function diagramsPlugin(dir = "diagrams"): Plugin {
  const root = resolve(dir);
  const sourcePath = (name: string) => join(root, `${name}.txt`);
  const layoutPath = (name: string) => join(root, `${name}.layout.json`);

  const list = async () => {
    await mkdir(root, { recursive: true });
    const files = await readdir(root);
    return files.filter((file) => file.endsWith(".txt")).map((file) => basename(file, ".txt"));
  };

  const load = async (name: string): Promise<DiagramFiles> => {
    const layout: unknown = JSON.parse((await readOptional(layoutPath(name))) ?? "{}");
    return {
      name,
      source: (await readOptional(sourcePath(name))) ?? "",
      layout: isLayout(layout) ? layout : {},
    };
  };

  const save = async (name: string, ops: Op[]) => {
    const current = await load(name);
    const next = applyOps(current.source, current.layout, ops);
    if (next.source !== current.source) await writeFile(sourcePath(name), next.source);
    const layout = serializeLayout(next.layout);
    if (layout !== serializeLayout(current.layout)) {
      if (layout === undefined) await rm(layoutPath(name), { force: true });
      else await writeFile(layoutPath(name), layout);
    }
    return { name, ...next };
  };

  return {
    name: "diagrams",
    apply: "serve",
    configureServer(server) {
      server.watcher.add(root);
      const notify = async (file: string) => {
        if (!file.startsWith(root)) return;
        const name = basename(file).replace(/(\.layout\.json|\.txt)$/, "");
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
