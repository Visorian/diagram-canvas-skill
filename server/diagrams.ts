import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { text } from "node:stream/consumers";
import type { Plugin } from "vite";
import {
  applyOps,
  isOps,
  partPattern,
  toDiagramFiles,
  type DiagramState,
  type Layout,
  type Op,
  type PartSuffix,
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
const parts: { suffix: PartSuffix; serialize: (state: DiagramState) => string }[] = [
  { suffix: ".txt", serialize: (state) => state.source },
  { suffix: ".layout.json", serialize: (state) => serializeLayout(state.layout) },
  { suffix: ".notes.md", serialize: (state) => state.notes },
  { suffix: ".marks", serialize: (state) => serializeMarks(state.marks) },
];

// Reads and edits `<dir>/<name>.*` and streams changes to connected canvases.
export function createDiagramsService(dir: string) {
  const root = resolve(dir);
  const path = (name: string, suffix: PartSuffix) => join(root, `${name}${suffix}`);
  const clients = new Set<ServerResponse>();
  let watcher: FSWatcher | undefined;

  const list = async () => {
    await mkdir(root, { recursive: true });
    return (await readdir(root)).flatMap((file) => {
      const match = partPattern.exec(file);
      return match?.[1] && match[2] === ".txt" ? [match[1]] : [];
    });
  };

  const load = async (name: string) => {
    const contents = await Promise.all(
      parts.map(async ({ suffix }) => [suffix, await readOptional(path(name, suffix))] as const),
    );
    return toDiagramFiles(name, Object.fromEntries(contents));
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

  const broadcast = async (name: string) => {
    if (clients.size === 0) return;
    const event = JSON.stringify({ names: await list(), diagram: await load(name) });
    for (const client of clients) client.write(`data: ${event}\n\n`);
  };

  const startWatching = async () => {
    await mkdir(root, { recursive: true });
    watcher = watch(root, (_event, file) => {
      const name = file ? partPattern.exec(file)?.[1] : undefined;
      if (name) void broadcast(name);
    });
  };
  void startWatching();

  return {
    root,
    close: () => watcher?.close(),

    // Server-sent events carrying `{ names, diagram }` after every file change.
    events(request: IncomingMessage, response: ServerResponse) {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write(": connected\n\n");
      clients.add(response);
      request.on("close", () => clients.delete(response));
    },

    // `GET /` lists diagrams, `GET /<name>` loads one, `POST /<name>` applies ops.
    async api(request: IncomingMessage, response: ServerResponse, url: string) {
      const name = decodeURIComponent(url.split("?")[0]?.replace(/^\//, "") ?? "");
      const send = (status: number, body: unknown) => {
        response.statusCode = status;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(body));
      };
      if (name === "") return send(200, await list());
      if (!namePattern.test(name)) return send(400, { error: "invalid diagram name" });
      if (request.method !== "POST") return send(200, await load(name));
      const ops: unknown = JSON.parse(await text(request));
      return isOps(ops) ? send(200, await save(name, ops)) : send(400, { error: "invalid ops" });
    },
  };
}

export function diagramsPlugin(dir = "diagrams"): Plugin {
  return {
    name: "diagrams",
    apply: "serve",
    configureServer(server) {
      const service = createDiagramsService(dir);
      server.httpServer?.once("close", service.close);
      server.middlewares.use("/__events", (request, response) => {
        service.events(request, response);
      });
      server.middlewares.use("/__diagrams", (request, response, next) => {
        service.api(request, response, request.url ?? "/").catch(next);
      });
    },
  };
}
