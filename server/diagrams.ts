import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { text } from "node:stream/consumers";
import type { Plugin } from "vite";
import {
  applyOps,
  isOps,
  partNames,
  partPattern,
  toDiagramFiles,
  type DiagramState,
  type Layout,
  type Op,
  type PartSuffix,
} from "../src/diagram/format.ts";
import { isRef, listVersions, readVersion } from "./versions.ts";

const namePattern = /^[\w-]+$/;

const hostName = (host: string) => {
  try {
    return new URL(`http://${host}`).hostname.replace(/^\[(.*)\]$/, "$1");
  } catch {
    return undefined;
  }
};

// Like Vite's `server.allowedHosts`: loopback names and IP addresses always pass, since DNS rebinding
// needs a domain, and `.example.com` also allows its subdomains. Requests sent by a page must come
// from the canvas itself or an allowed host behind a proxy, so other sites can't use the canvas.
export function isAllowedRequest(request: IncomingMessage, allowedHosts: readonly string[] | true) {
  const listed = (name: string) =>
    allowedHosts !== true &&
    allowedHosts.some((allowed) =>
      allowed.startsWith(".") ? `.${name}`.endsWith(allowed) : name === allowed,
    );
  const { host, origin } = request.headers;
  const name = host ? hostName(host) : undefined;
  if (!name) return false;
  const hostAllowed =
    allowedHosts === true ||
    isIP(name) !== 0 ||
    name === "localhost" ||
    name.endsWith(".localhost") ||
    listed(name);
  if (!hostAllowed) return false;
  if (origin === undefined) return true;
  try {
    const url = new URL(origin);
    return url.host === host || listed(url.hostname);
  } catch {
    return false;
  }
}

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
  // A pending handoff keeps its file even without a message.
  {
    suffix: ".handoff",
    serialize: (state) => (state.handoff === undefined ? "" : `${state.handoff}\n`),
  },
];

// Reads and edits `<dir>/<name>.*` and streams changes to connected canvases.
export function createDiagramsService(dir: string, allowedHosts: readonly string[] | true = []) {
  const root = resolve(dir);
  const reject = (request: IncomingMessage, response: ServerResponse) => {
    if (isAllowedRequest(request, allowedHosts)) return false;
    response.statusCode = 403;
    response.end();
    return true;
  };
  const path = (name: string, suffix: PartSuffix) => join(root, `${name}${suffix}`);
  const clients = new Set<ServerResponse>();
  let watcher: FSWatcher | undefined;
  // A save's response can arrive after the event for a newer file change, e.g. when the agent
  // takes a handoff right away. Versions let the canvas keep the newest state. They start from
  // the clock, so they keep increasing across restarts.
  let version = 0;
  const nextVersion = () => (version = Math.max(version + 1, Date.now()));

  const list = async () => {
    await mkdir(root, { recursive: true });
    return partNames(await readdir(root), ".txt");
  };

  // Stamped before reading, so the load that starts last wins.
  const load = async (name: string) => {
    const stamp = nextVersion();
    const contents = await Promise.all(
      parts.map(async ({ suffix }) => [suffix, await readOptional(path(name, suffix))] as const),
    );
    return { ...toDiagramFiles(name, Object.fromEntries(contents)), version: stamp };
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
    return { name, ...next, version: nextVersion() };
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
      if (reject(request, response)) return;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write(": connected\n\n");
      clients.add(response);
      request.on("close", () => clients.delete(response));
    },

    // `GET /` lists diagrams, `GET /<name>` loads one, `POST /<name>` applies ops. From the git
    // history, `GET /<name>/versions` lists earlier versions and `GET /<name>/at/<ref>` loads one.
    async api(request: IncomingMessage, response: ServerResponse, url: string) {
      if (reject(request, response)) return;
      const [name = "", action, ref] = (url.split("?")[0] ?? "")
        .replace(/^\//, "")
        .split("/")
        .map(decodeURIComponent);
      const send = (status: number, body: unknown) => {
        response.statusCode = status;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(body));
      };
      if (name === "") return send(200, await list());
      if (!namePattern.test(name)) return send(400, { error: "invalid diagram name" });
      if (action === "versions") return send(200, await listVersions(root, name));
      if (action === "at") {
        if (ref === undefined || !isRef(ref)) return send(400, { error: "invalid version" });
        return send(200, await readVersion(root, name, ref));
      }
      if (action !== undefined) return send(404, { error: "not found" });
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
      const service = createDiagramsService(dir, server.config.server.allowedHosts);
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
