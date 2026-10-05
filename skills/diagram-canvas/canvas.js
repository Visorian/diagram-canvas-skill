// server/canvas.ts
import { mkdir as mkdir4, writeFile as writeFile3 } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve as resolve3 } from "node:path";
import { parseArgs } from "node:util";
import { brotliDecompressSync } from "node:zlib";

// server/diagrams.ts
import { watch } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { text } from "node:stream/consumers";

// src/diagram/notes.ts
var answerPattern = /^\s*→\s*(.+)$/;
var notePattern = /^- (?:\[([ x])\] (?:(>user) )?(?:#([\w-]+) )?)?(?:@([\w-]+(?:->[\w-]+(?:#\d+)?)?) )?(.+)$/;
function parseLine(text) {
  const match = notePattern.exec(text.trim());
  const [, box, forUser, tag, target, body] = match ?? [];
  if (!body)
    return { type: "other", text };
  const note = {
    kind: box === undefined ? "note" : "question",
    text: body,
    done: box === "x"
  };
  if (tag)
    note.tag = tag;
  if (target)
    note.target = target;
  if (forUser && note.kind === "question")
    note.forUser = true;
  return { type: "note", note };
}
function serializeLine(line) {
  if (line.type === "other")
    return line.text;
  const { kind, target, tag, forUser, text, answer, done } = line.note;
  const box = kind === "question" ? `[${done ? "x" : " "}] ${forUser ? ">user " : ""}` : "";
  const answerLine = answer ? `
  → ${answer}` : "";
  return `- ${box}${tag ? `#${tag} ` : ""}${target ? `@${target} ` : ""}${text}${answerLine}`;
}
function parseLines(source) {
  const lines = [];
  for (const text of source === "" ? [] : source.replace(/\n$/, "").split(`
`)) {
    const previous = lines.at(-1);
    const answer = answerPattern.exec(text)?.[1]?.trim();
    if (answer && previous?.type === "note" && previous.note.kind === "question" && previous.note.answer === undefined) {
      previous.note.answer = answer;
      continue;
    }
    lines.push(parseLine(text));
  }
  return lines;
}
var sameNote = (a, b) => a.kind === b.kind && a.target === b.target && a.tag === b.tag && Boolean(a.forUser) === Boolean(b.forUser) && a.text === b.text;
var parseNotes = (source) => parseLines(source).flatMap((line) => line.type === "note" ? [line.note] : []);
function applyNoteOp(source, op) {
  let lines = parseLines(source);
  if (op.type === "add-note") {
    lines.push({ type: "note", note: op.note });
  } else if (op.type === "remove-note") {
    lines = lines.filter((line) => !(line.type === "note" && sameNote(line.note, op.note)));
  } else {
    lines = lines.map((line) => line.type === "note" && sameNote(line.note, op.note) ? { type: "note", note: op.next } : line);
  }
  return lines.length === 0 ? "" : `${lines.map(serializeLine).join(`
`)}
`;
}

// src/diagram/format.ts
var kinds = ["service", "db", "queue", "ext", "ui"];
var layoutKinds = ["flow", "architecture", "sequence"];
var partPattern = /^([\w-]+)(\.txt|\.layout\.json|\.notes\.md|\.marks|\.handoff)$/;
var partNames = (files, suffix) => files.flatMap((file) => {
  const match = partPattern.exec(file);
  return match?.[1] && match[2] === suffix ? [match[1]] : [];
});
var idPattern = String.raw`[\w-]+`;
var edgePattern = new RegExp(String.raw`^(${idPattern})\s*(->|=>)\s*(${idPattern})\s*(?::\s*(.*))?$`);
var nodePattern = new RegExp(String.raw`^(${idPattern})\s*:\s*(.*?)\s*(?:\[(\w+)\])?$`);
var groupPattern = new RegExp(String.raw`^\[\s*(${idPattern})\s*(?::\s*(.*?))?\s*\]$`);
var outerGroupPattern = new RegExp(String.raw`^\[\[\s*(${idPattern})\s*(?::\s*(.*?))?\s*\]\]$`);
var tagPattern = /^# tag: ([\w-]+) (#[\da-fA-F]{6})$/;
var layoutPattern = new RegExp(`^# layout: (${layoutKinds.join("|")})$`);
var edgeId = ({
  source,
  target,
  ordinal
}) => `${source}->${target}${ordinal !== undefined && ordinal > 1 ? `#${ordinal}` : ""}`;
var nodeStatement = ({ id, label, kind }) => `${id}: ${label}${kind === "service" ? "" : ` [${kind}]`}`;
var edgeStatement = ({ source, target, label, animated }) => `${source} ${animated ? "=>" : "->"} ${target}${label ? `: ${label}` : ""}`;
function isKind(value) {
  return kinds.includes(value);
}
function parseLine2(text, lineNumber, errors) {
  const trimmed = text.trim();
  if (trimmed.startsWith("# tag:") && !tagPattern.test(trimmed)) {
    errors.push(`line ${lineNumber}: invalid tag definition`);
  }
  if (trimmed.startsWith("# layout:") && !layoutPattern.test(trimmed)) {
    errors.push(`line ${lineNumber}: unknown layout, use flow, architecture or sequence`);
  }
  if (trimmed === "" || trimmed.startsWith("#"))
    return { type: "other", text };
  const edge = edgePattern.exec(trimmed);
  if (edge?.[1] && edge[3]) {
    const [, source, arrow, target, label = ""] = edge;
    return {
      type: "edge",
      edge: { source, target, label, ...arrow === "=>" && { animated: true } }
    };
  }
  const outer = outerGroupPattern.exec(trimmed);
  if (outer?.[1]) {
    return { type: "group", group: { id: outer[1], label: outer[2] || outer[1], outer: true } };
  }
  const group = groupPattern.exec(trimmed);
  if (group?.[1])
    return { type: "group", group: { id: group[1], label: group[2] || group[1] } };
  const node = nodePattern.exec(trimmed);
  if (node?.[1]) {
    const kind = node[3] ?? "service";
    if (!isKind(kind))
      errors.push(`line ${lineNumber}: unknown kind "${kind}"`);
    const label = node[2] || node[1];
    return { type: "node", node: { id: node[1], label, kind: isKind(kind) ? kind : "service" } };
  }
  errors.push(`line ${lineNumber}: cannot parse "${trimmed}"`);
  return { type: "other", text };
}
function parseLines2(source, errors = []) {
  return source.replace(/\n$/, "").split(`
`).map((text, index) => parseLine2(text, index + 1, errors));
}
function serializeLine2(line) {
  if (line.type === "other")
    return line.text;
  if (line.type === "edge")
    return edgeStatement(line.edge);
  if (line.type === "node")
    return nodeStatement(line.node);
  const { id, label, outer } = line.group;
  const inside = label === id ? id : `${id}: ${label}`;
  return outer ? `[[${inside}]]` : `[${inside}]`;
}
function parseDiagram(source) {
  const errors = [];
  const nodes = new Map;
  const edges = new Map;
  const groups = new Map;
  const tags = new Map;
  const parallels = new Map;
  let layout = "flow";
  let outer;
  let group;
  for (const line of parseLines2(source, errors)) {
    if (line.type === "group") {
      const { id } = line.group;
      if (groups.has(id))
        errors.push(`duplicate group "${id}"`);
      if (line.group.outer)
        outer = id;
      groups.set(id, line.group.outer || outer === undefined ? line.group : { ...line.group, parent: outer });
      group = id;
    } else if (line.type === "node") {
      if (nodes.has(line.node.id))
        errors.push(`duplicate node "${line.node.id}"`);
      nodes.set(line.node.id, group === undefined ? line.node : { ...line.node, group });
    } else if (line.type === "edge") {
      const pair = edgeId({ source: line.edge.source, target: line.edge.target });
      const ordinal = (parallels.get(pair) ?? 0) + 1;
      parallels.set(pair, ordinal);
      const edge = ordinal === 1 ? line.edge : { ...line.edge, ordinal };
      edges.set(edgeId(edge), edge);
    } else {
      const kind = layoutPattern.exec(line.text.trim())?.[1];
      const known = layoutKinds.find((candidate) => candidate === kind);
      if (known)
        layout = known;
      const [, name, color] = tagPattern.exec(line.text.trim()) ?? [];
      if (!name || !color)
        continue;
      if (tags.has(name))
        errors.push(`duplicate tag "${name}"`);
      tags.set(name, { name, color });
    }
  }
  for (const id of groups.keys()) {
    if (nodes.has(id))
      errors.push(`"${id}" is both a node and a group`);
  }
  for (const edge of edges.values()) {
    for (const id of [edge.source, edge.target]) {
      if (!nodes.has(id) && !groups.has(id))
        nodes.set(id, { id, label: id, kind: "service" });
    }
  }
  return {
    layout,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    groups: [...groups.values()],
    tags: [...tags.values()],
    errors
  };
}
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var isId = (value) => typeof value === "string" && new RegExp(`^${idPattern}$`).test(value);
var isTarget = (value) => typeof value === "string" && new RegExp(`^${idPattern}(?:->${idPattern}(?:#\\d+)?)?$`).test(value);
var isOrdinal = (value) => value === undefined || typeof value === "number" && Number.isInteger(value) && value >= 1;
var isText = (value) => typeof value === "string" && !/[\r\n]/.test(value);
var isPosition = (value) => Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === "number");
var isLayout = (value) => isRecord(value) && Object.values(value).every(isPosition);
function toDiagramFiles(name, parts) {
  let layout = {};
  try {
    layout = JSON.parse(parts[".layout.json"] ?? "{}");
  } catch {}
  return {
    name,
    source: parts[".txt"] ?? "",
    layout: isLayout(layout) ? layout : {},
    notes: parts[".notes.md"] ?? "",
    marks: (parts[".marks"] ?? "").split(`
`).map((mark) => mark.trim()).filter((mark) => mark !== ""),
    ...parts[".handoff"] !== undefined && { handoff: parts[".handoff"].trim() }
  };
}
var isEntryText = (value) => isText(value) && typeof value === "string" && value.trim() !== "";
var isNote = (value) => {
  if (!isRecord(value) || value.kind !== "note" && value.kind !== "question")
    return false;
  const question = value.kind === "question";
  return (value.target === undefined || isTarget(value.target)) && isEntryText(value.text) && (value.tag === undefined || question && isId(value.tag)) && (value.forUser === undefined || question && value.forUser === true) && (value.answer === undefined || question && isEntryText(value.answer)) && typeof value.done === "boolean";
};
function isOp(value) {
  if (!isRecord(value))
    return false;
  const { node, edge } = value;
  switch (value.type) {
    case "upsert-node":
      return isRecord(node) && isId(node.id) && isText(node.label) && typeof node.kind === "string" && isKind(node.kind) && (node.group === undefined || isId(node.group)) && (value.position === undefined || isPosition(value.position));
    case "upsert-edge":
      return isRecord(edge) && isId(edge.source) && isId(edge.target) && isText(edge.label) && (edge.animated === undefined || typeof edge.animated === "boolean") && isOrdinal(edge.ordinal);
    case "remove-node":
      return isId(value.id);
    case "remove-edge":
      return isId(value.source) && isId(value.target) && isOrdinal(value.ordinal);
    case "move":
      return isId(value.id) && isPosition(value.position);
    case "reset-layout":
    case "clear-marks":
      return true;
    case "mark":
      return isTarget(value.target) && typeof value.marked === "boolean";
    case "handoff":
      return value.text === undefined || isText(value.text);
    case "add-note":
    case "remove-note":
      return isNote(value.note);
    case "update-note":
      return isNote(value.note) && isNote(value.next);
    default:
      return false;
  }
}
var isOps = (value) => Array.isArray(value) && value.every(isOp);
function applyOps(state, ops) {
  let lines = parseLines2(state.source);
  let nextLayout = { ...state.layout };
  let { notes } = state;
  let marks = new Set(state.marks);
  let { handoff } = state;
  const lastIndex = (type) => lines.findLastIndex((line) => line.type === type);
  const insertAfterLast = (type, line) => {
    const index = lastIndex(type);
    lines.splice(index === -1 ? lines.length : index + 1, 0, line);
  };
  const edgeLine = ({
    source,
    target,
    ordinal = 1
  }) => {
    let seen = 0;
    return lines.findIndex((line) => line.type === "edge" && line.edge.source === source && line.edge.target === target && ++seen === ordinal);
  };
  const groupAt = (index) => {
    let group;
    for (const line of lines.slice(0, index))
      if (line.type === "group")
        group = line.group.id;
    return group;
  };
  const insertNode = (node) => {
    let group;
    let at;
    lines.forEach((line, index) => {
      if (line.type === "group")
        group = line.group.id;
      if (line.type !== "other" && line.type !== "edge" && group === node.group)
        at = index + 1;
    });
    if (at === undefined && node.group === undefined) {
      const first = lines.findIndex((line) => line.type === "group");
      at = first === -1 ? lines.length : first;
    } else if (at === undefined && node.group !== undefined) {
      const last = lines.at(-1);
      if (!(last?.type === "other" && last.text === ""))
        lines.push({ type: "other", text: "" });
      lines.push({ type: "group", group: { id: node.group, label: node.group } });
    }
    lines.splice(at ?? lines.length, 0, { type: "node", node });
  };
  for (const op of ops) {
    if (op.type === "upsert-node") {
      const index = lines.findIndex((line) => line.type === "node" && line.node.id === op.node.id);
      if (index !== -1 && groupAt(index) === op.node.group) {
        lines[index] = { type: "node", node: op.node };
      } else {
        if (index !== -1) {
          lines.splice(index, 1);
          delete nextLayout[op.node.id];
        }
        insertNode(op.node);
      }
      if (op.position)
        nextLayout[op.node.id] = op.position;
    } else if (op.type === "remove-node") {
      const touches = (edge) => edge.source === op.id || edge.target === op.id;
      for (const line of lines) {
        if (line.type === "edge" && touches(line.edge))
          marks.delete(edgeId(line.edge));
      }
      lines = lines.filter((line) => !(line.type === "node" && line.node.id === op.id) && !(line.type === "edge" && touches(line.edge)));
      delete nextLayout[op.id];
      marks.delete(op.id);
    } else if (op.type === "upsert-edge") {
      const { ordinal, ...edge } = op.edge;
      const index = edgeLine({ ...edge, ordinal });
      if (index === -1)
        insertAfterLast("edge", { type: "edge", edge });
      else
        lines[index] = { type: "edge", edge };
    } else if (op.type === "remove-edge") {
      const index = edgeLine(op);
      if (index !== -1)
        lines.splice(index, 1);
      marks.delete(edgeId(op));
    } else if (op.type === "move") {
      nextLayout[op.id] = op.position;
    } else if (op.type === "reset-layout") {
      nextLayout = {};
    } else if (op.type === "mark") {
      if (op.marked)
        marks.add(op.target);
      else
        marks.delete(op.target);
    } else if (op.type === "clear-marks") {
      marks = new Set;
    } else if (op.type === "handoff") {
      handoff = op.text?.trim();
    } else {
      notes = applyNoteOp(notes, op);
    }
  }
  return {
    source: `${lines.map(serializeLine2).join(`
`)}
`,
    layout: nextLayout,
    notes,
    marks: [...marks],
    ...handoff !== undefined && { handoff }
  };
}

// server/versions.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var run = promisify(execFile);
var isRef = (value) => /^(?:[0-9a-f]{4,40}|HEAD(?:~\d{1,4})?)$/.test(value);
async function listVersions(dir, name) {
  try {
    const { stdout } = await run("git", ["log", "-n", "50", "--format=%H%x1f%cI%x1f%s", "--", `${name}.txt`], { cwd: dir });
    return stdout.split(`
`).filter((line) => line !== "").map((line) => {
      const [ref = "", date = "", subject = ""] = line.split("\x1F");
      return { ref, date, subject };
    });
  } catch {
    return [];
  }
}
async function readVersion(dir, name, ref) {
  const show = async (suffix) => {
    try {
      const { stdout } = await run("git", ["show", `${ref}:./${name}${suffix}`], {
        cwd: dir,
        maxBuffer: 16 * 1024 * 1024
      });
      return stdout;
    } catch {
      return;
    }
  };
  const [source, layout] = await Promise.all([show(".txt"), show(".layout.json")]);
  const files = toDiagramFiles(name, { ".txt": source, ".layout.json": layout });
  return { ref, source: files.source, layout: files.layout };
}

// server/diagrams.ts
var namePattern = /^[\w-]+$/;
var hostName = (host) => {
  try {
    return new URL(`http://${host}`).hostname.replace(/^\[(.*)\]$/, "$1");
  } catch {
    return;
  }
};
function isAllowedRequest(request, allowedHosts) {
  const listed = (name) => allowedHosts !== true && allowedHosts.some((allowed) => allowed.startsWith(".") ? `.${name}`.endsWith(allowed) : name === allowed);
  const { host, origin } = request.headers;
  const name = host ? hostName(host) : undefined;
  if (!name)
    return false;
  const hostAllowed = allowedHosts === true || isIP(name) !== 0 || name === "localhost" || name.endsWith(".localhost") || listed(name);
  if (!hostAllowed)
    return false;
  if (origin === undefined)
    return true;
  try {
    const url = new URL(origin);
    return url.host === host || listed(url.hostname);
  } catch {
    return false;
  }
}
async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return;
  }
}
function serializeLayout(layout) {
  const entries = Object.entries(layout).map(([id, [x, y]]) => `  ${JSON.stringify(id)}: [${x}, ${y}]`);
  return entries.length === 0 ? "" : `{
${entries.join(`,
`)}
}
`;
}
var serializeMarks = (marks) => marks.map((mark) => `${mark}
`).join("");
var parts = [
  { suffix: ".txt", serialize: (state) => state.source },
  { suffix: ".layout.json", serialize: (state) => serializeLayout(state.layout) },
  { suffix: ".notes.md", serialize: (state) => state.notes },
  { suffix: ".marks", serialize: (state) => serializeMarks(state.marks) },
  {
    suffix: ".handoff",
    serialize: (state) => state.handoff === undefined ? "" : `${state.handoff}
`
  }
];
function createDiagramsService(dir, allowedHosts = []) {
  const root = resolve(dir);
  const reject = (request, response) => {
    if (isAllowedRequest(request, allowedHosts))
      return false;
    response.statusCode = 403;
    response.end();
    return true;
  };
  const path = (name, suffix) => join(root, `${name}${suffix}`);
  const clients = new Set;
  let watcher;
  let version = 0;
  const nextVersion = () => version = Math.max(version + 1, Date.now());
  const list = async () => {
    await mkdir(root, { recursive: true });
    return partNames(await readdir(root), ".txt");
  };
  const load = async (name) => {
    const stamp = nextVersion();
    const contents = await Promise.all(parts.map(async ({ suffix }) => [suffix, await readOptional(path(name, suffix))]));
    return { ...toDiagramFiles(name, Object.fromEntries(contents)), version: stamp };
  };
  const save = async (name, ops) => {
    const current = await load(name);
    const next = applyOps(current, ops);
    await Promise.all(parts.map(async ({ suffix, serialize }) => {
      const content = serialize(next);
      if (content === serialize(current))
        return;
      if (content === "" && suffix !== ".txt")
        await rm(path(name, suffix), { force: true });
      else
        await writeFile(path(name, suffix), content);
    }));
    return { name, ...next, version: nextVersion() };
  };
  const broadcast = async (name) => {
    if (clients.size === 0)
      return;
    const event = JSON.stringify({ names: await list(), diagram: await load(name) });
    for (const client of clients)
      client.write(`data: ${event}

`);
  };
  const startWatching = async () => {
    await mkdir(root, { recursive: true });
    watcher = watch(root, (_event, file) => {
      const name = file ? partPattern.exec(file)?.[1] : undefined;
      if (name)
        broadcast(name);
    });
  };
  startWatching();
  return {
    root,
    close: () => watcher?.close(),
    events(request, response) {
      if (reject(request, response))
        return;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      response.write(`: connected

`);
      clients.add(response);
      request.on("close", () => clients.delete(response));
    },
    async api(request, response, url) {
      if (reject(request, response))
        return;
      const [name = "", action, ref] = (url.split("?")[0] ?? "").replace(/^\//, "").split("/").map(decodeURIComponent);
      const send = (status, body) => {
        response.statusCode = status;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(body));
      };
      if (name === "")
        return send(200, await list());
      if (!namePattern.test(name))
        return send(400, { error: "invalid diagram name" });
      if (action === "versions")
        return send(200, await listVersions(root, name));
      if (action === "at") {
        if (ref === undefined || !isRef(ref))
          return send(400, { error: "invalid version" });
        return send(200, await readVersion(root, name, ref));
      }
      if (action !== undefined)
        return send(404, { error: "not found" });
      if (request.method !== "POST")
        return send(200, await load(name));
      const ops = JSON.parse(await text(request));
      return isOps(ops) ? send(200, await save(name, ops)) : send(400, { error: "invalid ops" });
    }
  };
}

// server/export.ts
import { readFile as readFile2, readdir as readdir2 } from "node:fs/promises";
import { join as join2 } from "node:path";

// src/diagram/compare.ts
function compare(base, current) {
  const changes = new Map;
  const merge = (currentItems, baseItems, key, differs) => {
    const baseByKey = new Map(baseItems.map((item) => [key(item), item]));
    const currentKeys = new Set(currentItems.map(key));
    for (const item of currentItems) {
      const before = baseByKey.get(key(item));
      if (!before)
        changes.set(key(item), "added");
      else if (differs(before, item))
        changes.set(key(item), "changed");
    }
    const merged = [...currentItems];
    baseItems.forEach((item, index) => {
      if (currentKeys.has(key(item)))
        return;
      changes.set(key(item), "removed");
      const previous = baseItems[index - 1];
      const at = previous === undefined ? 0 : merged.findIndex((other) => key(other) === key(previous)) + 1;
      merged.splice(at, 0, item);
    });
    return merged;
  };
  const nodes = merge(current.diagram.nodes, base.diagram.nodes, (node) => node.id, (a, b) => a.label !== b.label || a.kind !== b.kind || a.group !== b.group);
  const groups = merge(current.diagram.groups, base.diagram.groups, (group) => group.id, (a, b) => a.label !== b.label || Boolean(a.outer) !== Boolean(b.outer) || a.parent !== b.parent);
  const edges = merge(current.diagram.edges, base.diagram.edges, edgeId, (a, b) => a.label !== b.label || Boolean(a.animated) !== Boolean(b.animated));
  const removedPins = Object.entries(base.layout).filter(([id]) => changes.get(id) === "removed");
  return {
    union: { ...current.diagram, nodes, groups, edges, errors: [] },
    changes,
    layout: { ...Object.fromEntries(removedPins), ...current.layout }
  };
}

// src/diagram/connections.ts
var portPitch = 16;
var portInset = 16;
var sidePortPitch = 12;
var sidePortInset = 14;
var trackPitch = 10;
var trackGap = 8;
var passClearance = 12;
var labelCharWidth = 6.2;
var labelPadding = 12;
var labelHeight = 18;
var lineClearance = 6;
function gridConnections(edges, grid) {
  const loops = edges.filter(({ source, target }) => source === target && grid.terminals.has(source));
  const blocked = ({ points }) => crossesNode(points, grid.obstacles);
  let drawn = drawAll(edges, grid, new Set);
  const retry = drawn.filter(blocked).map(({ id }) => id);
  if (retry.length > 0)
    drawn = drawAll(edges, grid, new Set(retry));
  drawn = drawn.filter((connection) => !blocked(connection));
  const labels = placeLabels(drawn, grid);
  const corner = (id) => {
    const { x, y } = grid.terminals.get(id).box;
    return [x, y];
  };
  const connections = Object.fromEntries(drawn.map(({ id, edge, points }) => [
    id,
    { points, label: labels.get(id), source: corner(edge.source), target: corner(edge.target) }
  ]));
  for (const edge of loops) {
    const { box, slot } = grid.terminals.get(edge.source);
    connections[edgeId(edge)] = {
      ...loop(box, slot === "left" ? "left" : "right", edge.label),
      source: corner(edge.source),
      target: corner(edge.source)
    };
  }
  return connections;
}
var loopReach = 36;
var loopSpan = 20;
var labelWidth = (label) => Math.max(label.length, 1) * labelCharWidth + labelPadding;
function loop(box, side, label) {
  const x = side === "right" ? box.x + box.width : box.x;
  const out = side === "right" ? x + loopReach : x - loopReach;
  const y = Math.round(box.y + box.height / 2);
  const beside = out + Math.sign(out - x) * (6 + labelWidth(label) / 2);
  return loopAt(x, out, y, beside);
}
var loopAt = (x, out, y, labelX) => ({
  points: [
    [x, y - loopSpan / 2],
    [out, y - loopSpan / 2],
    [out, y + loopSpan / 2],
    [x, y + loopSpan / 2]
  ],
  label: [Math.round(labelX), y]
});
function step(sourceX, targetX, y, label, isLoop) {
  if (isLoop) {
    const out = sourceX + loopReach;
    return loopAt(sourceX, out, y, out + 6 + labelWidth(label) / 2);
  }
  return {
    points: [
      [sourceX, y],
      [targetX, y]
    ],
    label: [Math.round((sourceX + targetX) / 2), y]
  };
}
function drawAll(edges, grid, viaChannel) {
  const paths = edges.flatMap((edge) => {
    const path = planPath(edge, grid, viaChannel.has(edgeId(edge)));
    return path ? [path] : [];
  });
  const ports = placePorts(paths, grid);
  const walkWith = (path, at) => walk(path, ports.get(`${path.id} source`), ports.get(`${path.id} target`), at);
  const tracks = assignTracks(paths, (path) => walkWith(path, (ref) => channel(grid, ref).at), grid);
  return paths.map((path) => ({
    id: path.id,
    edge: path.edge,
    points: withoutStraightBends(walkWith(path, (ref, index) => tracks.get(trackKey(path, ref, index)) ?? channel(grid, ref).at))
  }));
}
var channel = (grid, ref) => ("horizontal" in ref) ? grid.horizontal[ref.horizontal] : grid.vertical[ref.vertical];
var bottomOf = (box) => box.y + box.height;
var encloses = (outer, inner) => outer.x <= inner.x && outer.y <= inner.y && inner.x + inner.width <= outer.x + outer.width && bottomOf(inner) <= bottomOf(outer);
function planPath(edge, grid, viaChannel) {
  const { source, target } = edge;
  const from = grid.terminals.get(source);
  const to = grid.terminals.get(target);
  if (!from || !to || source === target)
    return;
  if (encloses(from.box, to.box) || encloses(to.box, from.box))
    return;
  const id = edgeId(edge);
  const fromX = from.box.x + from.box.width / 2;
  const toX = to.box.x + to.box.width / 2;
  const toY = to.box.y + to.box.height / 2;
  const path = (sourceSide, targetSide, bends, targetToward = ([x]) => x) => ({ edge, id, sourceSide, targetSide, bends, targetToward });
  const holds = (group, box) => {
    const outer = grid.terminals.get(group)?.box;
    return outer !== undefined && encloses(outer, box);
  };
  const blockers = [
    ...grid.obstacles,
    ...[...grid.headers].filter(([group]) => !holds(group, from.box) && !holds(group, to.box)).map(([, header]) => header)
  ];
  const passes = (x, top, bottom) => blockers.every((box) => bottomOf(box) <= top || box.y >= bottom || x <= box.x - passClearance || x >= box.x + box.width + passClearance);
  const inLine = Math.min(Math.max(fromX, to.box.x + portInset), to.box.x + to.box.width - portInset);
  const byDetour = grid.vertical.map(({ at }, index) => ({ at, index, detour: Math.abs(at - fromX) + Math.abs(at - toX) })).toSorted((a, b) => a.detour - b.detour);
  const across = (sourceSide, targetSide, leaving, entering, [top, bottom]) => {
    if (leaving === entering)
      return path(sourceSide, targetSide, [{ horizontal: entering }, { target: true }]);
    if (!viaChannel && passes(fromX, top, bottom))
      return path(sourceSide, targetSide, [{ horizontal: entering }, { target: true }]);
    if (!viaChannel && passes(inLine, top, bottom))
      return path(sourceSide, targetSide, [{ horizontal: leaving }, { target: true }]);
    const { at, index } = byDetour.find((candidate) => passes(candidate.at, top, bottom)) ?? byDetour[0];
    return path(sourceSide, targetSide, [{ horizontal: leaving }, { vertical: index }, { horizontal: entering }, { target: true }], () => at);
  };
  if (to.rows[0] > from.rows[1]) {
    return across("bottom", "top", from.rows[1] + 1, to.rows[0], [bottomOf(from.box), to.box.y]);
  }
  if (to.rows[1] < from.rows[0] && !grid.flow) {
    return across("top", "bottom", from.rows[0], to.rows[1] + 1, [bottomOf(to.box), from.box.y]);
  }
  if (to.rows[1] < from.rows[0]) {
    const side = to.slot === "single" ? fromX < toX ? "left" : "right" : to.slot;
    const beside = side === "left" ? to.columns[0] : to.columns[1] + 1;
    return path("bottom", side, [{ horizontal: from.rows[1] + 1 }, { vertical: beside }, { target: true }], () => toY);
  }
  const [left, right] = fromX < toX ? [from.box, to.box] : [to.box, from.box];
  const y = Math.round((Math.max(from.box.y, to.box.y) + Math.min(bottomOf(from.box), bottomOf(to.box))) / 2);
  const between = grid.obstacles.some((box) => box.x >= left.x + left.width && box.x + box.width <= right.x && box.y < y + passClearance && bottomOf(box) > y - passClearance);
  if (left.x + left.width <= right.x && !between) {
    return {
      ...path(fromX < toX ? "right" : "left", fromX < toX ? "left" : "right", [
        { midway: true },
        { target: true }
      ]),
      sourceToward: y,
      targetToward: ([, sourceY]) => sourceY
    };
  }
  return path("bottom", "bottom", [
    { horizontal: Math.max(from.rows[1], to.rows[1]) + 1 },
    { target: true }
  ]);
}
function walk(path, start, end, at) {
  const points = [start];
  let [x, y] = start;
  let vertical = along(path.sourceSide) === 0;
  path.bends.forEach((bend, index) => {
    const value = "target" in bend ? end[vertical ? 1 : 0] : ("midway" in bend) ? Math.round((start[0] + end[0]) / 2) : at(bend, index);
    if (vertical)
      y = value;
    else
      x = value;
    points.push([x, y]);
    vertical = !vertical;
  });
  points.push(end);
  return points;
}
var along = (side) => side === "top" || side === "bottom" ? 0 : 1;
function sideSpan(box, side) {
  return along(side) === 0 ? [box.x + portInset, box.x + box.width - portInset] : [box.y + sidePortInset, bottomOf(box) - sidePortInset];
}
function onSide(box, side, position) {
  if (side === "top")
    return [position, box.y];
  if (side === "bottom")
    return [position, bottomOf(box)];
  if (side === "left")
    return [box.x, position];
  return [box.x + box.width, position];
}
function placePorts(paths, grid) {
  const sourceSlot = (path) => fansOut(path) ? `${path.edge.source} ${path.sourceSide}` : `${path.id} source`;
  const box = (id) => grid.terminals.get(id).box;
  const sourceDemands = (toward) => paths.map((path, order) => ({
    slot: sourceSlot(path),
    terminal: path.edge.source,
    box: box(path.edge.source),
    side: path.sourceSide,
    toward: toward(path),
    order
  }));
  const middle = (path) => {
    const [low, high] = sideSpan(box(path.edge.source), path.sourceSide);
    return path.sourceToward ?? (low + high) / 2;
  };
  const sources = spreadPorts(sourceDemands(middle));
  const sourcePort = (path) => onSide(box(path.edge.source), path.sourceSide, sources.get(sourceSlot(path)));
  const placed = spreadPorts([
    ...sourceDemands((path) => sources.get(sourceSlot(path))),
    ...paths.map((path, order) => ({
      slot: `${path.id} target`,
      terminal: path.edge.target,
      box: box(path.edge.target),
      side: path.targetSide,
      toward: path.targetToward(sourcePort(path)),
      order
    }))
  ]);
  return new Map(paths.flatMap((path) => [
    [
      `${path.id} source`,
      onSide(box(path.edge.source), path.sourceSide, placed.get(sourceSlot(path)))
    ],
    [
      `${path.id} target`,
      onSide(box(path.edge.target), path.targetSide, placed.get(`${path.id} target`))
    ]
  ]));
}
function spreadPorts(demands) {
  const positions = new Map;
  const bySide = Map.groupBy(demands, ({ terminal, side }) => `${terminal} ${side}`);
  for (const sideDemands of bySide.values()) {
    const slots = [
      ...new Map(sideDemands.map((demand) => [demand.slot, demand])).values()
    ].toSorted((a, b) => a.toward - b.toward || a.order - b.order);
    const { box, side } = slots[0];
    const [low, high] = sideSpan(box, side);
    const pitch = along(side) === 0 ? portPitch : sidePortPitch;
    const spacing = slots.length > 1 ? Math.min(pitch, (high - low) / (slots.length - 1)) : 0;
    const placed = slots.map(({ toward }) => Math.min(Math.max(toward, low), high));
    for (let index = 1;index < placed.length; index++)
      placed[index] = Math.max(placed[index], placed[index - 1] + spacing);
    placed[placed.length - 1] = Math.min(placed.at(-1), high);
    for (let index = placed.length - 2;index >= 0; index--)
      placed[index] = Math.min(placed[index], placed[index + 1] - spacing);
    slots.forEach(({ slot }, index) => positions.set(slot, Math.round(placed[index])));
  }
  return positions;
}
var fansOut = (path) => along(path.sourceSide) === 0 && (path.edge.ordinal ?? 1) === 1;
function trackKey(path, ref, index) {
  const name = "horizontal" in ref ? `horizontal ${ref.horizontal}` : `vertical ${ref.vertical}`;
  const shared = index === 0 && fansOut(path);
  return `${name} ${shared ? `${path.edge.source} ${path.sourceSide}` : `${path.id} ${index}`}`;
}
function assignTracks(paths, centers, grid) {
  const legs = new Map;
  paths.forEach((path, order) => {
    const points = centers(path);
    path.bends.forEach((bend, index) => {
      if ("target" in bend || "midway" in bend)
        return;
      const axis = "horizontal" in bend ? 0 : 1;
      const [a, b] = [points[index + 1][axis], points[index + 2][axis]];
      if (Math.abs(a - b) < 1)
        return;
      const key = trackKey(path, bend, index);
      const name = key.split(" ", 2).join(" ");
      const inChannel = legs.get(name) ?? new Map;
      const known = inChannel.get(key);
      inChannel.set(key, {
        low: Math.min(a, b, known?.low ?? Infinity),
        high: Math.max(a, b, known?.high ?? -Infinity),
        order: known?.order ?? order
      });
      legs.set(name, inChannel);
    });
  });
  const tracks = new Map;
  for (const [name, inChannel] of legs) {
    const [kind, index] = name.split(" ");
    const { at, room } = channel(grid, kind === "horizontal" ? { horizontal: Number(index) } : { vertical: Number(index) });
    const ends = [];
    const trackOf = new Map;
    for (const [key, leg] of [...inChannel].toSorted(([, a], [, b]) => a.low - b.low || a.order - b.order)) {
      let track = ends.findIndex((end) => end + trackGap <= leg.low);
      if (track === -1)
        track = ends.push(leg.high) - 1;
      else
        ends[track] = leg.high;
      trackOf.set(key, track);
    }
    const count = ends.length;
    const pitch = count > 1 ? Math.min(trackPitch, Math.max(0, room) / (count - 1)) : 0;
    for (const [key, track] of trackOf)
      tracks.set(key, Math.round(at + (track - (count - 1) / 2) * pitch));
  }
  return tracks;
}
function crossesNode(points, obstacles) {
  return points.slice(1).some(([x2, y2], index) => {
    const [x1, y1] = points[index];
    return obstacles.some((box) => Math.max(x1, x2) > box.x + 1 && Math.min(x1, x2) < box.x + box.width - 1 && Math.max(y1, y2) > box.y + 1 && Math.min(y1, y2) < bottomOf(box) - 1);
  });
}
var axisOf = ({ from, to }) => from[0] === to[0] ? 1 : 0;
function extent(segment, axis) {
  const [a, b] = [segment.from[axis], segment.to[axis]];
  return a < b ? [a, b] : [b, a];
}
function uncovered([low, high], covered) {
  const pieces = [];
  let from = low;
  for (const [start, end] of covered.toSorted((a, b) => a[0] - b[0])) {
    if (start > from)
      pieces.push([from, Math.min(start, high)]);
    from = Math.max(from, end);
  }
  if (from < high)
    pieces.push([from, high]);
  return pieces.filter(([start, end]) => end - start > 1);
}
var intersects = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < bottomOf(b) && b.y < bottomOf(a);
function placeLabels(drawn, grid) {
  const segments = drawn.flatMap(({ id, points }) => points.slice(1).map((to, index) => ({ id, from: points[index], to })));
  const taken = [
    ...grid.obstacles.map((box) => ({
      x: box.x - 4,
      y: box.y - 4,
      width: box.width + 8,
      height: box.height + 8
    })),
    ...grid.headers.values()
  ];
  const lines = (id) => segments.filter((segment) => segment.id !== id).map(({ from, to }) => ({
    x: Math.min(from[0], to[0]) - lineClearance,
    y: Math.min(from[1], to[1]) - lineClearance,
    width: Math.abs(to[0] - from[0]) + 2 * lineClearance,
    height: Math.abs(to[1] - from[1]) + 2 * lineClearance
  }));
  const labels = new Map;
  for (const { id, edge } of drawn) {
    const width = labelWidth(edge.label);
    const around = ([x, y]) => ({
      x: x - width / 2,
      y: y - labelHeight / 2,
      width,
      height: labelHeight
    });
    const candidates = segments.filter((segment) => segment.id === id).flatMap((segment) => {
      const axis = axisOf(segment);
      const line = segment.from[1 - axis];
      const at = (value) => axis === 1 ? [line, Math.round(value)] : [Math.round(value), line];
      const covered = segments.filter((other) => other.id !== id && axisOf(other) === axis && other.from[1 - axis] === line).map((other) => extent(other, axis));
      const room = axis === 1 ? labelHeight + 16 : width + 8;
      const whole = extent(segment, axis);
      return [
        ...uncovered(whole, covered).map((piece) => ({ piece, own: true })),
        { piece: whole, own: false }
      ].map(({ piece: [start, end], own }) => ({
        middle: at((start + end) / 2),
        own,
        fits: end - start >= room,
        length: end - start
      }));
    }).toSorted((a, b) => Number(b.own) - Number(a.own) || Number(b.fits) - Number(a.fits) || b.length - a.length);
    const free = candidates.filter(({ middle }) => !taken.some((box) => intersects(box, around(middle))));
    const apart = free.find(({ middle }) => !lines(id).some((box) => intersects(box, around(middle))));
    const label = (apart ?? free[0] ?? candidates[0]).middle;
    labels.set(id, label);
    taken.push(around(label));
  }
  return labels;
}
function withoutStraightBends(points) {
  const kept = [];
  for (const point of points) {
    const last = kept.at(-1);
    if (last && last[0] === point[0] && last[1] === point[1])
      continue;
    const before = kept.at(-2);
    const straight = before && last && (before[0] === last[0] && last[0] === point[0] || before[1] === last[1] && last[1] === point[1]);
    if (straight)
      kept.pop();
    kept.push(point);
  }
  return kept;
}

// src/diagram/grid.ts
var nodeSize = { width: 208, height: 56 };
var layerSeparation = 72;
var groupPadding = 16;
var groupHeader = 40;
var headerGap = 16;
var trackClearance = 12;
var covers = ([first, last], index) => first <= index && index <= last;
var across = (axis) => axis === "columns" ? "rows" : "columns";
var contains = (outer, inner) => outer.columns[0] <= inner.columns[0] && inner.columns[1] <= outer.columns[1] && outer.rows[0] <= inner.rows[0] && inner.rows[1] <= outer.rows[1];
function table(columnWidths, rowHeights, spans, channels) {
  const rowCount = rowHeights.length;
  const starting = (axis, gap) => spans.filter((span) => span[axis][0] === gap);
  const ending = (axis, gap) => spans.filter((span) => span[axis][1] === gap - 1);
  const stacked = (borders, axis, count) => Math.max(0, ...Array.from({ length: count }, (_, index) => borders.filter((span) => covers(span[across(axis)], index)).length));
  const depth = (span, borders) => 1 + Math.max(0, ...borders.filter((border) => border !== span && contains(span, border)).map((border) => depth(border, borders)));
  const vertical = [];
  const columnX = [];
  let x = 0;
  for (let gap = 0;gap <= columnWidths.length; gap++) {
    x += stacked(ending("columns", gap), "columns", rowCount) * groupPadding;
    vertical.push({ at: x + channels.vertical / 2, room: channels.vertical - 2 * trackClearance });
    x += channels.vertical + stacked(starting("columns", gap), "columns", rowCount) * groupPadding;
    if (gap < columnWidths.length) {
      columnX.push(x);
      x += columnWidths[gap];
    }
  }
  const horizontal = [];
  const rowY = [];
  let y = 0;
  for (let gap = 0;gap <= rowCount; gap++) {
    const channel = gap === 0 ? 0 : gap === rowCount ? channels.bottom : channels.horizontal;
    y += stacked(ending("rows", gap), "rows", columnWidths.length) * groupPadding;
    horizontal.push({ at: y + channel / 2, room: channel - 2 * trackClearance });
    y += channel + stacked(starting("rows", gap), "rows", columnWidths.length) * (groupHeader + headerGap);
    if (gap < rowCount) {
      rowY.push(y);
      y += rowHeights[gap];
    }
  }
  const boxes = new Map(spans.map((span) => {
    const [first, last] = span.columns;
    const [top, bottom] = span.rows;
    const left = columnX[first] - depth(span, starting("columns", first)) * groupPadding;
    const right = columnX[last] + columnWidths[last] + depth(span, ending("columns", last + 1)) * groupPadding;
    const upper = rowY[top] - depth(span, starting("rows", top)) * (groupHeader + headerGap);
    const lower = rowY[bottom] + rowHeights[bottom] + depth(span, ending("rows", bottom + 1)) * groupPadding;
    return [span.id, { x: left, y: upper, width: right - left, height: lower - upper }];
  }));
  return { columnX, rowY, boxes, vertical, horizontal };
}
function outermostFirst(spans, boxes) {
  const ancestors = (span) => spans.filter((other) => other !== span && contains(other, span)).length;
  return spans.toSorted((a, b) => ancestors(a) - ancestors(b)).map(({ id }) => ({ id, box: boxes.get(id) }));
}
function connect(diagram, spans, cells, grid, flow) {
  const terminals = new Map;
  const obstacles = [];
  for (const [id, { row, column, slot, box }] of cells) {
    terminals.set(id, { box, rows: [row, row], columns: [column, column], slot });
    obstacles.push(box);
  }
  for (const { id, rows, columns } of spans) {
    terminals.set(id, { box: grid.boxes.get(id), rows, columns, slot: "single" });
  }
  const headers = new Map([...grid.boxes].map(([id, { x, y, width }]) => [id, { x, y, width, height: groupHeader }]));
  return gridConnections(diagram.edges, {
    terminals,
    obstacles,
    headers,
    horizontal: grid.horizontal,
    vertical: grid.vertical,
    flow
  });
}
var positionsOf = (cells) => Object.fromEntries([...cells].map(([id, { box }]) => [id, [box.x, box.y]]));
function backEdges(diagram) {
  const successors = Map.groupBy(diagram.edges, (edge) => edge.source);
  const back = new Set;
  const onPath = new Set;
  const done = new Set;
  const visit = (id) => {
    onPath.add(id);
    for (const edge of successors.get(id) ?? []) {
      if (onPath.has(edge.target))
        back.add(edge);
      else if (!done.has(edge.target))
        visit(edge.target);
    }
    onPath.delete(id);
    done.add(id);
  };
  for (const node of diagram.nodes)
    if (!done.has(node.id))
      visit(node.id);
  return back;
}
var columnGap = 16;
var columnWidth = 2 * nodeSize.width + columnGap;
var slotX = {
  single: (columnWidth - nodeSize.width) / 2,
  left: 0,
  right: nodeSize.width + columnGap
};
function flowGrid(diagram) {
  const order = new Map(diagram.nodes.map((node, index) => [node.id, index]));
  const back = backEdges(diagram);
  const incoming = Map.groupBy(diagram.edges.filter((edge) => edge.source !== edge.target && !back.has(edge) && order.has(edge.source) && order.has(edge.target)), (edge) => edge.target);
  const layers = new Map;
  const layerOf = (id) => {
    let layer = layers.get(id);
    if (layer === undefined) {
      layer = Math.max(0, ...(incoming.get(id) ?? []).map((edge) => layerOf(edge.source) + 1));
      layers.set(id, layer);
    }
    return layer;
  };
  const usedLayers = [...new Set(diagram.nodes.map((node) => layerOf(node.id)))].toSorted((a, b) => a - b);
  const rowOfLayer = new Map(usedLayers.map((layer, row) => [layer, row]));
  const columns = [undefined, ...diagram.groups.map((group) => group.id)].map((id) => ({ id, members: diagram.nodes.filter((node) => node.group === id) })).filter(({ members }) => members.length > 0);
  const columnOf = new Map(columns.flatMap(({ members }, column) => members.map((node) => [node.id, column])));
  const neighbors = new Map;
  const betweenNodes = diagram.edges.filter((edge) => order.has(edge.source) && order.has(edge.target));
  for (const { source, target } of betweenNodes) {
    neighbors.set(source, [...neighbors.get(source) ?? [], columnOf.get(target) ?? 0]);
    neighbors.set(target, [...neighbors.get(target) ?? [], columnOf.get(source) ?? 0]);
  }
  const barycenter = (id) => {
    const around = neighbors.get(id) ?? [columnOf.get(id) ?? 0];
    return around.reduce((sum, column) => sum + column, 0) / around.length;
  };
  const seats = [];
  let rowCount = 0;
  columns.forEach(({ members }, column) => {
    const rows = [];
    const byLayer = members.toSorted((a, b) => rowOfLayer.get(layerOf(a.id)) - rowOfLayer.get(layerOf(b.id)) || order.get(a.id) - order.get(b.id));
    for (const node of byLayer) {
      const layer = layerOf(node.id);
      const open = rows.at(-1);
      if (open && open.ids.length === 1 && open.layer === layer)
        open.ids.push(node.id);
      else {
        const row = Math.max((open?.row ?? -1) + 1, rowOfLayer.get(layer));
        rows.push({ row, layer, ids: [node.id] });
      }
    }
    for (const { row, ids } of rows) {
      rowCount = Math.max(rowCount, row + 1);
      const pair = ids.toSorted((a, b) => barycenter(a) - barycenter(b) || order.get(a) - order.get(b));
      pair.forEach((id, index) => {
        const slot = pair.length === 1 ? "single" : index === 0 ? "left" : "right";
        seats.push({ id, row, column, slot });
      });
    }
  });
  const allRows = [0, rowCount - 1];
  const spans = diagram.groups.flatMap((group) => {
    const held = columns.flatMap(({ id }, column) => inGroup(diagram.groups, id, group) ? [column] : []);
    return held.length === 0 ? [] : [{ id: group.id, columns: [held[0], held.at(-1)], rows: allRows }];
  });
  const grid = table(columns.map(() => columnWidth), Array.from({ length: rowCount }, () => nodeSize.height), spans, { vertical: 48, horizontal: layerSeparation, bottom: 32 });
  const cells = new Map(seats.map(({ id, row, column, slot }) => [
    id,
    {
      row,
      column,
      slot,
      box: { x: grid.columnX[column] + slotX[slot], y: grid.rowY[row], ...nodeSize }
    }
  ]));
  return {
    positions: positionsOf(cells),
    connections: connect(diagram, spans, cells, grid, true),
    groups: outermostFirst(spans, grid.boxes)
  };
}
var blockWidth = 3;
function architectureGrid(diagram, gap = 48) {
  const nodesIn = (group) => diagram.nodes.filter((node) => node.group === group);
  const bands = [
    {
      id: undefined,
      groups: diagram.groups.filter((group) => !group.outer && group.parent === undefined)
    },
    ...diagram.groups.filter((group) => group.outer).map(({ id }) => ({ id, groups: diagram.groups.filter((group) => group.parent === id) }))
  ];
  const seats = [];
  const spans = [];
  let rowCount = 0;
  let columnCount = 0;
  for (const band of bands) {
    const blocks = [
      { id: undefined, nodes: nodesIn(band.id) },
      ...band.groups.map(({ id }) => ({ id, nodes: nodesIn(id) }))
    ].filter(({ id, nodes }) => id !== undefined || nodes.length > 0);
    if (blocks.length === 0 && band.id === undefined)
      continue;
    let column = 0;
    let height = 1;
    for (const { id, nodes } of blocks) {
      const width = Math.max(1, Math.min(nodes.length, blockWidth));
      const rows = Math.max(1, Math.ceil(nodes.length / blockWidth));
      nodes.forEach((node, index) => seats.push({
        id: node.id,
        row: rowCount + Math.floor(index / blockWidth),
        column: column + index % blockWidth
      }));
      if (id !== undefined) {
        spans.push({
          id,
          columns: [column, column + width - 1],
          rows: [rowCount, rowCount + rows - 1]
        });
      }
      column += width;
      height = Math.max(height, rows);
    }
    if (band.id !== undefined) {
      spans.push({
        id: band.id,
        columns: [0, Math.max(column, 1) - 1],
        rows: [rowCount, rowCount + height - 1]
      });
    }
    columnCount = Math.max(columnCount, column, 1);
    rowCount += height;
  }
  if (rowCount === 0)
    return { positions: {}, connections: {}, groups: [] };
  const grid = table(Array.from({ length: columnCount }, () => nodeSize.width), Array.from({ length: rowCount }, () => nodeSize.height), spans, { vertical: gap, horizontal: 64, bottom: 32 });
  const cells = new Map(seats.map(({ id, row, column }) => [
    id,
    {
      row,
      column,
      slot: "single",
      box: { x: grid.columnX[column], y: grid.rowY[row], ...nodeSize }
    }
  ]));
  return {
    positions: positionsOf(cells),
    connections: connect(diagram, spans, cells, grid, false),
    groups: outermostFirst(spans, grid.boxes)
  };
}
var stepHeight = 40;
function sequenceGrid(diagram) {
  const columnOf = new Map(diagram.nodes.map((node, column) => [node.id, column]));
  const steps = diagram.edges.filter(({ source, target }) => columnOf.has(source) && columnOf.has(target));
  const rowCount = 1 + steps.length;
  const spans = diagram.groups.flatMap((group) => {
    const held = diagram.nodes.flatMap((node, column) => inGroup(diagram.groups, node.group, group) ? [column] : []);
    return held.length === 0 ? [] : [{ id: group.id, columns: [held[0], held.at(-1)], rows: [0, rowCount - 1] }];
  });
  const grid = table(diagram.nodes.map(() => nodeSize.width), [nodeSize.height, ...steps.map(() => stepHeight)], spans, { vertical: 48, horizontal: 0, bottom: 16 });
  const positions = Object.fromEntries(diagram.nodes.map((node, column) => [
    node.id,
    [grid.columnX[column], grid.rowY[0]]
  ]));
  const timeline = rowCount === 1 ? 0 : grid.rowY.at(-1) + stepHeight - grid.rowY[0] - nodeSize.height;
  const middle = (id) => positions[id][0] + nodeSize.width / 2;
  const rows = steps.map((edge, index) => [
    edge,
    grid.rowY[index + 1] + stepHeight / 2
  ]);
  return {
    positions,
    connections: Object.fromEntries(rows.map(([edge, y]) => [
      edgeId(edge),
      {
        ...step(middle(edge.source), middle(edge.target), y, edge.label, edge.source === edge.target),
        source: positions[edge.source],
        target: positions[edge.target]
      }
    ])),
    groups: outermostFirst(spans, grid.boxes),
    steps: Object.fromEntries(rows.map(([edge, y]) => [edgeId(edge), y])),
    timelines: Object.fromEntries(diagram.nodes.map((node) => [node.id, timeline]))
  };
}
var inGroup = (groups, group, outer) => group === outer.id || groups.some(({ id, parent }) => id === group && parent === outer.id);

// node_modules/@dagrejs/dagre/dist/dagre.esm.js
var Te = Object.defineProperty;
var In = (e, n, t) => (n in e) ? Te(e, n, { enumerable: true, configurable: true, writable: true, value: t }) : e[n] = t;
var Sn = (e, n) => {
  for (var t in n)
    Te(e, t, { get: n[t], enumerable: true });
};
var je = (e, n, t) => In(e, typeof n != "symbol" ? n + "" : n, t);
var ie = {};
Sn(ie, { Graph: () => T, alg: () => H });
var Mn = Object.defineProperty;
var Se = (e, n) => {
  for (var t in n)
    Mn(e, t, { get: n[t], enumerable: true });
};
var Q = class {
  constructor(e) {
    this._isDirected = true, this._isMultigraph = false, this._isCompound = false, this._nodes = {}, this._in = {}, this._preds = {}, this._out = {}, this._sucs = {}, this._edgeObjs = {}, this._edgeLabels = {}, this._nodeCount = 0, this._edgeCount = 0, this._defaultNodeLabelFn = () => {}, this._defaultEdgeLabelFn = () => {}, e && (this._isDirected = ("directed" in e) ? e.directed : true, this._isMultigraph = ("multigraph" in e) ? e.multigraph : false, this._isCompound = ("compound" in e) ? e.compound : false), this._isCompound && (this._parent = {}, this._children = {}, this._children["\x00"] = {});
  }
  isDirected() {
    return this._isDirected;
  }
  isMultigraph() {
    return this._isMultigraph;
  }
  isCompound() {
    return this._isCompound;
  }
  setGraph(e) {
    return this._label = e, this;
  }
  graph() {
    return this._label;
  }
  setDefaultNodeLabel(e) {
    return typeof e != "function" ? this._defaultNodeLabelFn = () => e : this._defaultNodeLabelFn = e, this;
  }
  nodeCount() {
    return this._nodeCount;
  }
  nodes() {
    return Object.keys(this._nodes);
  }
  sources() {
    return this.nodes().filter((e) => Object.keys(this._in[e]).length === 0);
  }
  sinks() {
    return this.nodes().filter((e) => Object.keys(this._out[e]).length === 0);
  }
  setNodes(e, n) {
    return e.forEach((t) => {
      n !== undefined ? this.setNode(t, n) : this.setNode(t);
    }), this;
  }
  setNode(e, n) {
    return e in this._nodes ? (arguments.length > 1 && (this._nodes[e] = n), this) : (this._nodes[e] = arguments.length > 1 ? n : this._defaultNodeLabelFn(e), this._isCompound && (this._parent[e] = "\x00", this._children[e] = {}, this._children["\x00"][e] = true), this._in[e] = {}, this._preds[e] = {}, this._out[e] = {}, this._sucs[e] = {}, ++this._nodeCount, this);
  }
  node(e) {
    return this._nodes[e];
  }
  hasNode(e) {
    return e in this._nodes;
  }
  removeNode(e) {
    if (e in this._nodes) {
      let n = (t) => this.removeEdge(this._edgeObjs[t]);
      delete this._nodes[e], this._isCompound && (this._removeFromParentsChildList(e), delete this._parent[e], this.children(e).forEach((t) => {
        this.setParent(t);
      }), delete this._children[e]), Object.keys(this._in[e]).forEach(n), delete this._in[e], delete this._preds[e], Object.keys(this._out[e]).forEach(n), delete this._out[e], delete this._sucs[e], --this._nodeCount;
    }
    return this;
  }
  setParent(e, n) {
    if (!this._isCompound)
      throw new Error("Cannot set parent in a non-compound graph");
    if (n === undefined)
      n = "\x00";
    else {
      n += "";
      for (let t = n;t !== undefined; t = this.parent(t))
        if (t === e)
          throw new Error("Setting " + n + " as parent of " + e + " would create a cycle");
      this.setNode(n);
    }
    return this.setNode(e), this._removeFromParentsChildList(e), this._parent[e] = n, this._children[n][e] = true, this;
  }
  parent(e) {
    if (this._isCompound) {
      let n = this._parent[e];
      if (n !== "\x00")
        return n;
    }
  }
  children(e = "\x00") {
    if (this._isCompound) {
      let n = this._children[e];
      if (n)
        return Object.keys(n);
    } else {
      if (e === "\x00")
        return this.nodes();
      if (this.hasNode(e))
        return [];
    }
    return [];
  }
  predecessors(e) {
    let n = this._preds[e];
    if (n)
      return Object.keys(n);
  }
  successors(e) {
    let n = this._sucs[e];
    if (n)
      return Object.keys(n);
  }
  neighbors(e) {
    let n = this.predecessors(e);
    if (n) {
      let t = new Set(n), r = this.successors(e);
      if (r)
        for (let o of r)
          t.add(o);
      return Array.from(t.values());
    }
  }
  isLeaf(e) {
    var n;
    let t;
    return this.isDirected() ? t = this.successors(e) : t = this.neighbors(e), ((n = t == null ? undefined : t.length) != null ? n : 0) === 0;
  }
  filterNodes(e) {
    let n = new this.constructor({ directed: this._isDirected, multigraph: this._isMultigraph, compound: this._isCompound });
    n.setGraph(this.graph()), Object.entries(this._nodes).forEach(([o, i]) => {
      e(o) && n.setNode(o, i);
    }), Object.values(this._edgeObjs).forEach((o) => {
      n.hasNode(o.v) && n.hasNode(o.w) && n.setEdge(o, this.edge(o));
    });
    let t = {}, r = (o) => {
      let i = this.parent(o);
      return !i || n.hasNode(i) ? (t[o] = i, i) : (i in t) ? t[i] : r(i);
    };
    return this._isCompound && n.nodes().forEach((o) => n.setParent(o, r(o))), n;
  }
  setDefaultEdgeLabel(e) {
    return typeof e != "function" ? this._defaultEdgeLabelFn = () => e : this._defaultEdgeLabelFn = e, this;
  }
  edgeCount() {
    return this._edgeCount;
  }
  edges() {
    return Object.values(this._edgeObjs);
  }
  setPath(e, n) {
    return e.reduce((t, r) => (n !== undefined ? this.setEdge(t, r, n) : this.setEdge(t, r), r)), this;
  }
  setEdge(e, n, t, r) {
    let o, i, s, a, l = false;
    typeof e == "object" && e !== null && "v" in e ? (o = e.v, i = e.w, s = e.name, arguments.length === 2 && (a = n, l = true)) : (o = e, i = n, s = r, arguments.length > 2 && (a = t, l = true)), o = "" + o, i = "" + i, s !== undefined && (s = "" + s);
    let u = z(this._isDirected, o, i, s);
    if (u in this._edgeLabels)
      return l && (this._edgeLabels[u] = a), this;
    if (s !== undefined && !this._isMultigraph)
      throw new Error("Cannot set a named edge when isMultigraph = false");
    this.setNode(o), this.setNode(i), this._edgeLabels[u] = l ? a : this._defaultEdgeLabelFn(o, i, s);
    let d = Pn(this._isDirected, o, i, s);
    return o = d.v, i = d.w, Object.freeze(d), this._edgeObjs[u] = d, Re(this._preds[i], o), Re(this._sucs[o], i), this._in[i][u] = d, this._out[o][u] = d, this._edgeCount++, this;
  }
  edge(e, n, t) {
    let r = arguments.length === 1 ? oe(this._isDirected, e) : z(this._isDirected, e, n, t);
    return this._edgeLabels[r];
  }
  edgeAsObj(e, n, t) {
    let r = arguments.length === 1 ? this.edge(e) : this.edge(e, n, t);
    return typeof r != "object" || r === null ? { label: r } : r;
  }
  hasEdge(e, n, t) {
    return (arguments.length === 1 ? oe(this._isDirected, e) : z(this._isDirected, e, n, t)) in this._edgeLabels;
  }
  removeEdge(e, n, t) {
    let r = arguments.length === 1 ? oe(this._isDirected, e) : z(this._isDirected, e, n, t), o = this._edgeObjs[r];
    if (o) {
      let { v: i, w: s } = o;
      delete this._edgeLabels[r], delete this._edgeObjs[r], Ie(this._preds[s], i), Ie(this._sucs[i], s), delete this._in[s][r], delete this._out[i][r], this._edgeCount--;
    }
    return this;
  }
  inEdges(e, n) {
    return this.isDirected() ? this.filterEdges(this._in[e], e, n) : this.nodeEdges(e, n);
  }
  outEdges(e, n) {
    return this.isDirected() ? this.filterEdges(this._out[e], e, n) : this.nodeEdges(e, n);
  }
  nodeEdges(e, n) {
    if (e in this._nodes)
      return this.filterEdges({ ...this._in[e], ...this._out[e] }, e, n);
  }
  _removeFromParentsChildList(e) {
    delete this._children[this._parent[e]][e];
  }
  filterEdges(e, n, t) {
    if (!e)
      return;
    let r = Object.values(e);
    return t ? r.filter((o) => o.v === n && o.w === t || o.v === t && o.w === n) : r;
  }
};
function Re(e, n) {
  e[n] ? e[n]++ : e[n] = 1;
}
function Ie(e, n) {
  e[n] !== undefined && !--e[n] && delete e[n];
}
function z(e, n, t, r) {
  let o = "" + n, i = "" + t;
  if (!e && o > i) {
    let s = o;
    o = i, i = s;
  }
  return o + "\x01" + i + "\x01" + (r === undefined ? "\x00" : r);
}
function Pn(e, n, t, r) {
  let o = "" + n, i = "" + t;
  if (!e && o > i) {
    let a = o;
    o = i, i = a;
  }
  let s = { v: o, w: i };
  return r && (s.name = r), s;
}
function oe(e, n) {
  return z(e, n.v, n.w, n.name);
}
var Fn = {};
Se(Fn, { read: () => Yn, write: () => An });
function An(e) {
  let n = { options: { directed: e.isDirected(), multigraph: e.isMultigraph(), compound: e.isCompound() }, nodes: Vn(e), edges: Dn(e) }, t = e.graph();
  return t !== undefined && (n.value = structuredClone(t)), n;
}
function Vn(e) {
  return e.nodes().map((n) => {
    let t = e.node(n), r = e.parent(n), o = { v: n };
    return t !== undefined && (o.value = t), r !== undefined && (o.parent = r), o;
  });
}
function Dn(e) {
  return e.edges().map((n) => {
    let t = e.edge(n), r = { v: n.v, w: n.w };
    return n.name !== undefined && (r.name = n.name), t !== undefined && (r.value = t), r;
  });
}
function Yn(e) {
  let n = new Q(e.options);
  return e.value !== undefined && n.setGraph(e.value), e.nodes.forEach((t) => {
    n.setNode(t.v, t.value), t.parent && n.setParent(t.v, t.parent);
  }), e.edges.forEach((t) => {
    n.setEdge({ v: t.v, w: t.w, name: t.name }, t.value);
  }), n;
}
var H = {};
Se(H, { CycleException: () => K, bellmanFord: () => Me, components: () => Xn, dijkstra: () => J, dijkstraAll: () => qn, findCycles: () => $n, floydWarshall: () => Jn, isAcyclic: () => Qn, postorder: () => et, preorder: () => nt, prim: () => tt, shortestPaths: () => rt, tarjan: () => Fe, topsort: () => Ae });
var Wn = () => 1;
function Me(e, n, t, r) {
  return Bn(e, String(n), t || Wn, r || function(o) {
    var i;
    return (i = e.outEdges(o)) != null ? i : [];
  });
}
function Bn(e, n, t, r) {
  let o = {}, i, s = 0, a = e.nodes(), l = function(c) {
    let f = o[c.v], h = o[c.w];
    if (!f || !h)
      return;
    let p = t(c);
    f.distance + p < h.distance && (o[c.w] = { distance: f.distance + p, predecessor: c.v }, i = true);
  }, u = function() {
    a.forEach(function(c) {
      r(c).forEach(function(f) {
        let h = f.v === c ? f.v : f.w, p = h === f.v ? f.w : f.v;
        l({ v: h, w: p });
      });
    });
  };
  a.forEach(function(c) {
    let f = c === n ? 0 : Number.POSITIVE_INFINITY;
    o[c] = { distance: f, predecessor: "" };
  });
  let d = a.length;
  for (let c = 1;c < d && (i = false, s++, u(), !!i); c++)
    ;
  if (s === d - 1 && (i = false, u(), i))
    throw new Error("The graph contains a negative weight cycle");
  return o;
}
function Xn(e) {
  let n = {}, t = [], r;
  function o(i) {
    var s, a;
    i in n || (n[i] = true, r.push(i), (s = e.successors(i)) == null || s.forEach(o), (a = e.predecessors(i)) == null || a.forEach(o));
  }
  return e.nodes().forEach(function(i) {
    r = [], o(i), r.length && t.push(r);
  }), t;
}
var Pe = class {
  constructor() {
    this._arr = [], this._keyIndices = {};
  }
  size() {
    return this._arr.length;
  }
  keys() {
    return this._arr.map((e) => e.key);
  }
  has(e) {
    return e in this._keyIndices;
  }
  priority(e) {
    let n = this._keyIndices[e];
    if (n !== undefined)
      return this._arr[n].priority;
  }
  min() {
    if (this.size() === 0)
      throw new Error("Queue underflow");
    return this._arr[0].key;
  }
  add(e, n) {
    let t = this._keyIndices, r = String(e);
    if (!(r in t)) {
      let o = this._arr, i = o.length;
      return t[r] = i, o.push({ key: r, priority: n }), this._decrease(i), true;
    }
    return false;
  }
  removeMin() {
    if (this.size() === 0)
      throw new Error("Queue underflow");
    this._swap(0, this._arr.length - 1);
    let e = this._arr.pop();
    return delete this._keyIndices[e.key], this._heapify(0), e.key;
  }
  decrease(e, n) {
    let t = this._keyIndices[e];
    if (t === undefined)
      throw new Error(`Key not found: ${e}`);
    let r = this._arr[t].priority;
    if (n > r)
      throw new Error(`New priority is greater than current priority. Key: ${e} Old: ${r} New: ${n}`);
    this._arr[t].priority = n, this._decrease(t);
  }
  _heapify(e) {
    let n = this._arr, t = 2 * e, r = t + 1, o = e;
    t < n.length && (o = n[t].priority < n[o].priority ? t : o, r < n.length && (o = n[r].priority < n[o].priority ? r : o), o !== e && (this._swap(e, o), this._heapify(o)));
  }
  _decrease(e) {
    let n = this._arr, t = n[e].priority, r;
    for (;e !== 0 && (r = e >> 1, !(n[r].priority < t)); )
      this._swap(e, r), e = r;
  }
  _swap(e, n) {
    let t = this._arr, r = this._keyIndices, o = t[e], i = t[n];
    t[e] = i, t[n] = o, r[i.key] = e, r[o.key] = n;
  }
};
var zn = () => 1;
function J(e, n, t, r) {
  let o = function(i) {
    var s;
    return (s = e.outEdges(i)) != null ? s : [];
  };
  return Hn(e, String(n), t || zn, r || o);
}
function Hn(e, n, t, r) {
  let o = {}, i = new Pe, s, a, l = function(u) {
    let d = u.v !== s ? u.v : u.w, c = o[d];
    if (!c)
      return;
    let f = t(u), h = a.distance + f;
    if (f < 0)
      throw new Error("dijkstra does not allow negative edge weights. Bad edge: " + u + " Weight: " + f);
    h < c.distance && (c.distance = h, c.predecessor = s, i.decrease(d, h));
  };
  for (e.nodes().forEach(function(u) {
    let d = u === n ? 0 : Number.POSITIVE_INFINITY;
    o[u] = { distance: d, predecessor: "" }, i.add(u, d);
  });i.size() > 0; ) {
    s = i.removeMin();
    let u = o[s];
    if (!u || u.distance === Number.POSITIVE_INFINITY)
      break;
    a = u, r(s).forEach(l);
  }
  return o;
}
function qn(e, n, t) {
  return e.nodes().reduce(function(r, o) {
    return r[o] = J(e, o, n, t), r;
  }, {});
}
function Fe(e) {
  let n = 0, t = [], r = {}, o = [];
  function i(s) {
    var a;
    let l = r[s] = { onStack: true, lowlink: n, index: n++ };
    if (t.push(s), (a = e.successors(s)) == null || a.forEach(function(u) {
      if (u in r) {
        let d = r[u];
        d != null && d.onStack && (l.lowlink = Math.min(l.lowlink, d.index));
      } else {
        i(u);
        let d = r[u];
        d && (l.lowlink = Math.min(l.lowlink, d.lowlink));
      }
    }), l.lowlink === l.index) {
      let u = [], d;
      do {
        d = t.pop();
        let c = r[d];
        c && (c.onStack = false), u.push(d);
      } while (s !== d);
      o.push(u);
    }
  }
  return e.nodes().forEach(function(s) {
    s in r || i(s);
  }), o;
}
function $n(e) {
  return Fe(e).filter(function(n) {
    var t;
    let r = n[0];
    return r ? n.length > 1 || n.length === 1 && ((t = e.outEdges(r, r)) != null ? t : []).length > 0 : false;
  });
}
var Un = () => 1;
function Jn(e, n, t) {
  return Kn(e, n || Un, t || function(r) {
    var o;
    return (o = e.outEdges(r)) != null ? o : [];
  });
}
function Kn(e, n, t) {
  let r = {}, o = e.nodes();
  return o.forEach(function(i) {
    let s = {};
    r[i] = s, s[i] = { distance: 0, predecessor: "" }, o.forEach(function(a) {
      i !== a && (s[a] = { distance: Number.POSITIVE_INFINITY, predecessor: "" });
    }), t(i).forEach(function(a) {
      let l = a.v === i ? a.w : a.v, u = n(a);
      s[l] = { distance: u, predecessor: i };
    });
  }), o.forEach(function(i) {
    let s = r[i];
    s && o.forEach(function(a) {
      let l = r[a];
      l && o.forEach(function(u) {
        let d = l[i], c = s[u], f = l[u];
        if (d && c && f) {
          let h = d.distance + c.distance;
          h < f.distance && (f.distance = h, f.predecessor = c.predecessor);
        }
      });
    });
  }), r;
}
var K = class extends Error {
  constructor(e) {
    super(e), this.name = "CycleException";
  }
};
function Ae(e) {
  let n = {}, t = {}, r = [];
  function o(i) {
    var s;
    if (i in t)
      throw new K;
    i in n || (t[i] = true, n[i] = true, (s = e.predecessors(i)) == null || s.forEach(o), delete t[i], r.push(i));
  }
  if (e.sinks().forEach(o), Object.keys(n).length !== e.nodeCount())
    throw new K;
  return r;
}
function Qn(e) {
  try {
    Ae(e);
  } catch (n) {
    if (n instanceof K)
      return false;
    throw n;
  }
  return true;
}
function Zn(e, n, t, r, o) {
  Array.isArray(n) || (n = [n]);
  let i = (a) => {
    var l;
    return (l = e.isDirected() ? e.successors(a) : e.neighbors(a)) != null ? l : [];
  }, s = {};
  return n.forEach(function(a) {
    if (!e.hasNode(a))
      throw new Error("Graph does not have node: " + a);
    o = Ve(e, a, t === "post", s, i, r, o);
  }), o;
}
function Ve(e, n, t, r, o, i, s) {
  return n in r || (r[n] = true, t || (s = i(s, n)), o(n).forEach(function(a) {
    s = Ve(e, a, t, r, o, i, s);
  }), t && (s = i(s, n))), s;
}
function De(e, n, t) {
  return Zn(e, n, t, function(r, o) {
    return r.push(o), r;
  }, []);
}
function et(e, n) {
  return De(e, n, "post");
}
function nt(e, n) {
  return De(e, n, "pre");
}
function tt(e, n) {
  var t;
  let r = new Q, o = {}, i = new Pe, s;
  function a(d) {
    let c = d.v === s ? d.w : d.v, f = i.priority(c);
    if (f !== undefined) {
      let h = n(d);
      h < f && (o[c] = s, i.decrease(c, h));
    }
  }
  if (e.nodeCount() === 0)
    return r;
  e.nodes().forEach(function(d) {
    i.add(d, Number.POSITIVE_INFINITY), r.setNode(d);
  });
  let l = e.nodes()[0];
  l !== undefined && i.decrease(l, 0);
  let u = false;
  for (;i.size() > 0; ) {
    if (s = i.removeMin(), s in o)
      r.setEdge(s, o[s]);
    else {
      if (u)
        throw new Error("Input graph is not connected: " + e);
      u = true;
    }
    (t = e.nodeEdges(s)) == null || t.forEach(a);
  }
  return r;
}
function rt(e, n, t, r) {
  return ot(e, n, t, r != null ? r : (o) => {
    var i;
    return (i = e.outEdges(o)) != null ? i : [];
  });
}
function ot(e, n, t, r) {
  if (t === undefined)
    return J(e, n, t, r);
  let o = false, i = e.nodes();
  for (let s = 0;s < i.length; s++) {
    let a = i[s];
    if (a === undefined)
      continue;
    let l = r(a);
    for (let u = 0;u < l.length; u++) {
      let d = l[u];
      if (!d)
        continue;
      let c = d.v === a ? d.v : d.w, f = c === d.v ? d.w : d.v;
      t({ v: c, w: f }) < 0 && (o = true);
    }
    if (o)
      return Me(e, n, t, r);
  }
  return J(e, n, t, r);
}
var T = Q;
function M(e, n, t, r) {
  let o = r;
  for (;e.hasNode(o); )
    o = $(r);
  return t.dummy = n, e.setNode(o, t), o;
}
function Ye(e) {
  let n = new T().setGraph(e.graph());
  return e.nodes().forEach((t) => n.setNode(t, e.node(t))), e.edges().forEach((t) => {
    let r = n.edge(t.v, t.w) || { weight: 0, minlen: 1 }, o = e.edge(t);
    n.setEdge(t.v, t.w, { weight: r.weight + o.weight, minlen: Math.max(r.minlen, o.minlen) });
  }), n;
}
function Z(e) {
  let n = new T({ multigraph: e.isMultigraph() }).setGraph(e.graph());
  return e.nodes().forEach((t) => {
    e.children(t).length || n.setNode(t, e.node(t));
  }), e.edges().forEach((t) => {
    n.setEdge(t, e.edge(t));
  }), n;
}
function se(e, n) {
  let { x: t, y: r } = e, o = n.x - t, i = n.y - r, s = e.width / 2, a = e.height / 2;
  if (!o && !i)
    throw new Error("Not possible to find intersection inside of the rectangle");
  let l, u;
  return Math.abs(i) * s > Math.abs(o) * a ? (i < 0 && (a = -a), l = a * o / i, u = a) : (o < 0 && (s = -s), l = s, u = s * i / o), { x: t + l, y: r + u };
}
function P(e) {
  let n = A(de(e) + 1).map(() => []);
  return e.nodes().forEach((t) => {
    let r = e.node(t), o = r.rank;
    o !== undefined && (n[o] || (n[o] = []), n[o][r.order] = t);
  }), n;
}
function We(e) {
  let n = e.nodes().map((r) => {
    let o = e.node(r).rank;
    return o === undefined ? Number.MAX_VALUE : o;
  }), t = R(Math.min, n);
  e.nodes().forEach((r) => {
    let o = e.node(r);
    Object.hasOwn(o, "rank") && (o.rank -= t);
  });
}
function Be(e) {
  let n = e.nodes().map((s) => e.node(s).rank).filter((s) => s !== undefined), t = R(Math.min, n), r = [];
  e.nodes().forEach((s) => {
    let a = e.node(s).rank - t;
    r[a] || (r[a] = []), r[a].push(s);
  });
  let o = 0, i = e.graph().nodeRankFactor;
  Array.from(r).forEach((s, a) => {
    s === undefined && a % i !== 0 ? --o : s !== undefined && o && s.forEach((l) => e.node(l).rank += o);
  });
}
function ae(e, n, t, r) {
  let o = { width: 0, height: 0 };
  return arguments.length >= 4 && (o.rank = t, o.order = r), M(e, "border", o, n);
}
function it(e, n = Xe) {
  let t = [];
  for (let r = 0;r < e.length; r += n) {
    let o = e.slice(r, r + n);
    t.push(o);
  }
  return t;
}
var Xe = 65535;
function R(e, n) {
  if (n.length > Xe) {
    let t = it(n);
    return e(...t.map((r) => e(...r)));
  } else
    return e(...n);
}
function de(e) {
  let t = e.nodes().map((r) => {
    let o = e.node(r).rank;
    return o === undefined ? Number.MIN_VALUE : o;
  });
  return R(Math.max, t);
}
function ze(e, n) {
  let t = { lhs: [], rhs: [] };
  return e.forEach((r) => {
    n(r) ? t.lhs.push(r) : t.rhs.push(r);
  }), t;
}
function q(e, n) {
  return n();
}
var st = 0;
function $(e) {
  let n = ++st;
  return e + ("" + n);
}
function A(e, n, t = 1) {
  n == null && (n = e, e = 0);
  let r = (i) => i < n;
  t < 0 && (r = (i) => n < i);
  let o = [];
  for (let i = e;r(i); i += t)
    o.push(i);
  return o;
}
function B(e, n) {
  let t = {};
  for (let r of n)
    e[r] !== undefined && (t[r] = e[r]);
  return t;
}
function X(e, n) {
  let t;
  return typeof n == "string" ? t = (r) => r[n] : t = n, Object.entries(e).reduce((r, [o, i]) => (r[o] = t(i, o), r), {});
}
function He(e, n) {
  return e.reduce((t, r, o) => (t[r] = n[o], t), {});
}
var D = "\x00";
function ee(e, n, t) {
  var u, d, c, f, h, p;
  if (!(e && n && t && n.dummy === "edge" && t.dummy === "edge" && n.edgeObj && t.edgeObj && e[n.edgeObj.v] && e[t.edgeObj.v] && e[n.edgeObj.w] && e[t.edgeObj.w]))
    return 0;
  let r = true;
  n.edgeObj.w === t.edgeObj.w && (r = false);
  let o = r ? (d = (u = e[n.edgeObj.v]) == null ? undefined : u.rank) != null ? d : NaN + 1 : (f = (c = e[n.edgeObj.w]) == null ? undefined : c.rank) != null ? f : NaN - 1, i = Object.entries(e).find((E) => {
    var y, L;
    return ((y = E[1].edgeObj) == null ? undefined : y.v) === n.edgeObj.v && ((L = E[1].edgeObj) == null ? undefined : L.w) === n.edgeObj.w && E[1].rank === o;
  }), s = Object.entries(e).find((E) => {
    var y, L;
    return ((y = E[1].edgeObj) == null ? undefined : y.v) === t.edgeObj.v && ((L = E[1].edgeObj) == null ? undefined : L.w) === t.edgeObj.w && E[1].rank === o;
  });
  if (!i || !s)
    return 0;
  let a = (h = i[1].order) != null ? h : NaN, l = (p = s[1].order) != null ? p : NaN;
  return isNaN(a - l) ? 0 : a - l;
}
var ce = class {
  constructor() {
    je(this, "_sentinel");
    let n = {};
    n._next = n._prev = n, this._sentinel = n;
  }
  dequeue() {
    let n = this._sentinel, t = n._prev;
    if (t !== n)
      return qe(t), t;
  }
  enqueue(n) {
    let t = this._sentinel;
    n._prev && n._next && qe(n), n._next = t._next, t._next._prev = n, t._next = n, n._prev = t;
  }
  toString() {
    let n = [], t = this._sentinel, r = t._prev;
    for (;r !== t; )
      n.push(JSON.stringify(r, at)), r = r._prev;
    return "[" + n.join(", ") + "]";
  }
};
function qe(e) {
  e._prev._next = e._next, e._next._prev = e._prev, delete e._next, delete e._prev;
}
function at(e, n) {
  if (e !== "_next" && e !== "_prev")
    return n;
}
var $e = ce;
var dt = () => 1;
function be(e, n) {
  if (e.nodeCount() <= 1)
    return [];
  let t = ut(e, n || dt);
  return lt(t.graph, t.buckets, t.zeroIdx).flatMap((o) => e.outEdges(o.v, o.w) || []);
}
function lt(e, n, t) {
  var a;
  let r = [], o = n[n.length - 1], i = n[0], s;
  for (;e.nodeCount(); ) {
    for (;s = i.dequeue(); )
      fe(e, n, t, s);
    for (;s = o.dequeue(); )
      fe(e, n, t, s);
    if (e.nodeCount()) {
      for (let l = n.length - 2;l > 0; --l)
        if (s = (a = n[l]) == null ? undefined : a.dequeue(), s) {
          r = r.concat(fe(e, n, t, s, true) || []);
          break;
        }
    }
  }
  return r;
}
function fe(e, n, t, r, o) {
  let i = [], s = o ? i : undefined;
  return (e.inEdges(r.v) || []).forEach((a) => {
    let l = e.edge(a), u = e.node(a.v);
    o && i.push({ v: a.v, w: a.w }), u.out -= l, he(n, t, u);
  }), (e.outEdges(r.v) || []).forEach((a) => {
    let l = e.edge(a), u = a.w, d = e.node(u);
    d.in -= l, he(n, t, d);
  }), e.removeNode(r.v), s;
}
function ut(e, n) {
  let t = new T, r = 0, o = 0;
  e.nodes().forEach((a) => {
    t.setNode(a, { v: a, in: 0, out: 0 });
  }), e.edges().forEach((a) => {
    let l = t.edge(a.v, a.w) || 0, u = n(a), d = l + u;
    t.setEdge(a.v, a.w, d);
    let c = t.node(a.v), f = t.node(a.w);
    o = Math.max(o, c.out += u), r = Math.max(r, f.in += u);
  });
  let i = ct(o + r + 3).map(() => new $e), s = r + 1;
  return t.nodes().forEach((a) => {
    he(i, s, t.node(a));
  }), { graph: t, buckets: i, zeroIdx: s };
}
function he(e, n, t) {
  var r, o, i;
  t.out ? t.in ? (i = e[t.out - t.in + n]) == null || i.enqueue(t) : (o = e[e.length - 1]) == null || o.enqueue(t) : (r = e[0]) == null || r.enqueue(t);
}
function ct(e) {
  let n = [];
  for (let t = 0;t < e; t++)
    n.push(t);
  return n;
}
function Ue(e, n) {
  (e.graph().acyclicer === "greedy" ? be(e, r(e)) : ft(e, n != null ? n : null)).forEach((o) => {
    let i = e.edge(o);
    e.removeEdge(o), i.forwardName = o.name, i.reversed = true, e.setEdge(o.w, o.v, i, $("rev"));
  });
  function r(o) {
    return (i) => o.edge(i).weight;
  }
}
function ft(e, n) {
  let t = [], r = {}, o = {};
  function i(l) {
    Object.hasOwn(o, l) || (o[l] = true, r[l] = true, e.outEdges(l).forEach((u) => {
      Object.hasOwn(r, u.w) ? t.push(u) : i(u.w);
    }), delete r[l]);
  }
  function s(l) {
    var u;
    Object.hasOwn(o, l) || (o[l] = true, r[l] = true, (u = e.outEdges(l)) == null || u.forEach((d) => {
      var c, f;
      Object.hasOwn(r, d.w) || ((c = n.node(l)) == null ? undefined : c.rank) > ((f = n.node(d.w)) == null ? undefined : f.rank) && ht(e, d.w, d) ? t.push(d) : s(d.w);
    }), delete r[l]);
  }
  let a = i;
  return n && typeof n.node == "function" && (a = s), e.sources().forEach(a), e.nodes().forEach(a), t;
}
function Je(e) {
  e.edges().forEach((n) => {
    let t = e.edge(n);
    if (t.reversed) {
      e.removeEdge(n);
      let r = t.forwardName;
      delete t.reversed, delete t.forwardName, e.setEdge(n.w, n.v, t, r);
    }
  });
}
function ht(e, n, t) {
  let r = new Set;
  function o(i) {
    var s;
    if (e.sources().includes(i))
      return true;
    r.add(i);
    for (let a of (s = e.inEdges(i)) != null ? s : [])
      if (!(a.v === t.v && a.w === t.w) && !r.has(a.v) && o(a.v))
        return true;
    return false;
  }
  return o(n);
}
function Ke(e) {
  e.graph().dummyChains = [], e.edges().forEach((n) => gt(e, n));
}
function gt(e, n) {
  let t = n.v, r = e.node(t).rank, o = n.w, i = e.node(o).rank, s = n.name, a = e.edge(n), l = a.labelRank;
  if (i === r + 1)
    return;
  e.removeEdge(n);
  let u, d, c;
  for (c = 0, ++r;r < i; ++c, ++r)
    a.points = [], d = { width: 0, height: 0, edgeLabel: a, edgeObj: n, rank: r }, u = M(e, "edge", d, "_d"), r === l && (d.width = a.width, d.height = a.height, d.dummy = "edge-label", d.labelpos = a.labelpos), e.setEdge(t, u, { weight: a.weight }, s), c === 0 && e.graph().dummyChains.push(u), t = u;
  e.setEdge(t, o, { weight: a.weight }, s);
}
function Qe(e) {
  e.graph().dummyChains.forEach((n) => {
    let t = e.node(n), r = t.edgeLabel, o;
    for (e.setEdge(t.edgeObj, r);t.dummy; )
      o = e.successors(n)[0], e.removeNode(n), r.points.push({ x: t.x, y: t.y }), t.dummy === "edge-label" && (r.x = t.x, r.y = t.y, r.width = t.width, r.height = t.height), n = o, t = e.node(n);
  });
}
function U(e) {
  let n = {};
  function t(r) {
    let o = e.node(r);
    if (Object.hasOwn(n, r))
      return o.rank;
    n[r] = true;
    let i = e.outEdges(r), s = i ? i.map((l) => l == null ? Number.POSITIVE_INFINITY : t(l.w) - e.edge(l).minlen) : [], a = R(Math.min, s);
    return a === Number.POSITIVE_INFINITY && (a = 0), o.rank = a;
  }
  e.sources().forEach(t);
}
function V(e, n) {
  return e.node(n.w).rank - e.node(n.v).rank - e.edge(n).minlen;
}
var ne = mt;
function mt(e) {
  let n = new T({ directed: false }), t = e.nodes();
  if (t.length === 0)
    throw new Error("Graph must have at least one node");
  let r = t[0], o = e.nodeCount();
  n.setNode(r, {});
  let i, s;
  for (;Et(n, e) < o && (i = Lt(n, e), !!i); )
    s = n.hasNode(i.v) ? V(e, i) : -V(e, i), yt(n, e, s);
  return n;
}
function Et(e, n) {
  function t(r) {
    let o = n.nodeEdges(r);
    o && o.forEach((i) => {
      let s = i.v, a = r === s ? i.w : s;
      !e.hasNode(a) && !V(n, i) && (e.setNode(a, {}), e.setEdge(r, a, {}), t(a));
    });
  }
  return e.nodes().forEach(t), e.nodeCount();
}
function Lt(e, n) {
  return n.edges().reduce((r, o) => {
    let i = Number.POSITIVE_INFINITY;
    return e.hasNode(o.v) !== e.hasNode(o.w) && (i = V(n, o)), i < r[0] ? [i, o] : r;
  }, [Number.POSITIVE_INFINITY, null])[1];
}
function yt(e, n, t) {
  e.nodes().forEach((r) => n.node(r).rank += t);
}
var { preorder: wt, postorder: Nt } = H;
var en = Y;
Y.initLowLimValues = pe;
Y.initCutValues = ge;
Y.calcCutValue = nn;
Y.leaveEdge = rn;
Y.enterEdge = on;
Y.exchangeEdges = sn;
function Y(e) {
  e = Ye(e), U(e);
  let n = ne(e);
  pe(n), ge(n, e);
  let t, r;
  for (;t = rn(n); )
    r = on(n, e, t), sn(n, e, t, r);
}
function ge(e, n) {
  let t = Nt(e, e.nodes());
  t = t.slice(0, t.length - 1), t.forEach((r) => Gt(e, n, r));
}
function Gt(e, n, t) {
  let o = e.node(t).parent, i = e.edge(t, o);
  i.cutvalue = nn(e, n, t);
}
function nn(e, n, t) {
  let o = e.node(t).parent, i = true, s = n.edge(t, o), a = 0;
  s || (i = false, s = n.edge(o, t)), a = s.weight;
  let l = n.nodeEdges(t);
  return l && l.forEach((u) => {
    let d = u.v === t, c = d ? u.w : u.v;
    if (c !== o) {
      let f = d === i, h = n.edge(u).weight;
      if (a += f ? h : -h, kt(e, t, c)) {
        let E = e.edge(t, c).cutvalue;
        a += f ? -E : E;
      }
    }
  }), a;
}
function pe(e, n) {
  arguments.length < 2 && (n = e.nodes()[0]), tn(e, {}, 1, n);
}
function tn(e, n, t, r, o) {
  let i = t, s = e.node(r);
  n[r] = true;
  let a = e.neighbors(r);
  return a && a.forEach((l) => {
    Object.hasOwn(n, l) || (t = tn(e, n, t, l, r));
  }), s.low = i, s.lim = t++, o ? s.parent = o : delete s.parent, t;
}
function rn(e) {
  return e.edges().find((n) => e.edge(n).cutvalue < 0);
}
function on(e, n, t) {
  let { v: r, w: o } = t;
  n.hasEdge(r, o) || (r = t.w, o = t.v);
  let i = e.node(r), s = e.node(o), a = i, l = false;
  return i.lim > s.lim && (a = s, l = true), n.edges().filter((d) => l === Ze(e, e.node(d.v), a) && l !== Ze(e, e.node(d.w), a)).reduce((d, c) => V(n, c) < V(n, d) ? c : d);
}
function sn(e, n, t, r) {
  let { v: o, w: i } = t;
  e.removeEdge(o, i), e.setEdge(r.v, r.w, {}), pe(e), ge(e, n), vt(e, n);
}
function vt(e, n) {
  let t = e.nodes().find((o) => !e.node(o).parent);
  if (!t)
    return;
  let r = wt(e, [t]);
  r = r.slice(1), r.forEach((o) => {
    let s = e.node(o).parent, a = n.edge(o, s), l = false;
    a || (a = n.edge(s, o), l = true), n.node(o).rank = n.node(s).rank + (l ? a.minlen : -a.minlen);
  });
}
function kt(e, n, t) {
  return e.hasEdge(n, t);
}
function Ze(e, n, t) {
  return t.low <= n.lim && n.lim <= t.lim;
}
var dn = xt;
function xt(e) {
  let n = e.graph().ranker;
  if (typeof n == "function")
    return n(e);
  switch (n) {
    case "network-simplex":
      an(e);
      break;
    case "tight-tree":
      Ot(e);
      break;
    case "longest-path":
      _t(e);
      break;
    case "none":
      break;
    default:
      an(e);
  }
}
var _t = U;
function Ot(e) {
  U(e), ne(e);
}
function an(e) {
  en(e);
}
var ln = Ct;
function Ct(e) {
  let n = jt(e), t = e.graph();
  if (!Array.isArray(t.dummyChains))
    return;
  t.dummyChains.forEach((o) => {
    let i = e.node(o), s = i.edgeObj, a = Tt(e, n, s.v, s.w), { path: l, lca: u } = a, d = 0, c = l[d], f = true;
    for (;o !== s.w; ) {
      if (i = e.node(o), f) {
        for (;(c = l[d]) !== u && e.node(c).maxRank < i.rank; )
          d++;
        c === u && (f = false);
      }
      if (!f) {
        for (;d < l.length - 1 && e.node(l[d + 1]).minRank <= i.rank; )
          d++;
        c = l[d];
      }
      c !== undefined && e.setParent(o, c), o = e.successors(o)[0];
    }
  });
}
function Tt(e, n, t, r) {
  let o = [], i = [], s = Math.min(n[t].low, n[r].low), a = Math.max(n[t].lim, n[r].lim), l;
  l = t;
  do
    l = e.parent(l), o.push(l);
  while (l && (n[l].low > s || a > n[l].lim));
  let u = l, d = r;
  for (;(d = e.parent(d)) !== u; )
    i.push(d);
  return { path: o.concat(i.reverse()), lca: u };
}
function jt(e) {
  let n = {}, t = 0;
  function r(o) {
    let i = t;
    e.children(o).forEach(r), n[o] = { low: i, lim: t++ };
  }
  return e.children(D).forEach(r), n;
}
function un(e) {
  let n = M(e, "root", {}, "_root"), t = Rt(e), r = Object.values(t), o = R(Math.max, r) - 1, i = 2 * o + 1;
  e.graph().nestingRoot = n, e.edges().forEach((a) => e.edge(a).minlen *= i);
  let s = It(e) + 1;
  e.children(D).forEach((a) => {
    cn(e, n, i, s, o, t, a);
  }), e.graph().nodeRankFactor = i;
}
function cn(e, n, t, r, o, i, s) {
  var c;
  let a = e.children(s);
  if (!a.length) {
    s !== n && e.setEdge(n, s, { weight: 0, minlen: t });
    return;
  }
  let l = ae(e, "_bt"), u = ae(e, "_bb"), d = e.node(s);
  e.setParent(l, s), d.borderTop = l, e.setParent(u, s), d.borderBottom = u, a.forEach((f) => {
    var b;
    cn(e, n, t, r, o, i, f);
    let h = e.node(f), p = h.borderTop ? h.borderTop : f, E = h.borderBottom ? h.borderBottom : f, y = h.borderTop ? r : 2 * r, L = p !== E ? 1 : o - ((b = i[s]) != null ? b : 0) + 1;
    e.setEdge(l, p, { weight: y, minlen: L, nestingEdge: true }), e.setEdge(E, u, { weight: y, minlen: L, nestingEdge: true });
  }), e.parent(s) || e.setEdge(n, l, { weight: 0, minlen: o + ((c = i[s]) != null ? c : 0) });
}
function Rt(e) {
  let n = {};
  function t(r, o) {
    let i = e.children(r);
    i && i.length && i.forEach((s) => t(s, o + 1)), n[r] = o;
  }
  return e.children(D).forEach((r) => t(r, 1)), n;
}
function It(e) {
  return e.edges().reduce((n, t) => n + e.edge(t).weight, 0);
}
function fn(e) {
  let n = e.graph();
  e.removeNode(n.nestingRoot), delete n.nestingRoot, e.edges().forEach((t) => {
    e.edge(t).nestingEdge && e.removeEdge(t);
  });
}
var bn = Mt;
function Mt(e) {
  function n(t) {
    let r = e.children(t), o = e.node(t);
    if (r.length && r.forEach(n), o && Object.hasOwn(o, "minRank")) {
      o.borderLeft = [], o.borderRight = [];
      for (let i = o.minRank, s = o.maxRank + 1;i < s; ++i)
        hn(e, "borderLeft", "_bl", t, o, i), hn(e, "borderRight", "_br", t, o, i);
    }
  }
  e.children(D).forEach(n);
}
function hn(e, n, t, r, o, i) {
  let s = { width: 0, height: 0, rank: i, borderType: n }, a = o[n][i - 1], l = M(e, "border", s, t);
  o[n][i] = l, e.setParent(l, r), a && e.setEdge(a, l, { weight: 1 });
}
function pn(e) {
  var t;
  let n = (t = e.graph().rankdir) == null ? undefined : t.toLowerCase();
  (n === "lr" || n === "rl") && En(e);
}
function mn(e) {
  var t;
  let n = (t = e.graph().rankdir) == null ? undefined : t.toLowerCase();
  (n === "bt" || n === "rl") && Pt(e), (n === "lr" || n === "rl") && (Ft(e), En(e));
}
function En(e) {
  e.nodes().forEach((n) => gn(e.node(n))), e.edges().forEach((n) => gn(e.edge(n)));
}
function gn(e) {
  let n = e.width;
  e.width = e.height, e.height = n;
}
function Pt(e) {
  e.nodes().forEach((n) => me(e.node(n))), e.edges().forEach((n) => {
    var r;
    let t = e.edge(n);
    (r = t.points) == null || r.forEach(me), Object.hasOwn(t, "y") && me(t);
  });
}
function me(e) {
  e.y = -e.y;
}
function Ft(e) {
  e.nodes().forEach((n) => Ee(e.node(n))), e.edges().forEach((n) => {
    var r;
    let t = e.edge(n);
    (r = t.points) == null || r.forEach(Ee), Object.hasOwn(t, "x") && Ee(t);
  });
}
function Ee(e) {
  let n = e.x;
  e.x = e.y, e.y = n;
}
function Le(e, n = null) {
  let t = {}, r = e.nodes().filter((d) => !e.children(d).length), o = r.map((d) => e.node(d).rank), i = R(Math.max, o), s = A(i + 1).map(() => []);
  function a(d) {
    if (t[d])
      return;
    t[d] = true;
    let c = e.node(d);
    s[c.rank].push(d);
    let f = e.successors(d);
    f && [...f].sort((p, E) => u(p, E)).forEach(a);
  }
  r.sort((d, c) => e.node(d).rank - e.node(c).rank).forEach(a);
  function u(d, c) {
    let f = e.node(d), h = e.node(c);
    return ee(n, f, h);
  }
  return s;
}
function ye(e, n) {
  let t = 0;
  for (let r = 1;r < n.length; ++r)
    t += Vt(e, n[r - 1], n[r]);
  return t;
}
function Vt(e, n, t) {
  let r = He(t, t.map((u, d) => d)), o = n.flatMap((u) => {
    let d = e.outEdges(u);
    return d ? d.map((c) => ({ pos: r[c.w], weight: e.edge(c).weight })).sort((c, f) => c.pos - f.pos) : [];
  }), i = 1;
  for (;i < t.length; )
    i <<= 1;
  let s = 2 * i - 1;
  i -= 1;
  let a = new Array(s).fill(0), l = 0;
  return o.forEach((u) => {
    let d = u.pos + i;
    a[d] += u.weight;
    let c = 0;
    for (;d > 0; )
      d % 2 && (c += a[d + 1]), d = d - 1 >> 1, a[d] += u.weight;
    l += u.weight * c;
  }), l;
}
function we(e, n = []) {
  return n.map((t) => {
    let r = e.inEdges(t);
    if (!r || !r.length)
      return { v: t };
    {
      let o = r.reduce((i, s) => {
        let a = e.edge(s), l = e.node(s.v);
        return { sum: i.sum + a.weight * l.order, weight: i.weight + a.weight };
      }, { sum: 0, weight: 0 });
      return { v: t, barycenter: o.sum / o.weight, weight: o.weight };
    }
  });
}
function Ne(e, n) {
  let t = {};
  e.forEach((o, i) => {
    let s = { indegree: 0, in: [], out: [], vs: [o.v], i };
    o.barycenter !== undefined && (s.barycenter = o.barycenter, s.weight = o.weight), t[o.v] = s;
  }), n.edges().forEach((o) => {
    let i = t[o.v], s = t[o.w];
    i !== undefined && s !== undefined && (s.indegree++, i.out.push(s));
  });
  let r = Object.values(t).filter((o) => !o.indegree);
  return Dt(r);
}
function Dt(e) {
  let n = [];
  function t(o) {
    return (i) => {
      i.merged || (i.barycenter === undefined || o.barycenter === undefined || i.barycenter >= o.barycenter) && Yt(o, i);
    };
  }
  function r(o) {
    return (i) => {
      i.in.push(o), --i.indegree === 0 && e.push(i);
    };
  }
  for (;e.length; ) {
    let o = e.pop();
    n.push(o), o.in.reverse().forEach(t(o)), o.out.forEach(r(o));
  }
  return n.filter((o) => !o.merged).map((o) => B(o, ["vs", "i", "barycenter", "weight"]));
}
function Yt(e, n) {
  let t = 0, r = 0;
  e.weight && (t += e.barycenter * e.weight, r += e.weight), n.weight && (t += n.barycenter * n.weight, r += n.weight), e.vs = n.vs.concat(e.vs), e.barycenter = t / r, e.weight = r, e.i = Math.min(n.i, e.i), n.merged = true;
}
function Ge(e, n, t, r, o) {
  let i = {}, s = null, a = null, l = o;
  typeof n == "boolean" ? (l = n, i = {}) : n && (i = n, s = t != null ? t : null, a = r != null ? r : null);
  let u = ze(e, (L) => Object.hasOwn(L, "barycenter")), d = u.lhs, c = u.rhs.sort((L, b) => b.i - L.i), f = [], h = 0, p = 0, E = 0;
  d.sort(Wt(a, s, !!l));
  for (let [L, b] of Object.entries(i)) {
    let g = d.findIndex((m) => m.vs[0] === L);
    d.splice(g + 1, 0, b);
  }
  E = Ln(f, c, E), d.forEach((L) => {
    E += L.vs.length, f.push(L.vs), h += L.barycenter * L.weight, p += L.weight, E = Ln(f, c, E);
  });
  let y = { vs: f.flat(1) };
  return p && (y.barycenter = h / p, y.weight = p), y;
}
function Ln(e, n, t) {
  let r;
  for (;n.length && (r = n[n.length - 1]).i <= t; )
    n.pop(), e.push(r.vs), t++;
  return t;
}
function Wt(e, n, t) {
  return (r, o) => {
    if (r.barycenter < o.barycenter)
      return -1;
    if (r.barycenter > o.barycenter)
      return 1;
    if (e && (typeof r.vs[0] == "string" || typeof o.vs[0] == "string")) {
      let i = e.node(r.vs[0]), s = e.node(o.vs[0]), a = ee(n, i, s);
      if (a !== 0)
        return a;
    }
    return t ? o.i - r.i : r.i - o.i;
  };
}
function te(e, n, t, r, o) {
  var L, b, g, m, w, k, _, C, j, I, S;
  let i = null, s = o;
  typeof r == "boolean" ? (s = r, i = null) : r !== undefined && (i = r);
  let a = e.children(n), l = e.node(n), u = l ? l.borderLeft : undefined, d = l ? l.borderRight : undefined, c = {};
  u && (a = a.filter((G) => G !== u && G !== d));
  let f = we(e, a);
  f.forEach((G) => {
    if (e.children(G.v).length) {
      let { result: x } = te(e, G.v, t, i, s);
      c[G.v] = x, Object.hasOwn(x, "barycenter") && Xt(G, x);
    }
  });
  let h = Ne(f, t);
  Bt(h, c);
  let p = {}, E = false;
  for (let G = 0;G < h.length; G++)
    for (let x = G + 1;x < h.length; x++)
      if (!(!h[G] || !h[x] || !((L = h[G]) != null && L.barycenter) || !((b = h[x]) != null && b.barycenter)) && ((g = h[G]) == null ? undefined : g.barycenter) === h[x].barycenter) {
        let v = (w = (m = h[G]) == null ? undefined : m.vs[0]) != null ? w : "", N = (_ = (k = h[x]) == null ? undefined : k.vs[0]) != null ? _ : "", O = e.node(v), W = e.node(N);
        if (O.dummy === "edge" && W.dummy === "edge" && ((C = O.edgeObj) == null ? undefined : C.v) === ((j = W.edgeObj) == null ? undefined : j.v) && ((I = O.edgeObj) == null ? undefined : I.w) === ((S = W.edgeObj) == null ? undefined : S.w))
          if (O.edgeLabel.reversed) {
            p[N] = h[G], h.splice(G, 1), G--;
            break;
          } else
            p[v] = h[x], h.splice(x, 1), x--;
        else
          E = true;
      }
  let y = Ge(h, p, i, e, s);
  if (u && d) {
    y.vs = [u, y.vs, d].flat(1);
    let G = e.predecessors(u);
    if (G && G.length) {
      let x = e.node(G[0]), v = e.predecessors(d), N = e.node(v[0]);
      Object.hasOwn(y, "barycenter") || (y.barycenter = 0, y.weight = 0), y.barycenter = (y.barycenter * y.weight + x.order + N.order) / (y.weight + 2), y.weight += 2;
    }
  }
  return Object.defineProperty(y, "result", { value: y, enumerable: false, configurable: true, writable: true }), Object.defineProperty(y, "usedBias", { value: E, enumerable: false, configurable: true, writable: true }), y;
}
function Bt(e, n) {
  e.forEach((t) => {
    t.vs = t.vs.flatMap((r) => n[r] ? n[r].vs : r);
  });
}
function Xt(e, n) {
  e.barycenter !== undefined ? (e.barycenter = (e.barycenter * e.weight + n.barycenter * n.weight) / (e.weight + n.weight), e.weight += n.weight) : (e.barycenter = n.barycenter, e.weight = n.weight);
}
function ve(e, n, t, r) {
  r || (r = e.nodes());
  let o = zt(e), i = new T({ compound: true }).setGraph({ root: o }).setDefaultNodeLabel((s) => e.node(s));
  return r.forEach((s) => {
    let a = e.node(s), l = e.parent(s);
    if (a.rank === n || a.minRank <= n && n <= a.maxRank) {
      i.setNode(s), i.setParent(s, l || o);
      let u = e[t](s);
      u && u.forEach((d) => {
        let c = d.v === s ? d.w : d.v, f = i.edge(c, s), h = f !== undefined ? f.weight : 0;
        i.setEdge(c, s, { weight: e.edge(d).weight + h });
      }), Object.hasOwn(a, "minRank") && i.setNode(s, { borderLeft: a.borderLeft[n], borderRight: a.borderRight[n] });
    }
  }), i;
}
function zt(e) {
  let n;
  for (;e.hasNode(n = $("_root")); )
    ;
  return n;
}
function ke(e, n, t) {
  let r = {}, o;
  t.forEach((i) => {
    let s = e.parent(i), a, l;
    for (;s; ) {
      if (a = e.parent(s), a ? (l = r[a], r[a] = s) : (l = o, o = s), l && l !== s) {
        n.setEdge(l, s);
        return;
      }
      s = a;
    }
  });
}
function re(e, n = {}, t = null) {
  if (typeof n.customOrder == "function") {
    n.customOrder(e, re);
    return;
  }
  let r = de(e), o = yn(e, A(1, r + 1), "inEdges"), i = yn(e, A(r - 1, -1, -1), "outEdges"), s = Le(e, t);
  if (wn(e, s), n.disableOptimalOrderHeuristic)
    return;
  let a = Number.POSITIVE_INFINITY, l, u = n.constraints || [];
  for (let d = 0, c = 0;c < 4; ++d, ++c) {
    Ht(d % 2 ? o : i, d % 4 >= 2, u, t), s = P(e);
    let f = ye(e, s);
    f < a ? (c = 0, l = Object.assign({}, s), a = f) : f === a && (l = structuredClone(s));
  }
  wn(e, l);
}
function yn(e, n, t) {
  let r = new Map, o = (i, s) => {
    r.has(i) || r.set(i, []), r.get(i).push(s);
  };
  for (let i of e.nodes()) {
    let s = e.node(i);
    if (typeof s.rank == "number" && o(s.rank, i), typeof s.minRank == "number" && typeof s.maxRank == "number")
      for (let a = s.minRank;a <= s.maxRank; a++)
        a !== s.rank && o(a, i);
  }
  return n.map(function(i) {
    return ve(e, i, t, r.get(i) || []);
  });
}
function Ht(e, n, t, r) {
  let o = true, i = new T;
  e.forEach(function(s) {
    t.forEach((d) => i.setEdge(d.left, d.right));
    let a = s.graph().root, { result: l, usedBias: u } = te(s, a, i, r, o);
    n && u && (o = !o), l.vs.forEach((d, c) => s.node(d).order = c), ke(s, i, l.vs);
  });
}
function wn(e, n) {
  Object.values(n).forEach((t) => t.forEach((r, o) => e.node(r).order = o));
}
function qt(e, n) {
  let t = {};
  function r(o, i) {
    let s = 0, a = 0, l = o.length, u = i[i.length - 1];
    return i.forEach((d, c) => {
      let f = Ut(e, d), h = f ? e.node(f).order : l;
      (f || d === u) && (i.slice(a, c + 1).forEach((p) => {
        let E = e.predecessors(p);
        E && E.forEach((y) => {
          let L = e.node(y), b = L.order;
          (b < s || h < b) && !(L.dummy && e.node(p).dummy) && Gn(t, y, p);
        });
      }), a = c + 1, s = h);
    }), i;
  }
  return n.length && n.reduce(r), t;
}
function $t(e, n) {
  let t = {};
  function r(i, s, a, l, u) {
    A(s, a).forEach((d) => {
      let c = i[d];
      if (c !== undefined && e.node(c).dummy) {
        let f = e.predecessors(c);
        f && f.forEach((h) => {
          if (h === undefined)
            return;
          let p = e.node(h);
          p.dummy && (p.order < l || p.order > u) && Gn(t, h, c);
        });
      }
    });
  }
  function o(i, s) {
    let a = -1, l = -1, u = 0;
    return s.forEach((d, c) => {
      if (e.node(d).dummy === "border") {
        let f = e.predecessors(d);
        if (f && f.length) {
          let h = f[0];
          if (h === undefined)
            return;
          l = e.node(h).order, r(s, u, c, a, l), u = c, a = l;
        }
      }
      r(s, u, s.length, l, i.length);
    }), s;
  }
  return n.length && n.reduce(o), t;
}
function Ut(e, n) {
  if (e.node(n).dummy) {
    let t = e.predecessors(n);
    if (t)
      return t.find((r) => e.node(r).dummy);
  }
}
function Gn(e, n, t) {
  if (n > t) {
    let o = n;
    n = t, t = o;
  }
  let r = e[n];
  r || (e[n] = r = {}), r[t] = true;
}
function Jt(e, n, t) {
  if (n > t) {
    let o = n;
    n = t, t = o;
  }
  let r = e[n];
  return r !== undefined && Object.hasOwn(r, t);
}
function Kt(e, n, t, r, o) {
  let i = {}, s = {}, a = {};
  return n.forEach((l) => {
    l.forEach((u, d) => {
      i[u] = u, s[u] = u, a[u] = d;
    });
  }), n.forEach((l) => {
    let u = -1, d = -1, c = false, f = l, h = l.findIndex((p) => (o == null ? undefined : o.includes(p)) || Nn(p, e, o));
    h > 0 && (f = [l[h], ...l.slice(0, h), ...l.slice(h + 1)], c = true), f.forEach((p) => {
      var y;
      let E = r(p);
      if (E && E.length) {
        o != null && o.includes(p) && (E = E.filter((g) => Nn(g, e, o)));
        let L = E.sort((g, m) => {
          let w = a[g], k = a[m];
          return (w !== undefined ? w : 0) - (k !== undefined ? k : 0);
        }), b = (L.length - 1) / 2;
        for (let g = Math.floor(b), m = Math.ceil(b);g <= m; ++g) {
          let w = L[g];
          if (w === undefined)
            continue;
          let k = a[w];
          if (k !== undefined && s[p] === p && u < k && a[w] !== d && !Jt(t, p, w)) {
            let _ = i[w];
            _ !== undefined && (s[w] = p, s[p] = i[p] = _, u = k, c && (u = -1, d = (y = a[w]) != null ? y : -1, c = false));
          }
        }
      }
    });
  }), { root: i, align: s };
}
function Qt(e, n, t, r, o = false) {
  let i = {}, s = Zt(e, n, t, o), a = o ? "borderLeft" : "borderRight";
  function l(h, p) {
    let E = s.nodes().slice(), y = {}, L = E.pop();
    for (;L; ) {
      if (y[L])
        h(L);
      else {
        y[L] = true, E.push(L);
        for (let b of p(L))
          E.push(b);
      }
      L = E.pop();
    }
  }
  function u(h) {
    let p = s.inEdges(h);
    p ? i[h] = p.reduce((E, y) => {
      var g;
      let L = (g = i[y.v]) != null ? g : 0, b = s.edge(y);
      return Math.max(E, L + (b !== undefined ? b : 0));
    }, 0) : i[h] = 0;
  }
  function d(h) {
    let p = s.outEdges(h), E = Number.POSITIVE_INFINITY;
    p && (E = p.reduce((L, b) => {
      let g = i[b.w], m = s.edge(b);
      return Math.min(L, (g !== undefined ? g : 0) - (m !== undefined ? m : 0));
    }, Number.POSITIVE_INFINITY));
    let y = e.node(h);
    E !== Number.POSITIVE_INFINITY && y.borderType !== a && (i[h] = Math.max(i[h] !== undefined ? i[h] : 0, E));
  }
  function c(h) {
    return s.predecessors(h) || [];
  }
  function f(h) {
    return s.successors(h) || [];
  }
  return l(u, c), l(d, f), Object.keys(r).forEach((h) => {
    var E;
    let p = t[h];
    p !== undefined && (i[h] = (E = i[p]) != null ? E : 0);
  }), i;
}
function Zt(e, n, t, r) {
  let o = new T, i = e.graph(), s = rr(i.nodesep, i.edgesep, r);
  return n.forEach((a) => {
    let l;
    a.forEach((u) => {
      let d = t[u];
      if (d !== undefined) {
        if (o.setNode(d), l !== undefined) {
          let c = t[l];
          if (c !== undefined) {
            let f = o.edge(c, d);
            o.setEdge(c, d, Math.max(s(e, u, l), f || 0));
          }
        }
        l = u;
      }
    });
  }), o;
}
function er(e, n) {
  return Object.values(n).reduce((t, r) => {
    let { NEGATIVE_INFINITY: o, POSITIVE_INFINITY: i } = Number;
    Object.entries(r).forEach(([a, l]) => {
      let u = or(e, a) / 2;
      o = Math.max(l + u, o), i = Math.min(l - u, i);
    });
    let s = o - i;
    return s < t[0] && (t = [s, r]), t;
  }, [Number.POSITIVE_INFINITY, null])[1];
}
function nr(e, n) {
  let t = Object.values(n), r = R(Math.min, t), o = R(Math.max, t);
  ["u", "d"].forEach((i) => {
    ["l", "r"].forEach((s) => {
      let a = i + s, l = e[a];
      if (!l || l === n)
        return;
      let u = Object.values(l), d = r - R(Math.min, u);
      s !== "l" && (d = o - R(Math.max, u)), d && (e[a] = X(l, (c) => c + d));
    });
  });
}
function tr(e, n = undefined) {
  let t = e.ul;
  return t ? X(t, (r, o) => {
    var s, a;
    if (n) {
      let l = n.toLowerCase(), u = e[l];
      if (u && u[o] !== undefined)
        return u[o];
    }
    let i = Object.values(e).map((l) => {
      let u = l[o];
      return u !== undefined ? u : 0;
    }).sort((l, u) => l - u);
    return (((s = i[1]) != null ? s : 0) + ((a = i[2]) != null ? a : 0)) / 2;
  }) : {};
}
function vn(e, n) {
  let t = P(e), r = Object.assign(qt(e, t), $t(e, t)), o = {}, i;
  ["u", "d"].forEach((a) => {
    i = a === "u" ? t : Object.values(t).reverse(), ["l", "r"].forEach((l) => {
      l === "r" && (i = i.map((f) => Object.values(f).reverse()));
      let d = Kt(e, i, r, (f) => (a === "u" ? e.predecessors(f) : e.successors(f)) || [], n), c = Qt(e, i, d.root, d.align, l === "r");
      l === "r" && (c = X(c, (f) => -f)), o[a + l] = c;
    });
  });
  let s = er(e, o);
  return nr(o, s), tr(o, e.graph().align);
}
function rr(e, n, t) {
  return (r, o, i) => {
    let s = r.node(o), a = r.node(i), l = 0, u;
    if (l += s.width / 2, Object.hasOwn(s, "labelpos"))
      switch (s.labelpos.toLowerCase()) {
        case "l":
          u = -s.width / 2;
          break;
        case "r":
          u = s.width / 2;
          break;
      }
    if (u && (l += t ? u : -u), u = undefined, l += (s.dummy ? n : e) / 2, l += (a.dummy ? n : e) / 2, l += a.width / 2, Object.hasOwn(a, "labelpos"))
      switch (a.labelpos.toLowerCase()) {
        case "l":
          u = a.width / 2;
          break;
        case "r":
          u = -a.width / 2;
          break;
      }
    return u && (l += t ? u : -u), l;
  };
}
function or(e, n) {
  return e.node(n).width;
}
function Nn(e, n, t) {
  var s;
  if (!t)
    return false;
  let r = (s = n.node(e)) == null ? undefined : s.edgeObj;
  if (!r || n.node(e).edgeLabel.reversed)
    return false;
  let o = t.indexOf(r == null ? undefined : r.v), i = t.indexOf(r == null ? undefined : r.w);
  return o !== -1 && i !== -1 && o === (i + 1) % t.length || o === (i - 1) % t.length;
}
function kn(e, n) {
  e = Z(e), ir(e), Object.entries(vn(e, n)).forEach(([t, r]) => e.node(t).x = r);
}
function ir(e) {
  let n = P(e), t = e.graph(), { ranksep: r, rankalign: o } = t, i = 0;
  n.forEach((s) => {
    let a = s.reduce((l, u) => {
      var c;
      let d = (c = e.node(u).height) != null ? c : 0;
      return l > d ? l : d;
    }, 0);
    s.forEach((l) => {
      let u = e.node(l);
      o === "top" ? u.y = i + u.height / 2 : o === "bottom" ? u.y = i + a - u.height / 2 : u.y = i + a / 2;
    }), i += a + r;
  });
}
var xn = new WeakMap;
function Oe(e, n = {}) {
  return Rn(e, q, n), e;
}
function _n(e, n, t) {
  let r = n;
  for (;r !== undefined; ) {
    let o = e.parent(r);
    if (o === t)
      return r;
    r = o;
  }
}
function Rn(e, n, t) {
  var L;
  let r = e.nodes().filter((b) => e.children(b).length), o = {};
  r.forEach((b) => {
    let g = e.node(b);
    if (g && g.rankdir) {
      let m = new T({ multigraph: true, compound: true });
      m.setGraph({ rankdir: g.rankdir });
      let w = e.children(b);
      w.forEach((v) => {
        let N = { ...e.node(v) };
        m.setNode(v, N);
        let O = e.parent(v);
        O && O !== b && w.includes(O) && m.setParent(v, O);
      });
      let k = new Set;
      e.edges().forEach((v) => {
        let N = _n(e, v.v, b), O = _n(e, v.w, b);
        if (N && O && N !== O) {
          let W = `${N}\x00${O}`;
          k.has(W) || (k.add(W), m.setEdge(N, O, { ...e.edge(v) }));
        }
      }), Rn(m, n, t);
      let _ = jn(m);
      On(_, n, t, null), Cn(m, _);
      let C = 1 / 0, j = 1 / 0, I = -1 / 0, S = -1 / 0;
      m.nodes().forEach((v) => {
        if (v === b)
          return;
        let N = m.node(v);
        N && typeof N.x == "number" && typeof N.y == "number" && typeof N.width == "number" && typeof N.height == "number" && (C = Math.min(C, N.x - N.width / 2), I = Math.max(I, N.x + N.width / 2), j = Math.min(j, N.y - N.height / 2), S = Math.max(S, N.y + N.height / 2));
      }), (!isFinite(C) || !isFinite(j) || !isFinite(I) || !isFinite(S)) && (C = j = 0, I = S = 0);
      let G = I - C, x = S - j;
      o[b] = { minX: C, minY: j, maxX: I, maxY: S, width: G, height: x, offsetX: C, offsetY: j }, g._dagreClusterSubgraph = m;
    }
  });
  let i = [], s = (b) => {
    let g = [], m = (e.children(b) || []).filter((w) => w !== b);
    for (;m.length > 0; ) {
      let w = m.shift();
      g.push(w), (e.children(w) || []).filter((k) => k !== w).forEach((k) => m.push(k));
    }
    return g;
  }, a = new Map;
  r.forEach((b) => {
    let g = e.node(b);
    g && g.rankdir && o[b] && a.set(b, (e.children(b) || []).filter((m) => m !== b));
  });
  let l = new Set([...a.values()].flat()), u = new Map;
  a.forEach((b, g) => {
    l.has(g) || u.set(g, s(g));
  });
  let d = new Set([...u.values()].flat()), c = (b) => {
    for (let [g, m] of u)
      if (m.includes(b))
        return g;
    return b;
  }, f = [];
  e.edges().forEach((b) => {
    (d.has(b.v) || d.has(b.w)) && f.push({ edge: b, label: e.edge(b) });
  });
  let h = new Map;
  d.forEach((b) => {
    let g = e.parent(b);
    h.set(b, typeof g == "string" ? g : undefined);
  }), u.forEach((b, g) => {
    let m = e.node(g), w = [];
    b.forEach((C) => {
      let j = e.node(C);
      j && (w.push({ id: C, node: j, parent: h.get(C) }), e.removeNode(C));
    });
    let k = f.filter(({ edge: C }) => b.includes(C.v) || b.includes(C.w)), _ = o[g];
    m && (i.push({ clusterId: g, subgraph: m._dagreClusterSubgraph, bounds: _, children: b, removedNodes: w, removedEdges: k }), m.width = _.width, m.height = _.height);
  });
  let p = new Set;
  f.forEach(({ edge: b, label: g }) => {
    let m = c(b.v), w = c(b.w);
    if (m !== w && e.hasNode(m) && e.hasNode(w)) {
      let k = `${m}\x00${w}`;
      p.has(k) || (p.add(k), e.setEdge(m, w, { ...g, width: 0, height: 0 }));
    }
  });
  let E = jn(e), y = On(E, n, t, (L = xn.get(e)) != null ? L : null);
  xn.set(e, y), Cn(e, E), p.forEach((b) => {
    let g = b.indexOf("\x00"), m = b.slice(0, g), w = b.slice(g + 1);
    e.hasEdge(m, w) && e.removeEdge(m, w);
  }), i.forEach(({ clusterId: b, subgraph: g, bounds: m, removedNodes: w, removedEdges: k }) => {
    var G, x;
    let _ = e.node(b), C = (G = _ == null ? undefined : _.x) != null ? G : 0, j = (x = _ == null ? undefined : _.y) != null ? x : 0, I = (m.minX + m.maxX) / 2, S = (m.minY + m.maxY) / 2;
    w.forEach(({ id: v, node: N, parent: O }) => {
      e.setNode(v, N), O !== undefined && e.setParent(v, O);
    }), k.forEach(({ edge: v, label: N }) => {
      e.setEdge(v, N);
    }), g.nodes().forEach((v) => {
      if (v === b)
        return;
      let N = g.node(v), O = e.node(v);
      O && N && typeof N.x == "number" && typeof N.y == "number" && (O.x = C + (N.x - I), O.y = j + (N.y - S));
    }), delete _._dagreClusterSubgraph;
  }), r.forEach((b) => {
    var w, k;
    let g = e.node(b), m = o[b];
    if (g && g.rankdir && g._dagreClusterSubgraph && m) {
      let _ = g._dagreClusterSubgraph, C = (w = g.x) != null ? w : 0, j = (k = g.y) != null ? k : 0, I = (m.minX + m.maxX) / 2, S = (m.minY + m.maxY) / 2;
      _.nodes().forEach((G) => {
        if (G === b)
          return;
        let x = _.node(G), v = e.node(G);
        if (v && x && typeof x.x == "number" && typeof x.y == "number") {
          let N = x.x - I, O = x.y - S;
          v.x = C + N, v.y = j + O;
        }
      }), delete g._dagreClusterSubgraph;
    }
  });
}
function On(e, n, t, r = null) {
  var l, u;
  let o = (t == null ? undefined : t.useDynamic) !== false, i = o && (l = r == null ? undefined : r.graph) != null ? l : null, s = o && (u = r == null ? undefined : r.rawNodes) != null ? u : null;
  n("    makeSpaceForEdgeLabels", () => hr(e)), n("    removeSelfEdges", () => Nr(e)), n("    acyclic", () => Ue(e, i)), n("    nestingGraph.run", () => un(e)), n("    rank", () => dn(Z(e))), n("    injectEdgeLabelProxies", () => br(e)), n("    removeEmptyRanks", () => Be(e)), n("    nestingGraph.cleanup", () => fn(e)), n("    normalizeRanks", () => We(e)), n("    assignRankMinMax", () => gr(e)), n("    removeEdgeLabelProxies", () => pr(e)), n("    normalize.run", () => Ke(e)), n("    parentDummyChains", () => ln(e)), n("    addBorderSegments", () => bn(e)), n("    order", () => re(e, t, s)), n("    insertSelfEdges", () => Gr(e)), n("    adjustCoordinateSystem", () => pn(e)), n("    position", () => kn(e, t.corePath)), n("    positionSelfEdges", () => vr(e));
  let a = JSON.parse(JSON.stringify(e._nodes));
  return n("    removeBorderNodes", () => wr(e)), n("    normalize.undo", () => Qe(e)), n("    fixupEdgeLabelCoords", () => Lr(e)), n("    undoCoordinateSystem", () => mn(e)), n("    translateGraph", () => mr(e)), n("    assignNodeIntersects", () => Er(e)), n("    reversePoints", () => yr(e)), n("    acyclic.undo", () => Je(e)), { graph: e, rawNodes: a };
}
function Cn(e, n) {
  e.nodes().forEach((t) => {
    let r = e.node(t), o = n.node(t);
    r && (r.x = o.x, r.y = o.y, r.order = o.order, r.rank = o.rank, n.children(t).length && (r.width = o.width, r.height = o.height));
  }), e.edges().forEach((t) => {
    let r = e.edge(t), o = n.edge(t);
    r.points = o.points, Object.hasOwn(o, "x") && (r.x = o.x, r.y = o.y);
  }), e.graph().width = n.graph().width, e.graph().height = n.graph().height;
}
var sr = ["nodesep", "edgesep", "ranksep", "marginx", "marginy"];
var ar = { ranksep: 50, edgesep: 20, nodesep: 50, rankdir: "TB", rankalign: "center" };
var dr = ["acyclicer", "ranker", "rankdir", "align", "rankalign"];
var lr = ["width", "height", "rank"];
var Tn = { width: 0, height: 0 };
var ur = ["minlen", "weight", "width", "height", "labeloffset"];
var cr = { minlen: 1, weight: 1, width: 0, height: 0, labeloffset: 10, labelpos: "r" };
var fr = ["labelpos"];
function jn(e) {
  let n = new T({ multigraph: true, compound: true }), t = _e(e.graph());
  return n.setGraph(Object.assign({}, ar, xe(t, sr), B(t, dr))), e.nodes().forEach((r) => {
    let o = _e(e.node(r)), i = xe(o, lr);
    Object.keys(Tn).forEach((a) => {
      i[a] === undefined && (i[a] = Tn[a]);
    }), n.setNode(r, i);
    let s = e.parent(r);
    s !== undefined && n.setParent(r, s);
  }), e.edges().forEach((r) => {
    let o = _e(e.edge(r));
    n.setEdge(r, Object.assign({}, cr, xe(o, ur), B(o, fr)));
  }), n;
}
function hr(e) {
  let n = e.graph();
  n.ranksep /= 2, e.edges().forEach((t) => {
    var o;
    let r = e.edge(t);
    r.minlen *= 2, ((o = r.labelpos) != null ? o : "r").toLowerCase() !== "c" && (n.rankdir === "TB" || n.rankdir === "BT" ? r.width += r.labeloffset : r.height += r.labeloffset);
  });
}
function br(e) {
  e.edges().forEach((n) => {
    let t = e.edge(n);
    if (t.width && t.height) {
      let r = e.node(n.v), i = { rank: (e.node(n.w).rank - r.rank) / 2 + r.rank, e: n };
      M(e, "edge-proxy", i, "_ep");
    }
  });
}
function gr(e) {
  let n = 0;
  e.nodes().forEach((t) => {
    let r = e.node(t);
    r.borderTop && (r.minRank = e.node(r.borderTop).rank, r.maxRank = e.node(r.borderBottom).rank, n = Math.max(n, r.maxRank));
  }), e.graph().maxRank = n;
}
function pr(e) {
  e.nodes().forEach((n) => {
    let t = e.node(n);
    if (t.dummy === "edge-proxy") {
      let r = t;
      e.edge(r.e).labelRank = t.rank, e.removeNode(n);
    }
  });
}
function mr(e) {
  let n = Number.POSITIVE_INFINITY, t = 0, r = Number.POSITIVE_INFINITY, o = 0, i = e.graph(), s = i.marginx || 0, a = i.marginy || 0;
  function l(u) {
    let { x: d, y: c, width: f, height: h } = u;
    n = Math.min(n, d - f / 2), t = Math.max(t, d + f / 2), r = Math.min(r, c - h / 2), o = Math.max(o, c + h / 2);
  }
  e.nodes().forEach((u) => l(e.node(u))), e.edges().forEach((u) => {
    let d = e.edge(u);
    Object.hasOwn(d, "x") && l(d);
  }), n -= s, r -= a, e.nodes().forEach((u) => {
    let d = e.node(u);
    d.x -= n, d.y -= r;
  }), e.edges().forEach((u) => {
    let d = e.edge(u);
    d.points.forEach((c) => {
      c.x -= n, c.y -= r;
    }), Object.hasOwn(d, "x") && (d.x -= n), Object.hasOwn(d, "y") && (d.y -= r);
  }), i.width = t - n + s, i.height = o - r + a;
}
function Er(e) {
  e.edges().forEach((n) => {
    if (n.v === n.w)
      return;
    let t = e.edge(n), r = e.node(n.v), o = e.node(n.w), i, s;
    t.points ? (i = t.points[0], s = t.points[t.points.length - 1]) : (t.points = [], i = o, s = r), t.points.unshift(se(r, i)), t.points.push(se(o, s));
  });
}
function Lr(e) {
  e.edges().forEach((n) => {
    let t = e.edge(n);
    if (Object.hasOwn(t, "x"))
      switch ((t.labelpos === "l" || t.labelpos === "r") && (t.width -= t.labeloffset), t.labelpos) {
        case "l":
          t.x -= t.width / 2 + t.labeloffset;
          break;
        case "r":
          t.x += t.width / 2 + t.labeloffset;
          break;
      }
  });
}
function yr(e) {
  e.edges().forEach((n) => {
    let t = e.edge(n);
    t.reversed && t.points.reverse();
  });
}
function wr(e) {
  e.nodes().forEach((n) => {
    if (e.children(n).length) {
      let t = e.node(n), r = e.node(t.borderTop), o = e.node(t.borderBottom), i = e.node(t.borderLeft[t.borderLeft.length - 1]), s = e.node(t.borderRight[t.borderRight.length - 1]);
      t.width = Math.abs(s.x - i.x), t.height = Math.abs(o.y - r.y), t.x = i.x + t.width / 2, t.y = r.y + t.height / 2;
    }
  }), e.nodes().forEach((n) => {
    e.node(n).dummy === "border" && e.removeNode(n);
  });
}
function Nr(e) {
  e.edges().forEach((n) => {
    if (n.v === n.w) {
      let t = e.node(n.v);
      t.selfEdges || (t.selfEdges = []), t.selfEdges.push({ e: n, label: e.edge(n) }), e.removeEdge(n);
    }
  });
}
function Gr(e) {
  P(e).forEach((t) => {
    let r = 0;
    t.forEach((o, i) => {
      let s = e.node(o);
      typeof s.rank != "number" && (s.rank = 0), s.order = i + r, (s.selfEdges || []).forEach((a) => {
        M(e, "selfedge", { width: a.label.width, height: a.label.height, rank: s.rank, order: i + ++r, e: a.e, edgeLabel: a.label }, "_se"), (!Array.isArray(a.label.points) || a.label.points.length !== 7) && (a.label.points = [{ x: 0, y: -10 }, { x: 0, y: -10 }, { x: 0, y: 0 }, { x: 0, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 }, { x: 0, y: 0 }]);
      }), delete s.selfEdges;
    });
  });
}
function vr(e) {
  e.nodes().forEach((n) => {
    let t = e.node(n), r = (o) => typeof o == "number" && isFinite(o);
    if (t.dummy === "selfedge") {
      let o = t, i = e.node(o.e.v), s = r(i == null ? undefined : i.x) ? i.x : 0, a = r(i == null ? undefined : i.y) ? i.y : 0, l = r(i == null ? undefined : i.width) ? i.width : 0, u = r(i == null ? undefined : i.height) ? i.height : 0, d = r(t.x) ? t.x : s, c = r(t.y) ? t.y : a, f = l / 2, h = u / 2;
      o.edgeLabel.points = [{ x: d + f, y: c - h }, { x: d + f, y: c - h }, { x: d, y: c }, { x: d - f, y: c + h }, { x: d - f, y: c + h }, { x: d, y: c }, { x: d, y: c }], o.edgeLabel.x = d, o.edgeLabel.y = c, e.setEdge(o.e, o.edgeLabel), e.removeNode(n);
    } else
      t && Array.isArray(t.selfEdges) && t.selfEdges.forEach((o) => {
        if (!Array.isArray(o.label.points) || o.label.points.length !== 7) {
          let i = r(t.x) ? t.x : 0, s = r(t.y) ? t.y : 0, a = r(t.width) ? t.width : 0, l = r(t.height) ? t.height : 0, u = a / 2, d = l / 2;
          o.label.points = [{ x: i + u, y: s - d }, { x: i + u, y: s - d }, { x: i, y: s }, { x: i - u, y: s + d }, { x: i - u, y: s + d }, { x: i, y: s }, { x: i, y: s }];
        }
      });
  });
}
function xe(e, n) {
  return X(B(e, n), Number);
}
function _e(e) {
  let n = {};
  return e && Object.entries(e).forEach(([t, r]) => {
    typeof t == "string" && (t = t.toLowerCase()), n[t] = r;
  }), n;
}
/*! For license information please see dagre.esm.js.LEGAL.txt */

// src/diagram/layout.ts
var nodeClearance = 24;
function autoLayout(diagram) {
  if (diagram.layout === "architecture")
    return architectureGrid(diagram);
  if (diagram.layout === "sequence")
    return sequenceGrid(diagram);
  return diagram.nodes.some((node) => node.group !== undefined) ? flowGrid(diagram) : layeredLayout(diagram);
}
function backEdgesByOrder(diagram) {
  const order = new Map(diagram.nodes.map((node, index) => [node.id, index]));
  const successors = Map.groupBy(diagram.edges, (edge) => edge.source);
  const reaches = (from, to) => {
    const seen = new Set([from]);
    for (const id of seen) {
      if (id === to)
        return true;
      for (const edge of successors.get(id) ?? [])
        seen.add(edge.target);
    }
    return false;
  };
  return (edge) => (order.get(edge.target) ?? 0) <= (order.get(edge.source) ?? 0) && reaches(edge.target, edge.source);
}
function layeredLayout(diagram) {
  const isBack = backEdgesByOrder(diagram);
  const graph = new ie.Graph({ multigraph: true });
  graph.setGraph({ rankdir: "TB", nodesep: 48, ranksep: layerSeparation });
  for (const node of diagram.nodes)
    graph.setNode(`n${node.id}`, { ...nodeSize });
  const loops = diagram.edges.filter((edge) => edge.source === edge.target);
  const laidOut = diagram.edges.filter((edge) => edge.source !== edge.target).map((edge) => {
    const back = isBack(edge);
    const [from, to] = back ? [edge.target, edge.source] : [edge.source, edge.target];
    graph.setEdge(`n${from}`, `n${to}`, {}, edgeId(edge));
    return { edge, from, to, back };
  });
  Oe(graph, { disableOptimalOrderHeuristic: true });
  const center = (id) => {
    const { x, y } = graph.node(`n${id}`);
    return [x, y];
  };
  const positions = Object.fromEntries(diagram.nodes.map((node) => {
    const [x, y] = center(node.id);
    return [node.id, [x - nodeSize.width / 2, y - nodeSize.height / 2]];
  }));
  const layers = new Set(diagram.nodes.map((node) => center(node.id)[1]));
  const connections = {};
  for (const { edge, from, to, back } of laidOut) {
    const dummies = (graph.edge(`n${from}`, `n${to}`, edgeId(edge))?.points ?? []).slice(1, -1).map(({ x, y }) => [x, y]);
    if (back)
      dummies.reverse();
    const connection = longEdge(center(edge.source), center(edge.target), dummies, layers);
    if (connection) {
      connections[edgeId(edge)] = {
        ...connection,
        source: positions[edge.source],
        target: positions[edge.target]
      };
    }
  }
  for (const edge of loops) {
    const [x, y] = positions[edge.source];
    connections[edgeId(edge)] = {
      ...loop({ x, y, ...nodeSize }, "right", edge.label),
      source: [x, y],
      target: [x, y]
    };
  }
  return { positions, connections, groups: [] };
}
function longEdge([sourceX, sourceY], [targetX, targetY], dummies, layers) {
  const stops = dummies.map(([x, y]) => layers.has(y) ? { layer: x } : { gap: y });
  const passed = stops.flatMap((stop) => ("layer" in stop) ? [stop.layer] : []);
  if (passed.length === 0)
    return;
  const gaps = stops.filter((stop) => ("gap" in stop));
  const labelGap = gaps[Math.floor(gaps.length / 2)];
  const half = nodeSize.height / 2;
  if (targetY < sourceY) {
    const beside = (x, toward) => x + Math.sign(toward - x || 1) * (nodeSize.width / 2 + nodeClearance);
    stops.unshift({ gap: sourceY + half + layerSeparation / 2 }, { layer: beside(sourceX, passed[0]) });
    stops.push({ layer: beside(targetX, passed.at(-1)) }, { gap: targetY - half - layerSeparation / 2 });
  }
  stops.push({ layer: targetX });
  const points = [[sourceX, sourceY + half]];
  let x = sourceX;
  let bend;
  let label;
  let beforeLabel;
  for (const stop of stops) {
    if ("gap" in stop) {
      bend = stop.gap;
      if (stop === labelGap)
        beforeLabel = x;
      continue;
    }
    if (stop.layer !== x) {
      if (bend === undefined)
        return;
      points.push([x, bend], [stop.layer, bend]);
    }
    if (beforeLabel !== undefined && labelGap && !label)
      label = [(beforeLabel + stop.layer) / 2, labelGap.gap];
    x = stop.layer;
  }
  points.push([targetX, targetY - half]);
  return label && { points: withoutStraightBends(points), label };
}

// src/kinds.ts
var kindStyles = {
  service: {
    name: "Service",
    tag: "",
    description: "Service or step",
    icon: "M4 7.5 12 3l8 4.5v9L12 21l-8-4.5zM4 7.5l8 4.5 8-4.5M12 12v9"
  },
  db: {
    name: "Data",
    tag: "data",
    description: "Database, file or other state",
    icon: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"
  },
  queue: {
    name: "Queue",
    tag: "queue",
    description: "Queue, topic or event bus",
    icon: "M3 7h18v10H3zM9 7v10M15 7v10"
  },
  ui: {
    name: "Entry point",
    tag: "entry",
    description: "User-facing app or command",
    icon: "M3 4h18v13H3zM8 21h8M12 17v4"
  },
  ext: {
    name: "External",
    tag: "external",
    description: "System outside this diagram",
    icon: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.4 2.5 3.6 5.5 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.5-3.6-9s1.2-6.5 3.6-9z",
    dashed: true
  }
};

// server/svg.ts
var escape = (text) => Array.from(text).filter((char) => {
  const point = char.codePointAt(0);
  return point === 9 || point === 10 || point === 13 || point >= 32 && point <= 55295 || point >= 57344 && point <= 65533 || point >= 65536;
}).join("").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;"
})[char]);
var colors = { added: "#40c1ac", changed: "#60a5fa", removed: "#f6459d" };
var center = (value) => Array.isArray(value) ? [value[0] + nodeSize.width / 2, value[1] + nodeSize.height] : [value.x + value.width / 2, value.y + value.height];
var number = (value) => Number(value.toFixed(2));
function dottedFlow(path, color) {
  return `<path class="dotted-flow" d="${path}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="1 8"><animate attributeName="stroke-dashoffset" from="0" to="-18" dur="1.2s" repeatCount="indefinite"/></path>`;
}
function sequenceTrail(path, points, color, index, steps) {
  const length = number(points.slice(1).reduce((total, [x, y], i) => {
    const [previousX, previousY] = points[i];
    return total + Math.hypot(x - previousX, y - previousY);
  }, 0));
  const start = index / steps;
  const end = (index + 1) / steps;
  const timing = [
    { at: 0, offset: 28, visible: start === 0 ? 1 : 0 },
    ...start > 0 ? [{ at: start, offset: 28, visible: 1 }] : [],
    { at: end, offset: -length, visible: 0 },
    ...end < 1 ? [{ at: 1, offset: -length, visible: 0 }] : []
  ];
  const keyTimes = timing.map(({ at }) => Number(at.toFixed(6))).join(";");
  const duration = number(steps * 1.2);
  return `<path class="dotted-flow sequence-trail" d="${path}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-dasharray="1 8 1 8 1 8 1 ${length + 36}" stroke-dashoffset="28" opacity="0"><animate attributeName="stroke-dashoffset" values="${timing.map(({ offset }) => offset).join(";")}" keyTimes="${keyTimes}" dur="${duration}s" calcMode="linear" repeatCount="indefinite"/><animate attributeName="opacity" values="${timing.map(({ visible }) => visible).join(";")}" keyTimes="${keyTimes}" dur="${duration}s" calcMode="discrete" repeatCount="indefinite"/></path>`;
}
function renderSvg(current, base) {
  const currentDiagram = parseDiagram(current.source);
  const baseDiagram = base && parseDiagram(base.source);
  const errors = [...currentDiagram.errors, ...baseDiagram?.errors ?? []];
  if (errors.length)
    throw new Error(errors.join(`
`));
  const comparison = baseDiagram && compare({ diagram: baseDiagram, layout: {} }, { diagram: currentDiagram, layout: {} });
  const diagram = comparison ? comparison.union : currentDiagram;
  const changes = comparison ? comparison.changes : new Map;
  const auto = comparison && diagram.layout === "architecture" ? architectureGrid(diagram, Math.max(48, ...diagram.edges.map((edge) => labelWidth(edge.label) + 32))) : autoLayout(diagram);
  if (!diagram.nodes.length && !auto.groups.length)
    throw new Error("Cannot export an empty diagram.");
  const sequence = diagram.layout === "sequence";
  if (sequence) {
    for (const [id, y] of Object.entries(auto.steps ?? {}))
      auto.steps[id] = y + 16;
    for (const [id, length] of Object.entries(auto.timelines ?? {}))
      auto.timelines[id] = length + 16;
    for (const group of auto.groups)
      group.box.height += 16;
  }
  const nodeBoxes = diagram.nodes.map((node) => {
    const [x, y] = auto.positions[node.id];
    return { x, y, ...nodeSize };
  });
  const headerBoxes = auto.groups.map(({ box }) => ({ ...box, height: 40 }));
  const drawnIds = new Set([
    ...diagram.nodes.map((node) => node.id),
    ...auto.groups.map(({ id }) => id)
  ]);
  const drawableEdges = diagram.edges.filter((edge) => drawnIds.has(edge.source) && drawnIds.has(edge.target));
  const notes = parseNotes(current.notes);
  const title = (id, label) => `<title>${escape([label, ...notes.filter((note) => note.target === id).map((note) => note.text)].join(`
`))}</title>`;
  const boxes = auto.groups.map(({ box }) => box);
  const groups = auto.groups.map(({ id, box }) => {
    const group = diagram.groups.find((candidate) => candidate.id === id);
    const change = changes.get(id);
    return `<g>${title(id, group.label)}<defs><clipPath id="group-label-${id}"><rect x="${box.x + 16}" y="${box.y}" width="${box.width - 32}" height="40"/></clipPath></defs><rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="12" fill="#0b1220" stroke="${change ? colors[change] : "#1e293b"}"/><text x="${box.x + 16}" y="${box.y + 26}" class="group-label" clip-path="url(#group-label-${id})">${escape(group.label)}</text></g>`;
  });
  const timelines = diagram.nodes.flatMap((node) => {
    const length = auto.timelines?.[node.id];
    if (!length)
      return [];
    const [x, y] = auto.positions[node.id];
    const bottom = y + nodeSize.height + length;
    boxes.push({ x, y, width: nodeSize.width, height: nodeSize.height + length });
    return [
      `<path d="M${x + nodeSize.width / 2},${y + nodeSize.height} V${bottom}" stroke="#58585f" stroke-dasharray="4 4"/>`
    ];
  });
  const labels = [];
  const labelBoxes = [];
  const activeEdges = drawableEdges.filter((edge) => changes.get(edgeId(edge)) !== "removed");
  const edges = drawableEdges.map((edge, index) => {
    const id = edgeId(edge);
    const source = auto.positions[edge.source] ?? auto.groups.find((group) => group.id === edge.source)?.box;
    const target = auto.positions[edge.target] ?? auto.groups.find((group) => group.id === edge.target)?.box;
    if (!source || !target)
      throw new Error(`Missing endpoint for ${id}.`);
    const [sx, sy] = center(source);
    const [tx, ty] = center(target);
    const row = auto.steps?.[id];
    const fallback = {
      points: [
        [sx, sy],
        [sx, (sy + ty - nodeSize.height) / 2],
        [tx, (sy + ty - nodeSize.height) / 2],
        [tx, ty - nodeSize.height]
      ],
      label: [(sx + tx) / 2, (sy + ty - nodeSize.height) / 2]
    };
    const connection = row !== undefined ? step(sx, tx, row, edge.label, edge.source === edge.target) : auto.connections[id] ?? fallback;
    const {
      points,
      label: [lx, routeY]
    } = connection;
    const change = changes.get(id);
    const label = edge.label;
    const labelHeight = 20;
    const width = number(labelWidth(label));
    const labelX = sequence && edge.source === edge.target ? Math.max(...points.map(([x]) => x)) + 14 + width / 2 : lx;
    let ly = sequence && edge.source !== edge.target ? routeY - 16 : routeY;
    if (edge.label) {
      const overlaps = (box) => [...nodeBoxes, ...headerBoxes, ...labelBoxes].some((other) => box.x < other.x + other.width + 4 && box.x + box.width > other.x - 4 && box.y < other.y + other.height + 4 && box.y + box.height > other.y - 4);
      let distance = 0;
      while (overlaps({ x: labelX - width / 2, y: ly - labelHeight / 2, width, height: labelHeight })) {
        distance += 1;
        ly = routeY + Math.ceil(distance / 2) * 24 * (distance % 2 ? 1 : -1);
      }
      const box = { x: labelX - width / 2, y: ly - labelHeight / 2, width, height: labelHeight };
      boxes.push(box);
      labelBoxes.push(box);
    }
    for (const [x, y] of points)
      boxes.push({ x, y, width: 0, height: 0 });
    const animated = (edge.animated === true || diagram.layout === "sequence") && change !== "removed";
    const color = change ? colors[change] : comparison || sequence ? "#64748b" : animated ? "#529aff" : "#64748b";
    const path = points.map(([x, y], i) => `${i ? "L" : "M"}${number(x)},${number(y)}`).join(" ");
    if (edge.label)
      labels.push(`<g>${title(id, edge.label)}${sequence || ly === routeY ? "" : `<path d="M${number(lx)},${number(routeY)} V${number(ly)}" stroke="#334155"/>`}<rect data-label="${escape(id)}" x="${number(labelX - width / 2)}" y="${number(ly - labelHeight / 2)}" width="${width}" height="${labelHeight}" rx="4" fill="${sequence ? "none" : "#020617"}"/><text x="${number(sequence && edge.source === edge.target ? labelX - width / 2 + 6 : labelX)}" y="${number(ly + 4)}" class="edge-label${sequence && edge.source === edge.target ? " loop-label" : ""}${change ? ` ${change}` : ""}">${escape(label)}</text></g>`);
    if (sequence) {
      const gutterX = Math.min(...nodeBoxes.map((box) => box.x)) - 22;
      labels.push(`<text data-step="${escape(id)}" x="${gutterX}" y="${routeY + 4}" class="step-number" fill="${change ? colors[change] : "#64748b"}">${index + 1}</text>`);
      boxes.push({ x: gutterX - 14, y: routeY - 10, width: 24, height: 20 });
    }
    const flow = animated ? diagram.layout === "sequence" ? sequenceTrail(path, points, comparison ? color : "#93c5fd", activeEdges.indexOf(edge), activeEdges.length) : dottedFlow(path, color) : "";
    return `<g>${title(id, `${edge.source} → ${edge.target}: ${edge.label}`)}<defs><marker id="arrow-${index}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 Z" fill="${color}"/></marker></defs><path data-edge="${escape(id)}" d="${path}" fill="none" stroke="${color}" stroke-width="1.5" marker-end="url(#arrow-${index})"${animated ? ` class="flow" stroke-opacity="${sequence ? "0.8" : "0.25"}"` : change === "removed" ? ' stroke-dasharray="5 4" opacity="0.6"' : ""}/>${flow}</g>`;
  });
  const nodes = diagram.nodes.map((node) => {
    const [x, y] = auto.positions[node.id];
    boxes.push({ x, y, ...nodeSize });
    const kind = kindStyles[node.kind];
    const change = changes.get(node.id);
    const count = sequence ? 0 : notes.filter((note) => note.target === node.id).length;
    const subtitle = [change, kind.tag, count ? `${count} note${count === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
    return `<g>${title(node.id, node.label)}<defs><clipPath id="node-label-${node.id}"><rect x="${x + 42}" y="${y}" width="${nodeSize.width - 52}" height="${nodeSize.height}"/></clipPath></defs><rect data-node="${node.id}" x="${x}" y="${y}" width="${nodeSize.width}" height="${nodeSize.height}" rx="8" fill="#0f172a" stroke="${change ? colors[change] : "#334155"}"${kind.dashed || change === "removed" ? ' stroke-dasharray="5 4"' : ""}/><svg x="${x + 12}" y="${y + 18}" width="20" height="20" viewBox="0 0 24 24"><path d="${kind.icon}" fill="none" stroke="#9d9d9d" stroke-width="1.5"/></svg><g clip-path="url(#node-label-${node.id})"><text x="${x + 42}" y="${y + (subtitle ? 25 : 33)}" class="node-label"${change === "removed" ? ' text-decoration="line-through"' : ""}>${escape(node.label)}</text>${subtitle ? `<text x="${x + 42}" y="${y + 43}" class="subtitle" fill="${change ? colors[change] : "#9d9d9d"}">${escape(subtitle)}</text>` : ""}</g></g>`;
  });
  const comparisons = [];
  if (comparison) {
    const x = Math.min(...boxes.map((box) => box.x));
    const y = Math.min(...boxes.map((box) => box.y)) - 24;
    const entries = [
      { change: "added", label: "Added", color: colors.added },
      { change: "changed", label: "Changed", color: colors.changed },
      { change: "removed", label: "Removed", color: colors.removed },
      { change: "unchanged", label: "Unchanged", color: "#64748b" }
    ];
    let legendX = x;
    for (const { change, label, color } of entries) {
      comparisons.push(`<path d="M${legendX},${y - 4} h20" stroke="${color}" stroke-width="2"${change === "removed" ? ' stroke-dasharray="5 4"' : ""}/><text x="${legendX + 28}" y="${y}" class="legend-label">${label}</text>`);
      legendX += labelWidth(label) + 56;
    }
    boxes.push({ x, y: y - 14, width: legendX - x, height: 20 });
  }
  const left = Math.min(...boxes.map((box) => box.x)) - 32;
  const top = Math.min(...boxes.map((box) => box.y)) - 32;
  const width = number(Math.max(...boxes.map((box) => box.x + box.width)) + 32 - left);
  const height = number(Math.max(...boxes.map((box) => box.y + box.height)) + 32 - top);
  const name = base ? `${current.name} compared with ${base.name}` : current.name;
  const diagramTitle = [
    name,
    ...notes.filter((note) => note.target === undefined).map((note) => note.text)
  ].join(`
`);
  const grid = sequence ? '<pattern id="grid" width="64" height="64" patternUnits="userSpaceOnUse"><path d="M64,0 H0 V64" fill="none" stroke="#71839e" stroke-opacity="0.14" stroke-width="0.6"/></pattern>' : '<pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="0.7" fill="#1e293b"/></pattern>';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${number(left)} ${number(top)} ${width} ${height}" role="img" aria-labelledby="diagram-title"><title id="diagram-title">${escape(diagramTitle)}</title><desc>Component relationships and ordered operations. Teal indicates additions, blue indicates changes, pink dashed lines indicate removals, and gray indicates unchanged connections. Moving dotted lines trace selected connections.</desc><defs>${grid}</defs><style>text{font-family:system-ui,sans-serif}.node-label{font-size:14px;fill:white}.group-label{font-size:13px;font-weight:600;fill:white}.subtitle{font-size:12px}.edge-label{font-size:11px;text-anchor:middle;fill:#cbd5e1}.edge-label.added{fill:#40c1ac}.edge-label.changed{fill:#93c5fd}.edge-label.removed{fill:#f6459d}.legend-label{font-size:11px;fill:#94a3b8}${diagram.layout === "sequence" ? ".loop-label{text-anchor:start}.step-number{font-size:10px;text-anchor:end}" : ""}@media(prefers-reduced-motion:reduce){.dotted-flow{display:none}.flow{stroke-opacity:1}}</style><rect x="${number(left)}" y="${number(top)}" width="${width}" height="${height}" fill="#020617"/><rect x="${number(left)}" y="${number(top)}" width="${width}" height="${height}" fill="url(#grid)"/>${[...groups, ...timelines, ...edges, ...nodes, ...labels, ...comparisons].join(`
`)}</svg>
`;
}

// server/export.ts
var suffixes = [".txt", ".layout.json", ".notes.md", ".marks"];
async function readDiagrams(dir) {
  const names = partNames(await readdir2(dir).catch(() => []), ".txt").toSorted();
  const diagrams = await Promise.all(names.map(async (name) => {
    const parts = await Promise.all(suffixes.map(async (suffix) => {
      const content = await readFile2(join2(dir, `${name}${suffix}`), "utf8").catch(() => {
        return;
      });
      return [suffix, content];
    }));
    return toDiagramFiles(name, Object.fromEntries(parts));
  }));
  return { names, diagrams };
}
async function exportSvg(dir, name, against) {
  const { diagrams } = await readDiagrams(dir);
  const current = name ? diagrams.find((diagram) => diagram.name === name) : diagrams[0];
  if (!name && diagrams.length > 1)
    throw new Error("SVG export needs --diagram when there are multiple diagrams.");
  if (!current)
    throw new Error(`No diagram found${name ? `: ${name}` : ""}.`);
  const base = against ? diagrams.find((diagram) => diagram.name === against) : undefined;
  if (against && !base)
    throw new Error(`No comparison diagram found: ${against}.`);
  return renderSvg(current, base);
}
async function exportPage(page, dir) {
  const { names, diagrams } = await readDiagrams(dir);
  const data = JSON.stringify(diagrams).replaceAll("<", "\\u003c");
  const script = `<script type="application/json" id="diagram-data">${data}</script>`;
  return { html: page.replace("<head>", () => `<head>${script}`), names };
}

// server/handoff.ts
import { watch as watch2 } from "node:fs";
import { mkdir as mkdir2, readFile as readFile3, readdir as readdir3, rm as rm2 } from "node:fs/promises";
import { join as join3 } from "node:path";
async function takeHandoffs(dir) {
  const handoffs = await Promise.all(partNames(await readdir3(dir), ".handoff").map(async (name) => {
    const path = join3(dir, `${name}.handoff`);
    const content = await readFile3(path, "utf8").catch(() => "");
    if (content === "")
      return;
    await rm2(path, { force: true });
    return { name, text: content.trim() };
  }));
  return handoffs.filter((handoff) => handoff !== undefined);
}
async function waitForHandoffs(dir) {
  await mkdir2(dir, { recursive: true });
  return new Promise((resolve, reject) => {
    let looking = false;
    let changed = false;
    const look = () => {
      if (looking) {
        changed = true;
        return;
      }
      looking = true;
      changed = false;
      takeHandoffs(dir).then((handoffs) => {
        looking = false;
        if (handoffs.length > 0) {
          watcher.close();
          resolve(handoffs);
        } else if (changed)
          look();
      }, (error) => {
        watcher.close();
        reject(error);
      });
    };
    const watcher = watch2(dir, look);
    look();
  });
}

// server/status.ts
import { createHash } from "node:crypto";
import { mkdir as mkdir3, readFile as readFile4, readdir as readdir4, writeFile as writeFile2 } from "node:fs/promises";
import { homedir } from "node:os";
import { join as join4, resolve as resolve2 } from "node:path";
var isSnapshot = (value) => typeof value === "object" && value !== null && Object.values(value).every((seen) => typeof seen === "object" && seen !== null && ("source" in seen) && typeof seen.source === "string" && ("notes" in seen) && typeof seen.notes === "string" && ("marks" in seen) && Array.isArray(seen.marks));
var nodeLine = (node) => `${nodeStatement(node)}${node.group ? ` in [${node.group}]` : ""}`;
var noteKey = (note) => `${note.kind} ${note.forUser ? ">user " : ""}${note.target} ${note.text}`;
function diff(before, after, key, show) {
  const was = new Map(before.map((item) => [key(item), item]));
  const now = new Map(after.map((item) => [key(item), item]));
  const lines = [];
  for (const [id, item] of now) {
    const old = was.get(id);
    if (old === undefined)
      lines.push(`+ ${show(item)}`);
    else if (show(old) !== show(item))
      lines.push(`~ ${show(item)}`);
  }
  for (const [id, item] of was)
    if (!now.has(id))
      lines.push(`- ${show(item)}`);
  return lines;
}
async function diagramStatus(dir, previous) {
  const read = (file) => readFile4(join4(dir, file), "utf8").catch(() => {
    return;
  });
  const listing = await readdir4(dir).catch(() => []);
  const names = partNames(listing, ".txt").toSorted();
  const reports = await Promise.all(names.map(async (name) => {
    const [source, notes, marks] = await Promise.all([".txt", ".notes.md", ".marks"].map((suffix) => read(`${name}${suffix}`)));
    const files = toDiagramFiles(name, { ".txt": source, ".notes.md": notes, ".marks": marks });
    const { nodes, edges, tags, errors } = parseDiagram(files.source);
    const entries = parseNotes(files.notes);
    const tagNames = new Set(tags.map((tag) => tag.name));
    const unknownTags = entries.map((note) => note.tag).filter((tag) => tag !== undefined && !tagNames.has(tag));
    const labels = new Map(nodes.map((node) => [node.id, node.label]));
    const targets = new Set([...labels.keys(), ...edges.map(edgeId)]);
    const describe = (target) => labels.has(target) ? `${target} (${labels.get(target)})` : target;
    const describeNote = (note) => [
      note.kind === "note" ? "note" : note.done ? "✓" : "?",
      note.forUser && ">user",
      note.tag && `#${note.tag}`,
      note.target && `@${describe(note.target)}`,
      note.text,
      note.answer && `→ ${note.answer}`
    ].filter(Boolean).join(" ");
    const questions = entries.filter((note) => note.kind === "question");
    const open = questions.filter((note) => !note.done);
    const forUser = open.filter((note) => note.forUser).length;
    const unknown = [...entries.map((note) => note.target), ...files.marks].filter((target) => target !== undefined && !targets.has(target));
    const seen = previous?.[name];
    let changes = [];
    if (previous && !seen)
      changes = ["+ new diagram"];
    else if (seen) {
      const before = parseDiagram(seen.source);
      changes = [
        ...diff(before.nodes, nodes, (node) => node.id, (node) => `node ${nodeLine(node)}`),
        ...diff(before.edges, edges, edgeId, (edge) => `edge ${edgeStatement(edge)}`),
        ...diff(parseNotes(seen.notes), entries, noteKey, describeNote),
        ...diff(seen.marks, files.marks, String, (mark) => `mark ${describe(mark)}`)
      ];
    }
    const lines = [
      `${name}: ${nodes.length} nodes, ${edges.length} edges, ${open.length} open questions${forUser > 0 ? ` (${forUser} for the user)` : ""}, ${questions.length - open.length} resolved, ${entries.length - questions.length} notes`,
      ...errors.map((error) => `  error: ${error}`),
      ...files.marks.length > 0 ? [`  marked: ${files.marks.map(describe).join(", ")}`] : [],
      ...open.map((note) => `  ${describeNote(note)}`),
      ...[...new Set(unknown)].map((target) => `  unknown target: ${target}`),
      ...[...new Set(unknownTags)].map((tag) => `  unknown tag: ${tag}`),
      ...changes.length > 0 ? ["  changed since the last status:", ...changes.map((change) => `    ${change}`)] : []
    ];
    const snapshot = { source: files.source, notes: files.notes, marks: files.marks };
    return { name, lines, failed: errors.length > 0, snapshot };
  }));
  const removed = Object.keys(previous ?? {}).filter((name) => !names.includes(name)).map((name) => `${name}: removed since the last status`);
  const text = [...reports.flatMap(({ lines }) => lines), ...removed];
  return {
    text: text.length === 0 ? `No diagrams in ${dir} yet.` : text.join(`
`),
    failed: reports.some(({ failed }) => failed),
    snapshot: Object.fromEntries(reports.map(({ name, snapshot }) => [name, snapshot]))
  };
}
var cacheDir = join4(process.env.XDG_CACHE_HOME ?? join4(homedir(), ".cache"), "diagram-canvas");
var snapshotPath = (dir) => join4(cacheDir, `${createHash("sha256").update(resolve2(dir)).digest("hex").slice(0, 16)}.json`);
async function runStatus(dir) {
  const path = snapshotPath(dir);
  const previous = await readFile4(path, "utf8").then(JSON.parse).catch(() => {
    return;
  });
  const status = await diagramStatus(dir, isSnapshot(previous) ? previous : undefined);
  await mkdir3(cacheDir, { recursive: true });
  await writeFile2(path, JSON.stringify(status.snapshot));
  return status;
}

// server/canvas.ts
var { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string", default: "7766" },
    host: { type: "string", default: "127.0.0.1" },
    "allow-host": { type: "string", multiple: true, default: [] },
    out: { type: "string", default: "diagrams.html" },
    diagram: { type: "string" },
    compare: { type: "string" }
  }
});
var [command, dirArgument] = ["status", "wait", "export"].includes(positionals[0] ?? "") ? positionals : ["serve", positionals[0]];
var dir = resolve3(dirArgument ?? "diagrams");
var page = () => brotliDecompressSync(Buffer.from("W7FXdgI9xLQG7qBuCAfYJxO1TY8oUI7tFLeNW5i8P6KmRst3N8bAWMW6dI7NrUIRAM8zP6CqqiYntTEsLfdpAQVQp47p3GsU5ogpS2LSppkokjLVqcXOPGNZMSVDZcMMgoEJsQUxEUVGExkTzBmLyGKjbKIWkbVVvvbVeBBFaTj9TSQxLPPkrDHgY4hTvPztjo8+Cq9LEl1s4krEKU3Zb0SR0KfPx3aDt9vpBmpf4Yjbcrvx4ksbGwZ8JO2FCBsZ0fPyambITOE0xMc+akdBM2KuwuSohFWeQ8RfyoaRV+SaPAVOvzWsyS6pFbARHRlLKZ5KdyQQxPr+184j1s1dueWVIvnO0l0szwnfWKU94GE5Phr3PzFi0C+owkMr+rPIA8dV0J9bnpKyrSt8YRF5QqfYvoOHG9xC/rtIWNWv4mrkvZvuQaNR7JwxwGLc6uaBCE2UhVCEWmVjb6UO8RQvcYi3PIRJeDufY/79vrdc///1e6qXP6RFm5aqxzeIsxrMMBtmo+tXisoMlQJSESJyZ+FCzz97VfvPzxdVl0gejtt9TyFjbd8ZScQiQaAi8KK6AKkesPuaGt/p+uWvfesNM2vPzI+nxQQFCyEJlKwDNE0BJaAadxdJskrTynKXTkelmOx9zgOUKsc4E4fggoMaEnFCtwIgR/egL99Xq9rf/fkKanxdjRBiCNnJ5ujBoSaviWts5+HMU6MhYRKSkEiAFmgqttU++E/d91btqyxdOIDXzxh2JspUTZz8myIS83/Z1v9qa7o9nspDsCqAU7/gR4IzwQHx05GmiuQixXCDN5fJyN8v/mrZ8B//tqy+fqEWtS46QLq6Z4sgeLXurp4tS1OiMmWbnjR4QOllnqJjZGBqWqmlRalf1LTYC+UAm4gCFAMIHtxtFcWlbPPepZ+9r/pfv5RREGeqWeU+nkOPF4nttkbrBxKltUAIGVpc0awlkuCuY7smL1MrX1+cg0qwm1AHdAOgvDVOafxyHtFLKq3WJk8qUaXVBDx+H6sm0rbtlS/DVOkjU5sxYCn5Yp+S/AanrcrXd3Pb02XmYE86bufyd17kRCjY7YIg0WVk17hBCqatYMpiECRw2XnbOo0wBEhrlYgOPdK1svxCEIBC5JzK1gbCDea2mFhfXqvhUhYZajf2LBNaaO33fif+Uh/d1vQ3LNye25thwtKzTI3AAWHXpSPnxjYPAwUN/whKWxaihjeSvR+yh8CnF1IuNTzm9BHRLtwrLQHdxz1+/B1l13YkvcC/Npmyk2f81AyEVBguebQzZT/A/WCZ/fKj2L/T1HZ1o3fh7hYTEISEo9EZeziD7cfiD16QbsDSzdkh9HJZoAr9CMMnCAzYgioHrKXFNx0dDvrk/39vpVUz+puZW3ggk6wEkLKFUMtZlblHBFKUYlZmdY3Wa7cr3g3/Em7fBMLM3D3hIqIYAihEBAJFgCDfff+78/9vHkgziyDL3APM9giQeQJgZg9AVtVBsqrOGZIAOalaKL1ZsFpmjlSLVS9nsWTlKHb1qGWtx39+v3/TvmRmCgrYycF7g6ogNPvmnr3vCtFLhkiW4Ww87/NAgdChcK0Vo+V5iflJyzCFcz6wvZXPq5quIKALeHaX0to06vE23oZsdiZo85oqEBAsgrwzxbu0PszO5PJJwYVypVJ5k3WpyqbRgUwGTslJt1mz5hKQk4YP9F86hNetv8n4f1bq1tbqXT0egw/w74e/vdVMS60X3+N3wMEYzDldh2nq1mfr7m0IAWzAEAI2ga4j7T/lfrZ0KQMMGGPc8KTd2x977aGt27SuuzWEEL79qOhouG2U+59+a72fMy6wHGdIQkKrfxnL6trOt9Nx567yicgnhkgCntkw/50FJ6+DbPcWfCzWIEh6XKlfQ/U752yn/8xECNFEqfsW7Fxjr/3zmuR6SdvMPAEREZHPsrt87DZMXdq06+f1LoZfCBA4tnnkLcPSumyTydN2c5fxw2ceIQS2QeL8b+y133STbl/TtDMvCgjIXyB67pUe4/wf2//7kSTXDbToQA/i+WKhxF2+Otwbso1ljd26e6e1vUdCgICAT4NWjVA1h/mhc4H+EJToQer4MlS//4qdMTtAgOPgEYOJpdO1rsJgZdpzUU7APmkYsk6eHLsN4veoQUFrOMZZbqIAp9ofMtTky756tBjoBJfFe4DNB/KrToaGq/+8Qk7d9ypiF3UxJUWOftQbUhXKfkEpUgbo8AerXDK56dAS61ML+QlO4HN0UctdDFaEQ3DbNCnqtzvWETZd+U39zL4xfFLgvd6PH9PhOyjB1oZtnMz+65+M4Rovmf+WqtT2HY+uO0aw7lVb6nwr4PgTyFCPum4IouCAWZOOCbhzCdDa7+ZIY+apiXigCzYr2deuA/vM67o/HYBpM7WhElbATFbrvpZsGvLrIY0hhNspD4djNkb7ZdZ6S4qmIHeg9d3a9JYD4m9R124R3CcG4neF+h3KlaovJbx1WIcO2UZRuTsRxK0LHHh62oPTtGm2pwLzrdUvkanN/MC0tsnaoUzH4OL+FVNosNYJMGYrw1dYAP6Obhr3giEJofqrjpF2j+BcbmHPiqTrYlABEEY0gEOoj2Q6obBVpwgyJN9qUIN+djUNOIZC8atVGz/hvuCWuIHnf01IUR8t4UYNCXDh6lJhpN6PkRyaCP6pf2STCt9Xr1eBVUvKq2Vx+6o87Z+09vDXH8M7fZXk+2yB8zr4TF2efzmxSDcwRP5hB+mNdSqszl6QRCJRaERj3sy1BJDdj5cpQRuqmxhOH2tLIUq/yS4A+a6kM0WYrd4xT/H26SZfJM7M9R+31AIVRuQaT8JU9tcdbu06fGvgyJ5eZNC+Un9at4NqVj8VBp+zhNaeba0XnJ9fh8uEn7XsajGlgWu2Wk/p1H9gtYnsepUBCOGZzp/Qbg0w89q7pAYUNoqDFzFz8BYEBLZM7iLl0auiQNIWCIHDAVP5Sk/5oYUNMhnc3vXhb/EHAhrwp+H19JpeDQc5RdZntt33Veo6Ar4HtF8JGAlMqyreWMf+/+63VR1fg/hQld/JHsqzYHVrc2XmkQ5dFLz4k1Wc2mbsaBQr3RRqk7jOyBm3OeqeBUJcHs6MzH9gAYaQEkdHM3z/ju2aQbi7ZXLKo9Y1hl0B+GrXkl5VapqfS/7nVw4YQFg6+vuV3eqXv0Y4lXedv2SdyexE/5R5iV1X+N8ciTECO6ztdd4n11VBc/uPw/tUfji2DJBDm/SSnUC14eQIiUsaDtnEBWNWTd3hFlqVPzVrof1QQ7tvwxg3bpP8E8CXHwflISNa4jSVXXEIh+zjP3/+ZCSVryRJp3dojPtaOldyHHBs9Y4S2vBVTKKWozWzyZTlM9Ee9ZWfnNSHD4eQ9cUgtoZUUk1zUbynmoC9u1BTsgoEGFyf/0n3VZcM5d8bzDfiNWUU33FDB2OQ6RuXmNjEU8rKQfPwx0719LdVikQTsF31SsyGDc5gexTfaLMsVdrVLchzJ40C8cIQ4twz9zYdmETsn8KWU3rWS0nYU/jS7kXI/pyDQQU7WmPyNUANkFCm8L7HFChhRavL/HpIGcppgDHsAGMCucGNGgwYVv3ewI4y8FcyoaofZenFu6c/aX/1TOfBegE/i6k9O+jGBmj5mSS9wP4Hkufnwfzbzl3TKvn7Ob31c/h5Y21cWn5e7M+u1mTtnVoeYc7rMjUemW4nJwmy60OWF618L0vftwyhvp6j4aqOUf2o7/mCTxFeVM4LPVdM7pw9KcA1wN6DB7n8XN0HcKYFPUMpK4XNaXPoz3F3VZO4d32Y8TvgqHVexNtQ7iB86tn4uX8SWdHKE4xdAPOOdmioQVLE4FqAxhkt9Td+QIFdgjYVvD+mshR8qGNXtAXXdWsC0SGgqGDRDX0BjYR+4E6pGm8NoQ8vTwaTLmC7EUwpMp58tqL6XW8ofjLLfqwG1qoiFzkXjDSwsl5jagllG5W9hWXfU0exmVObC+E5YKHvda0cENPuCRY/DlQ0DkfGnHp13Kqm4THm0745qjMBrFM2DM0bdMVsg3kJIhROeI/xTSZwBnMyd2e/fQX4ghacKU1Wd2CYxqr6X685Ot7FfJNwx+sP2249fKEnpbuXyIrAh7L90L+Cg3e130ZJo0iphGAocH9hOmxGhM6udoIcbBo+4yHQZSH81eQPXLQPmCc+LiRKgAXd8Cox2Nvwihuub9b14ME3XwUQmWvXjtWl/2X24bBW+f/YBB2c6//uFGqc3h3gGgHxf80w0NjAbQD08LUoVFnUuxD8Gcip9wYw4Iib0WZaoenXck+wDxdjkEeLgb9+gB8cDkbXnIc9gl9hpIDOxLEztI3elWUkPNDrKcYQqbwzEEil26HmCWEdMqd6/eXCAQk5LBBemkC4g4UPZxzYutddmjPSgZRR0i95uwhe400s/G9F1YNNb3VvYuDL/nbEby2FNIZCAIChrAncVgJUXcdcRGprFwlcSh3Pcp/2DKkoAW3uggxS2lRy3IoyQP/sVHzegbc9FAzuckqp0GaMoWf6DKfx9CapG4Y18OH0PXjw4LQRXkmB4X3Wqg8sHWvHgD2xGchdGhuj1Clo7B+imqXT8qkj8qitO0P2qB2zB2gkiT1743XWvaXwwfzqcXe4hv0z99p1m0a81arI3cWr4HcCaphiMH7iVgQHfQ6bOJut/BQv0zehLowOAXeXCQktGIfZMmZgKN8lJhZrS5fd4cZLqN0PbfdvYL4jb5X+NoGko06KgbSXrm9k8o02678d67Tc4IjB6diS/MnHfrjCgLMjM7pp1rC0Xnvlf3kum3W/uf3Rfz5RMXtQRxxxr+XhAQE6uv6JZViGksF6q7S59p/yhgl/8PP53TRgBZ8hbK22foSaR7CTtO2K1cXa66QM5J6BD3p3SUN/AWF1S/8vpHDx7Mh3WOp9vKWmoWWBWeyFgyplDA2/dmOsN/rNKCQaM4OYPPIW31n/5TlMrqV0ZLgDDOm18M50zbjfEGnRPXecngiFnV1AZSF7IVQf8ZbDXb9+V71HC5j2/WfGabapbkWWtvsvcNGSa78SslM2baY8hTnHo6shenMgzOI6wWba8NWbniJ7LwjZhFTfIy31Ghe3We3G3bLraeoyD+k6nwOaI1709aI+LiUJqAWzS2+0IQuXXvVKtxYKbV7JdetssYj1ePehpHUuhzsHu0HY4u2dSrLp8PJFv0sNKLgqDb12Wpv11W/UKRabDBAywA3N1UFZ2WHH2KtzjOH6G+6HwfKQezNsAHO3wvelL7/2UcXCsn/H8L5wDT/nUUsrLdN2pXxtRwuT4HZ7QXiNUxpt59cDRK02sZWs+72NQWmb/+JrUXTJrq8X+f7P2ySYc8mAa2jMRZD1z7EeshepUfr6U0ZgT7BFYMykd29TUK7g0WEAXnph3rDQFO0ZIYOTZ6mNqTDj0zgQ+GaU6nAZErR6GSto4DJGUFmPtFw7RhRqyATrg86CfzKRzj9sE32MpSlEnG6lyTQGE0RwM6Vzx8Si6QnsdoL6jCIWYLPo5y98zt9IqiA2Rghf6lFFOk539+zO62zUyJTcFhpLD/4l6HkN9lwHS2pmqJG8hxXVR7rNpdMC3ktf1AhBN3n+LIRoH36rObimAQlF7PR3GvZ5VrHBKBlKWtYtYXb2nLZ3q3z7/itpM8A/odmcSmCYFxAd1pBT1Q8CGLT0soAQxzNBfq6ALIlHkeQIlYsNJuzThg0U2CzVz1E5DWLUbJd28N7CL56QuqvwhCiddhmFVPDZAHVdz7gOqTbTcBYVOyp+GGav6KpJMPwZphoBIvnyrc2sej1n8EirrujE1vYDih3+Vm1l+NaqHvvaqv0L/T1JBNPuRaNWe8BQg7rjHT7nkJmeb+6wtrj6RRxT6cNQa1JNBm7y+uUsHfnxQyRJUo1w+o+N7GlMKgsgYuAu6SG4IKfbS03Ql8J3GLLIkhL9K6Qh8zyDiII3pRcqnFa+PHH62XaSSmPLMAJZfL4PLMtCgcgHLKjtNACj0kQsOS5yS3WvJLxVsUgktSSVWTI3Eu7Xm1DFs4fMUK0GqYsJD+/axAqZLRwYbiHtqbNsHV+57rnmLGpvnHlwTYNFZFI9UgWXXND/O4B6YBGccVPQoYeQU9mYot3QkRbS3TWfCdtFlO+jZeNfJBviNORQT/E+0Z2T1IiI7nlsC1bKQUcdhQHH3PzLq3hT+PFIcZOUKgLE/uMO9pp8dGVQqAAfjNTUm68FAIt2A6eYrBE38IjZxkCBnu99H2q83FsxMC83n1GVYfCRl69SVny2dLLSl9lXvBgAHtPe97BAn3ccDLDNGcmSpd+RFkp66nlA5+9X+vCTaOLbFC8I5wVJy4v2AJD6Tc22KpxyShUKjH1W5PlAmoeduIc/AxnbxKfNjrJC0CoDHEUY4LBt8uwSTTP4DbEotEnh84UE300dBH7cmTTq2DgRRXCAam9Vh31+KO7VaqcOc4r/2dz7+3EwRQPxIxgNFAOSO7Hdaeuro5mTQ4DHBfeJDN0LgpI2PlMjWKrv7ubaWvEiAvqWrEr3n+22uBhXfP2KJLmCyLolsmu3z93B+75YIllbTj6PZ36jtK+cy9iLRTJKEJOL2K8IS//FnzvA0P4LywfjFwIcwjOMVQqmPpP4+QRDhbq3C0a5XDAK2aC7f188KdSVpa8Ns1V60niDsUWaOgiCq7kC7+ORcr1S+96v9JG+X3s2hW0gS7pFP3Xddeudo29dGxUV9tM2XLWz0I9bVjLEJz6qmHawYElAdNIGX/92CbXbVQl363rJCyFN0wbBeIn/jEPPe4w05NUAp+XRoDsyxS8KbLUzOgCEYgFXW9KeESsaqN2+NwnmnrKqUbuYVjDKcSZ9nIAB4d92vIvefXX1MOjqQUhknLCwpBxkBCWvczpdXQ5Tng/GOBgrjJubHUHLzxLnVdkjI+QjIEvodKSKJQmD0l5ogFaHyDEyBo1QNRVZsZT1NpPktpw0DZbQxZiR6dB2Mp8jF5Y6xPczdTvjGwK8jiMcaCzQJqvpRTNeXizIZwyhIA9iANcmzGtK8IxRXDcxi1fUgxnWDszhAaCbb+K1VXI4kxBo7qHuVvEeNQLO7hAdColr2yQ+iz51aMtR6hzLhbOblOLmPCwzBk0I+tS8MzkZZVYa75RFayyu1zq6eL686APGVgY9oU/DBELggD0ylBy/hGrYhnwRV99ZfeBCVi0+3NXT/sQ+477qFi4sjoSICk/QKpFExljgeipDqWKgj2UZmK8gyAY4MjfoCRjZGoTnmW2bSRDGRmyhU2u/lvZVPoTZt3ciaxt0PAcUoUN4ZYnYwUcksUXm2kcHrSHEvqFUznGnkP+YMdGhhHWDdwlWYEUSJwYr7INgjPxkklwzKbMhyj17gRyzls9S7Xy1CtaU8saN+7j/JlBX54geYNauA+mJhYLaXzOrzv4pyttQSijQN65RzOOEjZ0KsICFCknCpDg9/IVw9YWqZsJu32ciOtx2zvXDl1+90Wrg1ULD24Ny7sbPlAJ7T8s8V1ENwlX116pKOFsN65dhikDULhaiW9Y2aehAaWTi97pttkFLStTiTTv65LD//hZMEq2Tcci0mIjf9nIfPsXJpDf1aKNntCfGoggzbC9MhDG4HEaTOgbtu13y+DF9hD0V5FpicFzlaT+yINOTq6w4nvJH2mq6mQRmNQuTIWuGXptlqBLF9TbadkRcULDAljKT8ao/d/oXhSVqm3poBQEGIf5+YJIFmWQeJWftvzcWFYsKsTCFiptq5yxyIanNnFbJpG75XIlTecr9+0vquso9+Nen/Lsi/u0pr5esiKmZKUCu07J7O64J5sjeVxTvFGevezyaocw+fEgIKD4hcI4p2BNIHcMoAI/z58yNm5/4n8KqGZs9c9/Zmp49QafoEM4W4NJYb3yuC1+y8ryBxkZ+sP3+fsM6kimAtXV0JN34tMgAfl3D/17XuHRZqhSKZXj/Xulfehe1rLXhZT+/eTl4del6bslMj3z7YPPbJ2mmqk9Zyle90TDyGjz4Og8YwTBCRnh2UZcBfu/tQgqlD0/TuSs+X/aRfTwvQCfYw+sb3fl9IcVqvwtCQKiekTY3aoajR26/D4CQjlAsBXuQrD7g8C0U33Hcfw5BXffTHA2UBGj+LpCCBj4RzKFEMgUqBZb6/W6ur0PkZl3LhLdNYYYjdGQlAk7GXvIJDgpu25jtouKh6PEbBVntSL2cJfze31Dc9szibawGKK0N4emqtvN3dy28LoPYFihoRRqvwwvtMxJNWrv/vGUyEVRrIwFPkxtMSoFxcpAIe82Td1teGR/TfSz4d07Pl9HI/WWG1c05bD4fjTQhCDC5IP6EzomiiW11maj1qmkxoq/LrK4zoDmOyWXIX88hMZWFmBff0oISmkgt/bpEqd8/Bf7rypMtuh3QgBVpOHaT/8lRmBMsQni3gFUDRajFCw5K6JchaFGyejqXvVhkibdkX0RjJQAue63fz6QYZWcynX5nw83Gnkf2zDKEDKEdBXbZhZaqfcOwXbFn2+Ttr3xVFB49GDXxPCC24TtzgGkbEp1Hwk09tVNCEuC/8vs0RbEW+ycEZGEElhg5N6lrC0JlxH1zZ50utTp5hEs1W5Jgt43Ex2fIhnqzks2gN/zpnwZ8wDdHXoRMZMaOxkfNPa2JxUsILT/AlIJPfTulK/CjbolHwcQb7U1fRfE0zCpnBijfAkjNqgmnuoNV9p6Qq5UDXFhTHjmzeA1NGiYZJvurSFOyH2mu5d2CEV+T5EgpT5VIRHH4x8SXSqgOk9ld3EmrR2JmjUJ3A9f+iU2yLXobemeJ9RijhE7oApIQbCS/azO/CyBDndngc9iaDFEzNC8n8IZQ2fIUkXB2hPBKTw04WniS1GRVXLqCVO4L6aVCtO75lkkQfCfD7WDj+LTyuLJFIyou/TXQhEjIpdz0Gjdy0z02HaE/y9+rgW1o3TlOkk51tIrJk9NjQu75l7W+LUxCVoXPI8QFyNUz7FHXGp2YQ/8EyAEU4xk0i2FUVGpusMdEXOZXXwRZu5dCm95EgDgqbL+r0zksU+MqqVYxKGhv82zJYwQ1CsdcOTD/ZPjYCH1Q1C6K/ZeyDiTS50ObJVr6McudihskXCBtDoIz99hj1w4FGwXLsoe2fqqMX4ajlLjJNdnqhLKkF6i1r4pp0ir1lRPr76y/MYL9TJRf9CGeDxPQ1yIRf413iJrjIv0bFub67RTM553n/fKoveKbBKttXQsFvzlIt2tAR/HxpLNsL0Ws2Jmy3sprrpiew3tSMvCCFfXiym1EsfF0eFYMnPqFBhzBwZJCE1hMrMapmY+Y8b9Q6d52PT48jMdM8AQs2uW92BRoiNcptdZegjLzEfJ9WUNghnJn1/VV24NCp73IXZArsxwvK5rAsAwcQ7Lp4RxZLKh8WbW0HmQHPQ/s0/k8xLqxP1s/XlxAEQ5ki+aoai1GSFVSOUs/AzE+bRA4ouDwxiIN/vtoDgbr4eYAozTMPz6cIVgqyGgrLoVTfE1eurLmVsW5a84oW92/4kdx/3MA9bJbcyFF5J33SPjHmGhAJuF3NsDfjvOv8x/agn6oEqweRU4RPcb9cMqOUmz4WR+UFugvDBslwXeNuWh0yFhB/Ci/761oIqC4ghOyGM6Yg/UFmMrRlecc65HIGg4pkBgTll/S/bkFh88k2Y4A3J+vzQl1uvr5AFaBP574wT8Tf+YCt7DUfSesg0cDwy8SClcF+hx4O7WJCVBW8JtElAycdK8KkQKvBXjIid/zaCZGi8arhNO8g754FCN7gIHWiwjeWnCFwU8anIkUxbAM2bTglcob19LFuNUuZ3kRRjY3YKZE2aCz47/sgkFxvmy1ffRDRhcpzObv8bg3Cf11z7Z/uCRp2uIBmo57b4Z/aa9Nofhq2nIPmR+m7KgtfXGIwoYHiJiIPvOBc+8P+/X8GoLdciEiygJg4SXagq0ymZWQ0Py2K6+kXWNFGX2xkVRnesbsTLTCOahnqtReAfoszREJCPT3iXbIRUupjWE5EOkM4+GdjuPxatNiUHHoy3UGHKEw5D4VSDqcQuY66040y+5eR4CTIWoL3acD6g4fsDgKGghyjNcuIvYz0gEag4NVs05P8XvSUPd1L/8V6SJLiyWWN3C3pJi3MrZRYd1lHz3hvNLtpGxIJoiuBF3PMCnL6neRI53dWCsLt0bJoOtFr6ngxYZCjrHNAyX7mGvoIQNjQt6PkvvdI5iqp+YBQpMpuO0+tExbofFfeAqjslAWDS0HrRx0NklrZUybri5069Y/kHnCPDpLBY5kqbEsLMlxtf1wlcza/fkmeWpOxvyLs+iM8sfrnJl4i6HtLAamJonqdMjKT3i/4DUvPfs8nD9Bf033E+ghbWBRRrXcXJRBKNIJU9txQPgnXVu+phcodeEqvL4K5avpOQboBfvbc+TTigSZ5UpQr+0bl5qz+z8JUDYb5drKWoE36P1GtozpbfuSfnVleCmpSxNsFWjloE3a9FwW9WhK9+4zaeNbEOQwF3svOdoFjpfZ4iNDDpS6wuGyH0fSn0PbHnxJ7nsq0ux/6eVQmdcslQ/qYlEDIJdBFvqgQNpW5gMVpIP5VKng85lxQUOLGNVszjoawefYbuOjp8T0tIG+/YGAidquli72EuVDD4pV8pU0O/2M7FUztWZE8XJRKzQ/D7gehxBX4CDF4ZocTq6dCT3IyfgLkYVTWZ39zjy9Ic0ZHKifsXmH4+KeM+7ZKNLfpihFTHaMuUMHDoamrlooGX9xw1OZ0zubhBCSikoCa+tH6aIm5YuS6Kv4oqGZUKb0WBadu/YPpB/mVKThw+fW7L5rt8Uan7n0XdUZ7OomwIXf0464GDMywDOyCR/ndFazyeu0mviTs7p4WaHGj5UX5Ptq5CmceSzFay3HNMyEIkemQpmTZluIHQ5IYSslbubj+BDplvEdoj2vSv3v3ZhtJVco4HcOuxFcNil38tk7XRkiaZmDkHpUgtZzyDzn4PxLCPoNuXSxSlKEs1HeeRjP9yjwjrg/XCcGBdhTvZU4GGKlFB112qZDzUdj2/7CLkg4ReyxmM4hAeART4NWG0hjoGS76pjVgmJZmCBnyWxBfRVt5sFGTzFLvSjlbI5KfRInG1pAxyi95X9rFneVKxg/4ANXdyMRa+aDAtf92aLs37KLaLLaiPup3H67u3g8Di0ye8E/LC5H+oSSLhbw6Z15Bkv5j85kzD9kpUMWy/OmElTwE6hyG5UiAAVPuM9riVZ2QYwg/v3MtPIHxk5CC2Fi0UYTD04jPT/FBBo7UdosOrxgxl6U+Gv+WcAkwMgEY+56jNtgl3Nsbqp7e7FXrCt2llj2qDYqXIVPAEzpRR43B6fi4XzJeGkfuJWx1SlZknky9OJtmQLjrqrby1IkDJXGl/qskQ5CZ+HlBCOBs7eL/U404g4alu7vmIJ49afheUv+Fj53jtVAsJOpd5pTEzh4riVC5Ee+PfTRGPWoG70tOLZnA9koZqSXoBzFN88Bk97JKmwZvNlIvey95f3xalH5HtJ1taSnuN9WNN8pvzsiLUGEcFd7VTiDfYWAlKaMehK9uMbnglK8iZXRzwLPWvFth0J2KMqJTOJZ1v5zWNMCRQlZNujl4Hbt46qS96fUKHXOjFCmxDFqgT2owq+uYijIR1viFby4cfVTTIxdHyk/rdh/iEwMruLpXxfZo0ACkqo55SQpykh7jT0YHEosiLu5YQ4UlooFv8Ti2kDiu+HkzlDxMv4dhiVwYLlNhR4rDtpILR1i033n1A4oPJYuD5u4K/uIVnajKmHWC1B7NKGYj713zcNLbrKe5mMA0GeMuQ4qrdf4Do32gZqHBWUCs4ce5LNDwhFPK4/zRzYHrppucc9x2xOK169gtt5faC9LBmLJTeGEtUHtwTxFfjzaaFkP/RZlV9Pl/hsCNDcLyOjSt32Vl/zxDJ9MwE1lXZy4sqsgsbNn6XnTVK/IGjaaaXg+D+oPIC1TWm1DeLls27bArkQQDAu5ezZMnta92x4F6V4jBs3rrxk4rWRiJAIW2SxUvy0bbbfWBjquCxkRpnrIxJm7zvghQsRp7CdfjT89SnifurJRfBpZjzZ4m+k6dBCRhrV2NDGHPkOEijo+BR0WLlS/v9fESNMwJAf7q5t87RI/OiNxjK1/reUf6GZSWwd2knsf9mamMDX17ZWvthm81PiHMGsNoAhan9/GFBrqqXNx5OYkuA+8OiJHU7J27d0HYju73RBAVSIDLq0iLSR7mPmbR46IaLqFX1xVYyo/RnqM/AQRrZsLyGcojyCb4yiByys3cF55AVofTX979aFkcqm3vJB7PslDvKu4+U7tdHvFtMwcqgpXWoiVKpK4TvE7iRrmd5EBjKFY9rjR/ya90/2fOArP+WO/f+I82HVTf96P486HEmUnbSQbtVqosMpa3gpJqj4o2kw2dnzmWbZ9Mzq9zY1Yf/Cq1/w7kqYyldfQFOvipJ7Se9d1rg4f5YAXGiyVFSiWMC8Dg4ShCLrZYCRW3RbmqQE4/MDRD/d9Opg/Age6aACDUmFmCxJy6t29krG/fwCBNwDMpC96ByA5kHrMXItakOcbH70odOvgIKAO1Rw4ZgZITkDUrwF40VfytplnVQ6Q5ALvqTMiiLtKwO0xBvHBwWlL7owMQduBaHkPSZvz8lz0v//zMGNrsKXlqMZJxcWNSdG0rmjIcdZvfsJ17AjE736jH15MwwcJGpR4wCu85beCWO71ai7VJmBjpkrSNiw5MZVCQfs1q8CXcqaqYFU0//iHISeXa22JiBWIUaXYJjQ12IY5uNUg+omHUyfQGiCJa+iHpBjP/SQ1iuPoOmKmsa33tlkms/hsW0dNuM9rA9gKA2ZKwzMJpipxKgK0K0G0ZTnB2G1tFDkxQtIT5p6Uf4zKdoUOg7OrzqtQFQQSRL8rN8PSD3Brhe/GQhDSuRekoa86pJNywyWbuYgG/0gVS+gSK81u8FUmRPn/R7no01THmty0Q8mFluYqPgKn2PV6oRkeAkJYGRoQFExERiAIz9En6sPP13ZtgRbF97QdtPhwwRpAmBdKdwPWortX4WDDbPpevwKEHrE0EjOYFVifKtC7K/XyzSjvkgS3sKJqCPYt7mQMhFrgIIYoH6eCTTXeyE9F/z8oh+WQ4TZzf4a5vpZZYE+ismZTJoRqVUX9GLVAYTS8bowWYLULw7T7XNphzvmzsa/5lOAv8+IyxokzVBKv1RVRHZc834YYI3b/ek4J8GCEBpC0zvZ+jzg3911qDBTTMGQ4Nw3ky+5c4zIKUaaIMGruG/fHCtLk9rJkzqyo31JCU3619QtcYWAbMqm+GpcFxJr6IXuXpt2WGclgkNk7huuE0z6CaVCIB8IMWzvaPNR5Je+BF34N/kPPGT45k4nbMUey86iLmEcKW5s+1xOVTNlVMEc2yOGP6PEKvyM6y7ili6/5jkME1XTA9up5wdZloYINaf9tofDlD8u/rVUs7USs2Rf37CAKW+87cc4yfM79TuWgojd3QsL+zExDmK80+y/cQTLjoHBBPC+CdbUFrk4NRmOmekwG4tGHrbkIhP4HDIdL+fFqEohgAN9Y2Mi5UKzcfCFEJKOA25G0xt/gOn4+x0cZyn+7nT1uFR5xbv+ojzeo1PNww8StOgkcR/gaNGK8CwbbVWEYZYgrB5nWd3zR+PLL7YYMRluxjnc/o9j7F+/1QYkgnE3jEoSyRGeLIQ+CYjHKp+9rTGbHCUusPg0ZnTLmuwsxikH6p9DOeHYLcvZC4nKzW+p6gmjbOTAkbUlgKjV+Zom6xpIJcwCEw/z7kFoIi4KttwiIUim2bbdfThFP1dgqgpr8vayuK1xJt7+VM3xlL3yneXi6SH2pSM/qbcaTqICkHw8At7WvTiakARdpe/hOqMLrrbgWei0SZSfDWXWwGGDRBw3241fHDQuZysIMV99dwNvKuSj8OXhMcVxZEuxf+2Tnkd+jUnM8aWaUzDPnqIxpOP9snPSZEhPNB5YtpfcDJnrNAUdfjQKfOMFigo3VLKvBcK3Xi5KoYaNYeo+V1HuvHpWyLaRABO2Ny8Cjhe57TEmp7yVe54SuIuGRsL7MKsj+7VllNXtdFm0QkhdFsGQ9bCqMU3rWbEK2jBIYr+bTwEaGuJhnZB3lQG87kzCk1MLMxB3YGbmLoTsstOmmTeEKrMP9ba55CEM/Ji5OUWvXzPlvoVXT2Ubb7w4NJC3dqU3YFx1GDfUWL/82UYVU1rUZd1u4n28A7/TrRqmv1wD6c5ka8Hd61fe2EZMxGV9EC5jxwTaGpVS76w4B94r6uWADf7YE9AkaDOIXYwktAmQvo/Su44W8ItJH3VqiKqYzqMmrXLoYQQn3dP6iQOTYiaXd6wUFHyDlx/QUiRsyo+YxWZ/w9l/cP0VXRUjUuicpFzDeGMPLaYPm8PoqvgMzR4J054r6om630oJoV2qmv949y8++C3AyIvwM2LoiGK0s+9l2Y62Jkx5lKodjJu3TRrVntfMeVkqgyDtydEJf4cJz2SgS3HCwdTfMdTgzr82A64NuN8uNyT9pVh4RuCM4oHsg4+zGK5w3p/01J+4Pf8uun/WVT+zHspkHXjtbtWoDsDGgg3nan1DbAqDHVEMzT6sVXDwYseu4Hq8mGhtlWMOhjn1C3oMfjtdbux6h0I/ypJBRH4p8jg+R+kgCZZHXNmGjL6XclHL4VT+X9Ms0HlypcNH2vWgJ+1Oh+mImZjUtBPN4ffYKo7PTZoSxIHgq2N5KXsZIzkcJUBIB1KSMTXG2YHihFrP7rjmmTztUaRcXn+tWgTA5RP2EvDV0v5Zztz/LdJBDTLPcSvA0tqhgHz+L24rTRmQyQxiKPNR/TTGu0gV6V1owIzb5Mc1FoQYsD3S0wTMDqzz+lvE/dNJ+w8wFHJVZuBjpti7bQqwUSuMJbN/IIeh2Rf76r7JBwQ4j9GqIo5sNnqDLDeD8YlEtOp9WtZDxbj5aJOfqL4wVir5Boi0by+CzN2kmEcArv9GnQmFg2+gzl7H/u8TakW5F9WlRYr2Ng5sDjquECJLWs+Eb8s1lN5TRFsbwaKUh8g2fK59Y9ykitIoqeLau821bUxqtx9PCCbTwLVklQMV22QEMuRq9jZiLWeQVuKtUgKKzfjRZ0yxVeJVee8SOnpfzbSdDhuZZvq2WjcTGKA/1nFePWc1xW6i5kY4IAQyh8uu52w+NRkTScVuqWrZ56tl007JwlDgHkboY+BrqhzTlN7nssiEBDYxGJOjZkMhgtYnJhHKJeS1XokwdhhcC6FnhWyz9b8oY2A7k1gn7xn899FHb7zLsuR9Lm5tUibYp4oR2UDU+N9yQPTRnBMH8j8+7iQ2QV0BqDEqkHct+sTIOqkGEo80isJiMDEXZpe1tLekCAfo4OyfPcURlQ9Me5JLa21KQlwz96EMXfaPS14EaeLOB/l0BAGeoEq47GmmCkVmHDuWAsbchmamRbI1jSNDucZBDu1BZ99l64OoMMIAaMKEvox2E2PPOxiMi0+wlLsPHEGoeTiuQETi0SQs1kK/drMLgU2pWUGJbHrJws7GB4ZhAbShA6aCqKmEbXzB7Xzi5qsMJyio/TA9YrQbhdAAO/jWwNp1u0LerSe7fMEe+Ve21tIUp3l1A3ZKHx0urJ8rX0uYSFs/PRs+89XY2wQOz9zclrlRfNwb/wxQTXw40hHcsDMpoQQO0KdvFzD4PKk94kNk4B1lbin84y8ry1NdfP9PxwWIjN0w9+Mim4WLdeK6CoCJ2TF9NQy4IY97bIZhqv3NToWahO1ZqFKKo9r4ZcNR5GeeCwPiwYT92PzWk2sGM6QdRG74jKwPIvL9LkD121CDMcj9jLC4NGMUfvvCA30v9qktnQ0pJAzgsWE9MKtLQDvZckyEjS8CZhBlHktQguW8j8YPMI/z5aRYeJURcLkqT28dgSt+NVrV+HC8PmHtxka3ERGKOfGP1UWSAR76TkmmErY+SNBdvm6wRqYQeORXsm9Wz9hsg0PzJLa11RkdlTj0mB4w3ZfipZ0wOJUixR7Va86uhz2jNRUvJ9ytpZ3CH+JzRj40eqOdhjtfEdGBhIH3U2A8Rulb4nI3j2sbh0I/b+HfKJN9tdw5zf5QxsyDVHL21Fkk4VLcD2FEkaS0g4MoLw/dtG7ga36DU42l43ls4wINv+3m4vAW+TqyYpO30u647HnIzc4zFLeKNTZi1EaEEqUegMPxith21t3/Nsp+Vv5dCvvvZ52o7H1/JmLgbjPX2TcNkmxq4tbmWlC0Djfox9FgrD2LlLilXFJYefGlTinRcDc5uJomXT6b7RSM5Rh41YW8CZEL38Y104OFVaGf982SK6Qmy1eoRn83tr648J0g5HhKg5XjUhrpTrCk13edhnnRcVj76/tU/G2a+fMfnhtDLBVP26ondwSFBEBgWRTaiBP5fhionEAfLKKUbupMj2iA73IQE2ftudbN26GUiB6N7ttr6ayEJfI5N17Xxotv5nKieh7TU8sDsFjKaOhMdN5NAsEdxqgyrlVVLsZDT1GhisW+Olg/TcyhwJNirr09mDN7++ALEn/ihsVRwwzZVS01ICSoScZPX2wIPk2AlJIoAb7Q57G+vyOqVDqHFRbrMNfwCLn1vFQSgaC5281jBKLesJ+1Lm4p8nTfNZ4SDi234pSY2wTTIDlnPKOFrI8/85wFBZFDau342TqkyB16Hz1pnhdEQD9fWX+CeaYSp3cD3+QKf7baZY38FXpfPogifKsbtMVV7mzYANxj4ns73pS17a2sCvB6fcS6C8POvFnAN8iqSjl1yHOeQL7RhYa7yV1FyFuM1bWgkuaxR91J41IhJMilneHJQ1Dtv1h2kz94geNHuPh1PSttCAdDTXgBwD5WjHEZnY7CIrHrZumu5wTStBTRqHWzv9h6er+KcJ49EWBZdYhF0jRsEwB1GDiUTKRckEHToS8IxsqLj5ARmgXWeXDprHOJRtrN3o2Z5isZnfi2LM3+W9ZnfNWWh9ioWmVmoazzAf+MspFw8cTRy/JO20BprVftJv2Oxe7eq//Af+DW55IA2aSNw7MlOZ+s1OGKkJqhSEUIZDhU9MGlV/MXCw24MvaSATB9QjQo57oY93oUSbM3DUWP2L2Ii77aPKNy2FiXkHinYtf5aG9aKW5dau5XkOiaAXfBeb0pSlzpE9Cqa0tMUlowfFiQr4DSqbxLFQGxbpB+t6UMVLiBYI7YBojZnaA+KHFqJnYtCysCGFK0VXNb6HHgkS/IuFR+rOsqoZPJ1oUbwDX0I5C5FPhkqPrXCjYD0aIEebI5m16ZA6PPTkSjb0c0jMSmX8ZezHcKoBJ3pIp4idy+DC/ujKQV/8tpU8xRTbQwTFxdzXOfOiyXGaIQsZgepiIzTtIjBvmnBMO2BgBtHk92yTRvOcP3nfEQaqa5bFw8NPkSo7yFGIlkVFfcoa3kldB+/v+fE5lihH2RaLAMwKSaw1RGGUEQYAh/H+gcVmnxWLRIhYeyNDXKvS53w0dqqX7wShBFg8BoGDKxFQASyFcvc9VbhaGFCt9U8Byb7p6V0aLY8J6WHz5eNd62yK9b5TGPatoo7AC3xJsiv52tBibaxhvuKgQi4eYccxgXCVxmY3O41S3QwV7AZmPu1KI47j65hOteTHMUfOzWxrN2mdBz9HQsZ01Pdb0lLoJmokeMkNylhaAaxKkx6THpmIRKl2phwopFA/MoZ8LdlJBNNL4fsyvK6NkeyRzTMYOtE2i2KxLh+QnunLsFymb6evVocNn4CjpH4YYV7AYkS3ZaKRDejv18Qi9wxnbqTQsob30MUH3GUVdwSZduCR4lPSjAtWBIb7RyMnnHBbK5nGym6aQMT/m4wNHEcIZZlFq73JJLC6RQCvK5r+AR/Yo2ZgwrtjKql1xD6bZJJkIhM4aHHIAiJUUrlR8uSwI2uzOIJKpf6mQ5fn6Mm0o1NQdGNoOJAylk+UAIdSWtDwwWxs/aQxFE2nkEy6x9hr2xz7S1gdS9+Vigwr2bV6lMBMy25plTetxg/iSQaqxTtGGAp82wvpkYrtxsyTmAoBfkrPJq1cQt2dt+4YXt+vfS29dgb6r0X1VPvUXe8Qz3yNnXX29VHz6vb3soLxrlNcRDxFEMgC4CpMg/riROtcrV6I0eZ1dmUCtQ94b+Qj48HsziTVFzkCK2bbzb8EXZsv1DEF6O9NbBmymijGtk1rYP7Rdra2u1NGr40ubXmtbxgdkOw2VbX9LoFdzd21B7+q0XWcQFD8mn0tgAu9r1+ivo597rRbtF+Es0RN7AsuufZHkEd9U4mKRBjdKSSrW+INoNVji3HwGTqqAUe/WwBJkYPhOFRVg8axn+erMyTGeKplm/1XOPNJzhHyg8oPTpxCSr8X4ierKbBr7Ah1QyzPgbEE24W1Y47qx7XFtnRogsX29bBmONlQOVQ+qIBBnOwU9ORcqM4IgrLF03aP4zXeXltuyjKv3uUK94CVl3hdJKB0YhKsSvr02PXHJuwCee3ibUMQvwWZ2ntniLoanjFoNxtAvMMNNfaEDnzPuiqoPUW61LIIO/l1UCmYWQqTDy0Bw0ORg/46QACx4DJVcFrS/ok2TWCpqLo3iMwZAaJgQfxDCZpXXVMGUx16161p64buoXESE0701JKjfalBDHYcHZOhXvWnN+RXcu5w4ZxuSiM0jss4P7wZuESPnAEVhnsFwgG+Ara2ZbTAq3Mnpbn7ml5FlupZwLCIhDHhH+hACCCuYulaHFwSFX/ItsZocMhILbbMbVfHogfRROCzwbv6rl/WJ6ndwHm9wrXusXI7ZXghtDEvtk6R3jlUESAwWn5NiANIPfKeDdLF/TB8ziC015/qDu56ExDih30H4IpzWKarpii0QEfc9woBOn11+A+uptRvyKqMj05B0IMJnVbdbQmFzp44JN2J+gfPdt/e+7xdrfHW4XVDPW2JUJe0evgg78fUuytBrukEdc/dVo2OWDNQOz1jtYscPedvgYkpvSAXdnv+9u7rtGI8LHgPXGjmSm/hay3dJlsqdcmMnGEHw9Ll7H9W/gYhfHWL9DdS7qymf66vfyY9RZNhEE7M390B28z81Cv47aiPsh9IerszLBoO0+irjdD6v2uUxSHtB6mjV10Dt4XHELgpFTcs/xE6JwZoyFktjBFYPcLEwsD8lMBcFhE+c9Q111j41f8WJaV2mXPnjh3femU8PH+BQPIjDAr8W4dA9kaJePpe8ulpzpg9R8GO7I9k11ANH/0LWXXg5aofS50kbd7w5vq2qWCJtjcY7Hoovgwkh1al+1MrDdFqQrT4HhR5RBwBoMVG6SpB3y25I+rp5xGAkYJBD6pwCzsupbhhViri7YIcxSaAqQvx9u1jeBItJO2GdRCJAq57HYUxHrjf79e4Zv7Gr51plCNkImVEQq8RZK8mRSbr1PXlAAfCBmoKXGfh+LdghWR+KUsQBVYIluVTnlXZBtJ9NWGv7qNUWFoyAK+3uthFQ9LC4eEWuHWzk+h8USEXQPzXMd6qbNOwXUg6Bh4qqIefjONJf5X5jjrNVTzzb8uRNAZWZUZODburFkExtBCzSYiDMYe7T6KGafd3yAJDFYrNVGyGsGusRomoMD/dAMJlsTwm3U4I8/GCVmEJm/y2rvImNZEhgVDCX0jHCuQytthziVmR7MckquS9fRSkt2mZzouAlLugphmGCELbfrnJCA64qJzxw6ubs8xquuUKyGkH4fm++6a/Ypv7YHp+tlR2+BIWZyTPEMGMCHuPllqGe36CWcacIamCMVmEcMUxq7KID8ABHBqGbPs5REzbxI8cy629dpgNYXXcCG3RKZVS7q8UsFnqK6sCkUq4+B9q+9k51zZUmsYBoUm1zc6bT2CFSZHSaicXiALGmAOL5U0AXc4nBxbWVj7DiqY5Wpfrcq9VEHTIomab4kXuYDBclv8uri1t+IgQw/IRoG7e4D7zpEcW0t4u9DkO8dJpv1OITn+ZR8KoGPyg78XEqDOO9xcDS6Vi2UCSksa0DKABtku+fdEg24b1H96qcZuh0laYNnVq6BcY4Ph1Fzd1c02QYp98hVMLJ8QH/BaSGT+BXkYdrfOud8Q/tQkLo7BJqxm4HY52tb1djYqFlBnz7mjzCHp3X8glADt6WTVHQYcDRjrhOdnMwXP39ZatXdTvypBhiu2WcRQqDdJYClF40GCTuywFRij3EcUNiIptrVYEg0HDnHR19ADZ4WBaJamy9Hm0VHmnWIoiiUga+b5IjQ4EAOQI/cPyMGfWUgmpT1RHKWicmdIKFL6qWNVpedMcfNd/5yXkAuw8QkEvJg1SGaYsEP67zoDqE6bECqxt20DY3VdZTllqcMO6kA4/eEZ+c6LPruTod1Lyd6kWqgzszqIyXyo5zo1j6bbSKBKwdY7EiUqZijOTa8L7o55gmtgW+jcg4jlXSMZPQ0kcMcJ190sBIlGcX4cjuTg0kJHC2bKWcWEz7710IK5M8uNdznyNBTDYmHF422+/87k4EyI+6OugKI85TfOyJEzF04QJ4U2DoU4ocBCb294G7kmSBJICRs2mQoIa/QtRA/3fn7oXhQCcon31Eustabl3h/AVhx1FdOJYDtMdYwKrzglWJ9MUysD282xE1h981iLfc91fyP959ikBAwfSKz9+3TS28KJBLHXY2DPE9WTyEKDgFbktvnkCFPE3yl7+1B/XPJmPkrn9sh+9rDWjXRzWB/Tuq/ty7cuwRNesuczYRdhF+StNln3NGdtVTEOz7hNpTbgu6AfvKg+opLRpN1vSldQWgGrO9atzr8Let7ibbHl5yOMddsNRawvcABJ/5fmn7F4zco891QSMri3pEZEVbzg66Rs7AjUXfWYzloszdwgI5azF66DSdRrclOD3whrxdUSIi3u8YYmGD62+BIGGanKSTGs0Pq1tL8qOI0JthHpkrxcqMO/OqHwDjTTEm1aWdY3sTSNWz8WjE4dTq/8WEhURMPw8dH7LuTgKvvaTTlYlDwvGwa7hYpozIG6r0Zocxfp4Niyl0ovR7mWLeomxNs7yrE1o9XYtXumtbHCebqz5YMk968AmfSxSsqI6MqTbPSrCERRgao+jHTZcbB+Y4IibgNOgfnJdOKttwzXrtpjYkaaApf2Jk1iDhCgTOQWgUWycgYrj7127DzjdALXwl/VUWXgfjFoDy63MVoW3IRkbzHgEzBDqxr9k4nZAYn/XYegD79oh/DTMhQHauTahyIedxF51ahOfagW2/zUbNMMqIJJz5L6Jmo35e1t3jMqQiZ85t2CkLBWdZ6BPE5C4zi0gjaFWzJAMIcE9MGqnj10lwuBofrJsp3oEZl11A5lku90qH4nkkE4ohE8WTsWQvV3mbU7AqnoiGWPE1gG3RB004fsG9/SDOxQpi2tZET/szoJkdO2rJrDF//zLsvcuV1mg7bzwfybWxhMuAOyS/mkbnQ9GVkQwwaQGUS0y83iH//bGkOYxeEVseGOTObnWuuTxxfumgrv5Qk/FACmS1IYCpI4SinZE6PB9c2V66sRMC0iu6FD525wNuVpGvdIsQa1OJHTI4p0l2iDMccxOzL0BqjryZnMXDT6oohUwGHzifti4DGZwYMaN2H6aharTnlrXlonokbc1aSWI4Sc6QpPvIAnvQ8uzU6t1QP3KD2xxaVFLPzYrw9EQnjBOmS1fD1SV4VhnEzc9QUXF4xxg+2pHe9sT6YLdMpLD6PEnGjAW3N7VDiYhrHV7WmUjXyQAvk4Uagxf45HU0WNfC0avltpjbJ40mYZB7sQilQ23LltRhquWXBRHffk4xm5Q2/MonBzT2h2chBpX1TxXX5G/GSCUcrRexFVHcbqrdFGceYbww/bbzpBBfWpPd3VLCMHFqpfgQgegAi7dx6aCW0OhfdS4Y7Z0IriuMUbBsH5BZpreNPmI3aMgyll/T8pOWVY2tLHGInEg/DpBxDIFQKcgzjPtLWx1537dfe/SgLg/w6i2M0wB+J44Kfa6gllytqgqOxq891KpY/xZup6KVhud+AJtnkbDn4uwF5wXqnPRPSUd3yTCL5PmoQ2g6ev1/4smDETRX8pUx/fe/RzvFiIBVib06BzUOmcXADdbwY37/EEAaU9KYDsPocxcsq5DLvhRfDMkKCkJn8g7GCLLMeEMmntUWOKQ0wQthmiMmA5Yaxbcg1+iN/zmpQ8o9MY1UtA6xnigtH5E165P4SqMz4AJjgGbUlrz44BIL5wGke1DpOyoPikPPHPo9QwEuPRe0dhlQ7uGuAe5spTFo6AGZiY/G0O0b74IrpxwNOUKu6mU5e74fl6zLD2yJQ6tjkyrl6BrC8L30CPT3hCI3TZFsrV5K0rYd3e5mnCmxLcQTKyPL3YED9lNSdYzTmhwwBPmqDDSYAwM4mOjmSfp2OfIPlQ8GMV0t36ikGBu0fORagGnUPTZBAUemAmf9Px4jkPnRoWdRdZstNqM83RBO/3fC4k1vGAJCeYw0DoElzCkJSNxRicNsrAN8jxuTjaBPcoRfUd1rzXK9gglYkUE3F1u84J3KRHMCXE4AeVztOEVBgLmoT6Vq0WZhbASRKRp1jagSdZuOYlSN3+3gQig00bi+O0rcMSGJ9MZIgsjZVHAT77KhGteTuWNtfkOcEY8Mz1ia0sSI9hkqINyjycpCbpr9O1JUO3tInNpqn6XjZ1QW5KeWOZbhsHFhkBrQNwDGJ53cPXUwzdbx8uv3U9e/j+15/UNW4b2EzUIWc8LoEb5u1JMltYy1eeU/6rXroWmT3Z+iOPziPDaJm9+TfhFM6bHXuVeji0XSOTel78c10OcsaJ7jE5Swt5UnaPLHMgJqG2y/TjkoluhDCYXUnaiEm+uUtUZnW/2ssZbHBG8KpqEWU3HX0rHtcdTGLriZE4MECcblzXrjufQ9HzNWHJOS67Szn4H+dn1ivuPMInUmUCBvDArlM7XAZ9JPhmoH0aTK4Wuu9DTfBu3thDXl7SLJeDJqd8l80EgaRXnXvvWbdwsd7xMsv8srlIX0+UXd3NMrm6dm/yjoA47E30GXFwbVralxqDjteetpM/5Yu4Wq90tz+8klmz2cD0GzPLcP8iZ6cUZfFJrtz/RCQzUq7viR+GJ3tuCBZ1NQ7MeW2jE6iidsmrK5LT5lOlPlKF+TbOhlg2LYZFauhULURFZ+vsFIpv6LFVDKCxy7TSm4cz2QfLr03fGvcm7vuPxAJ7eIbdDxI62OX4WKsvxA5jQC7LdPWBlNyoWnkTpulxwaV+0pJAcOmz6UZ43NJiZH38zbAkm4EHgKu/M56tSksnL2MzDvLGnno8SJIqdACjt9V8W/mrMZt+LrRWsK3cQAOFdvjC8WCSQvTeODzWpVfjTg6ncLUzkuH5jhfxRT/i+xFVFISNX+OvEXxU8zq24qnQ49n9pt/rG+T7FT/StpVZMmcr44iQLc6tfmrir43glgPjfYydLUpxwUj3NK2n/F8yE+cAuyi/eAZTeBl7i7ymNmmyLb2pEEGs/hil7tz0b4DFdtkBSNJkF8EwktDWeQFwwoXA7RLPj8+oQ+l2g3E3HgwXIsG5F+ltMPPWQ+xhh6CR/vEHuw2iyV+dCVSjMnYJfDs1cOJsBEOcUbd5F7+RSQ7ltiHyoEl0fLYI12wL7NivDAKPdGw9+FvQzJ1sYGyQZF0cg14V2WiwVIj+bWJVfBmt3a4KXLUDnTzjdK0CWIIVDurW/TEgw86PBiTxjtNWpTo9KLloWjNqoMrHaoWcJlGltHXHV6U1cvmDwNuUXV3HfjQON4fnkLDVXitz4R/pS7uvIiMH5xUOjV2Jld4bn9dcniYnbOZ6iD206foLk9QgOGDc/ycWYNPg3GhRHTTFPSRTJfIOJCXlVo3y9pzDj7uoGYt3U8lVSk5tLwnBa/y4DMENJsyf2NiiAUTxMKAJW9hgtqIImkxX8z1yXQDYGBhpq/5uR9IxAAaqbCP6uo0a2Fuiyy6WbxYb6QDkta6vMlh+cvavLtOXdoN52S0LaccrHz70SSTOnOikCRDa+vN4hHS0vYXppiOI4V7CL76wLUybJZw5ItLDSM3xoMvTldwJaegZ1x1E8/KOp00T1Il1O0EayRpCjAeqLsAuaj/zMWyOW0bzZaVMtsxoHnR2UQTs0JlUrOohViXqXy6urtMxyvlWfaiXdHVemevEq3UfU/WtratW/jc2ajzPWJH9XFPrgzkqCgPiAMPy/M7/ZzIc6LRjMw+yBb33sOxMz1UyzUdlA5YaxEA6pAmt/3LXB37adxxVAqPrLy+9BnCtgS6iXSb4RJMM1QOyyxx44KeVvJMFAHfhVM6bxjH+B7n4PbFGp7puYR6YYv8GB1Z+Hd63A9MLA4YEUQRlY3mbowCBoR0dsr3dMa6+zMwUxdCRqVzgT6F1WaEMJPIrE2wCfa56NIsnINqWxvIFXLmxuJbiGPmhbNlG0j829uFFL7CbE4kkhmg+vKfHrmdrpoY2AhURNFp0bGGY6SciS+9yA53DZ+7K3I8d0X3TyUuIUWXYZc2EnDBaaKsgfD5HCQiELjxfEAKbRQgWDKn5B8ebG0fV0ZccZMEsceEts7FK1Am8MCwRe18UuJUEAtNWGsLpKn0JuPsYM2ULG+Sp9C7aDwFVrP15cGs5QJoENiIkivCvcDjt8ymjiNdC3aL+mBkVBgH5QV0Zl6TODLyexJQBmFPMnubNejktLTRz6voEmcb6JYqSypbtnd1jAyRYOClMENJ3Z8fc7qRTPA6tTleYrdyiq2xO11UnOxFWWXZ94tx7yl5VJzKMLjP6QcmrIYG7fYs1+6qWB1gVosZQkC8kLBgmMU79vQmjzk4sDwRuNAbCI3qICmItMV/boEA57xfyIBi2me3iMtCBN+kVIU9A19FJ+jjBh6ZMUCUvdwnoaaouWf9ts/GTLTcJFt4ycLxHlOgU99y+Aw6MlELZ+J0nAhbghEm9QD8ZZyr+EcfUyPd2NiNFy+zvutdyIWJUKefpdnJyiY8togjs4oC7MPNg7iae2bDCWzkKK92mCog6fIqsFRGktHPXPQX9d55IYuApmtapoZfZnuJyIfSJ93JuxeliRu3NccecsEsunJ6FxxsmeaNlle9sRPr7aYBkbnHmh/qPB8bQ/xFeMvrC7UF6CImUgXezYkpJT+G3fWz/CrUaxx1Zen3AP+UWii/uv/iViGXdW+LtUYlTyCLqoZlrtG8NySTfE5VyTyTRnlB6PXEk1RNJpSeSwLHYpd2PmZO5K6ZQIbQ9ecX+FGXxtieZC8MPNQfcZ14+NrB4YRK+uVc2DZUo4qWRiVY70rSEmWj6Os0ZvTWx78Q1KCo1kbc+9xqw5KmBW/s9UULeMSgsaPDoF6+gKr17QNenCvOqISTUuCE0IofpFUYx45EcfUONPNrIyNnGTuUbj44RMIUEYlyP/SQA338fUYPoPvCBoOBZcE+qJLjh/wp6rSjpyR4oPJEBtaNY2ZZmhkA8ey+s+3dJNSAtlAEVRmEvrx+vYC5654RNKZEgZbuX0s0ee+aHhDcXvuUxYyEy9z3JAdYudFaylbP8xYMj863PLOThjvQlwEqe61f5y6weqxS8YQ95EWFkiQ8if0BjHG9afFRG4LASiGsrWtSJYCf+Trn6I+Vixf4gWOULZawBfhyxFwRHYDdVG2oWzE3R30MQ2FJG2Vlp2msOkKm1eKJgUUh7Og93j0E9NQrW4+OEbBznoMT9KEWuNdk9h6ib1j2z62bfSBETNej7IQcrPMOjDbJGVHkuY+8tAu1/aRl6Mdcn6ZaLTwdMPVQybFDmFTts0lPs15ZGeGJPI2ckWdcPZlmTH6M8I0SlPd7HmOXKPhB3hNnURiOySowbeJyLuJTE49IQFZo9rZsa6TKapZ9EI2KFSB+XqvlbEcNXIs3DUaX/kcnprfkyvAwseF9/vGMFhh6//VR3cZMyQqakEztGdrCxnYxyHPaqEl5+QUE1mjHKzvP2lFD+yU0mxD6P0NohWLz+xOBrMMf4cHbUY2P4gfu9Q2EEixrSwWPLPOYFr3MT6rJGqpYEHkzwg5d1nhg3rAxWPN4lH5f7MtIOgZh9pxF2UUW4nXhTiSWFol9u4i2p2XD6GcebfnlJmbsxgDe1ZHRUvaxjmRTUC38BSnTvE6uX/5qZkRKbe/UXWJSpegytMWbn1eFebh5vM7XcZjg4KsuzKgsmmk7t78syaVQ8x0KV1w1vItlA0eLeNFfKwXj71cdpBKpikP1X8M4bR3eOfKRiRPfWhPxTGxVOKjyoAsaIjIumt7hUoSNCIRQYLTHKYc2GhMZdLgsmftmYJzXstdw2k4b9ehk3angnc7a3R7i1Jthf/afmRY1VMKcFP+xqgWswXr/EHjU4NIH2Rq1h8lFhQaP4HB2ltVpXW3Hl1Z2Z8s7NtR2MgfCN+t1ss0bXNQWKfQd1tyxf9LTjILI3B67isG7ldfn6ZdLIEjflTpLcPWo4+nUPWavOBqcDY/1qW3D/3fGufpBiV3jQWJ4q2nfK4lv926xw9qZpooiUDiPzrzHpyaLhl1iosz9n4i80NMleCw4Lo4Zhqy8urx3jUuWvvfuxeXj6bLoH/W5ZisPpa7YQbDebUedmsz9TDtMHUFlhAKJKiSSXlIUTTkJ9wNPoISE1DvW0+7VRRXd4DG04JLQK6tjb5uUsvS98SovIcGEpWCHv8ea6wXpJKvA5s3sH9hw/rutcfJ5CUVEz4uvzV0cUK1J9MwQmiDt9fu9/QfXG2PpXu3w23bbAKugCU8ll+LLbhsBCnGsEHngKN7ZBFdimph93+GIBdtZ6Cr5ZhuVwR1J6yCAufBYiDRH5LQq5VKsD7rWYyrlQFsoIoSrgnZPCndRCl25DP/Y5fJ3TKrKjvOzhbYAtwweiWDBOXXKD1oqW//zTT+RAWRNYyTL4bbJIgwo2mZJO/CPyzOCEzl7nNigXLv8uBXCwFBTVCqolEiErWEkAICQs/JDpyN8qw/UahTlRZ2mFJ2kposloxQMiERaQIr8cRMXAiBt230cbmVyEO+yYX+ICNSKfhkVXBFYPWpLMlkkSYtbphwzuZQTL59Hcq7B6dYdSnO4pTmEXO5mF2fW5/L3+plgVaeD46GyjEkvXx9GnRGKe9Hosx5jTvCkPHdblRXHLj5TSZ4KNP9bh18ZUBZB7EtRQv/kU50HF+PTu99wCCXpAK0oDlK4rK4flHZoWjx3c3W/1mmtnutfB3RQFcXFztR5Uft8vU8F4xwD5H0CBKpr3SJIrN/LTIG/IFtWHR9JCQ/SAc4sXToS+nYnEvHdI1WlBhLjuaQQRhDMAw9nRO0QKUKhb7qqdiX+Id1CwEcBcQ8nkxkmJrVydZfK/NV+YWO2W/XkU56Om1BUWxTaFmI5cEiPn9sw5BRJF45ecGgLwqBLjLPkWEF4bLlNB2r4eHEYNB7JBVzzUvGSYXSzBFtYKhLRHxPm8bQJ4AVOvJAVUkfWAJEblc6DeC/9FSpTNM8orFiy9GiWjD3GCuslwRDt6TDZJ24PJxnT5XuQga24ENMMRJkXvlsrdiSuuA4WlXajh5/i7tGwosz3yYvFa40JuG4hChcA+BocIBRj8BVONvmungpxKjocwCvIWEwfLL33w/Ssr85PCkcyu65KOmLQRXP/dmJ09Jef5t7z6tbwnefHr3OXi16WLOy9vO/lGTaOzJb6YnA/O4UGKvSis//Gy2Umsw7T3Fuep7mcg0yZWn24dnKf6th9l9t6tX9nHdpD3AobJdmMYvGJjZ+I/KxGJq9vTMcxDYYTgwbTZZWebI8odzVDI10uBJGH91TTAxv3GIQRs+T1gSBItOzN4106Ti9v0Yd6bkv2DFwK+46Yh9oo4ezKDi/Yxd34z07ThSefRqEAaACNd31iaNZ251N3tAaQza8urtm0ahhub3/RYcoxRUCPWSo5dXsP8+ngQsDWVB3oGClUwgwwv24KioYivpb23iJROyQDMFI0ogY9T4CnCh9dk7GiYZkDWmRIUMVuqeLGTaoRdX1OU2hmsgcFRrt7KOTaj6Nlfc6n7iCS41yoKgCHmMprKF7CirkvIuoYt5utW/a9LSc2d+ExgDwXlcAFiCehqwj4sXHRsTjs38g9UcyeNzmvA0urPnuvrLOEuR9e+eQL7fIgc5S+9Xip5pZa0n8Omq/lKyKuVuOVqFXoHT+nYZn4Ttwm7HRVdeqAtj0CFWQrUUhPXC2cRgN92ov3+wtfyc6uqafToyesBDgMUcs/4NMN4kYFa+rQ1xbJH2MOdlfF6cI+xsTdh4zEDQB9U/8yTfS3gsc5LtBADg4G2iuzdpd0HH5qt1DlVRDwOm4m6zBqbeu1hCL8U3NZ2zcTCKUq+51oOIcANubt1O95rUolWm1t3lx23kngvMMNye2IpHiWcoxFK/UapEPacNhbQHOtjVGJ9fI8Nm8lml5xkCOVnZBBVeO3RCDJQA8z0ONQw85EDqPYAfmjY359qAqpWQaDSaFr1DaJzILJRSdEjVgZMyf9zAIaOyDqhlPNeX5a/TCsL0mYPUaeTiZEBOoU5zjhiSSm9WIFbxVHQ0s3VJpjqHZxRUUFaaLMtfIHlfrBTNJEXKwCK2LRg2rTG+DyF6BCtY3Ck+9gr+PgeWw4zD7ajPaY+xJpk1QLH7MnVfTqJALu+h/6zavU9w7qq9VR53q16f+rwdfX8d4r6bEFJLfpkKKfbglnbJO6GMBP1Kex0YfIwM91el1qokEx5ZzB/u6jn2aOLvJXh7uoTrjAZIMyWhogPFkWIkSOK3w8ddtxjUL7BFZabuMaT8UT62NBHglSPQvs45mRQ+q4eYw1Qt9LdTqA7Ff+fdrSsjmvpue7eI5MDTszHZX2jHvIjOEIBb6Q5VNuCGLDRib1TIHCXfFgnIR3LCetwI/Mkxd7MRS813opWOZuO7onwLDA0JJh9ResC9LYjL0DzXhu87Vz9/ldUcpuI1AGnHXPUOQ42A8QvmFGVLvjrAkmOo8I+mHe8a0yRQsWZjpuF3J2QMLaBwAG+IysZ0HbDBN2sFxwJAo0bjq/+U7rPAvkSC2TbIiBDezV2f0LEyULyRZ+byTIqapUO6YUHWXA5nbZpupxqe/2pqwWLnxwSZaPR1k8ryrq6VuOR3W14rtlKPjaIJFAohpSgFu7VSFBfw9+wuJYECn2AajStT9jo5ChGa7W7yH6z2QwEopyaGmHte5wUpYoJ/T1t6IdqmHKc3fPKEi69mEjnLV4fjoMMvWN+D8Q5oljMca3bbUrvu9OJCHUmCU2ue1saGz9FCTwS4zdNiYrQr4hr1BAzeLwD0Ad1Jn+cIHTOdLfoQajMsUnOY1jv/Ljb1R/ftmBU1huMMbW4Fgh4PGA4OD7hOcXVGE4EmKJLxo3j0ZXg5B6G4AnHccIK4K4VZU38frXdNtvOO8fdttOa1D8GnkHNqXgvTF+ta8U5GgtfxQOd6zqhWU4EGKZZYVFeEZoBQksFA6vtlTW5Jjs4wbUGO+yfQDX+ybRljrcAJiyxBMWeHFU0UiMtJ5zkp+9pkMgpznFfY4xDrsl64lba29vAKFqRzJAjdnFkf5S1OPR3Ob/ZMQDtEBEdFdBuEdKRwjTnDzuCsOtvbDeOwS2Kv0h3w8Q5zlU9zA6GIx5x0J9xRyruFFjFMCpjTBEkMyqizqsd66q6Zol8rbomOwq287CdHBDMEitR1KyytkayCE4Tj1aczipCov3DnMFUa2F8ic0RQw7BeT74uMjZftnd5TlKUP5N8OM3ltvz2R4py6X0akGZ4iwgse+uTJCJu7XpzHzAbAHuYPmzpDqn32l9LzHDXlLfcAv7so+8GTNSoOx1CIqhQig0B+rDxkHxe8CY/F3F0FIKAF3F/4uE5qu+1QTW8CSh5vrCNdrgijlFGEeXqtaYZ+pWdK08+oxCN/8yR31uUjL1Bhk0+abcouxKxKYto+M1MwbJzhJFtwQlfAuDWXeL/0TclOmipbIUB0eRTcFsa833wDa2IyNbgG53Fb42xNclNFjeNvS+w2JbnfKXu5Ua+oWx1/6TyilNv9pA8DVsqx2ibOECT8qUuuZupRenJglI5SC5JULVbOhICwO9Xa0WewsNowIvVtXvrSN6EBNpGYmfC0gAaVSM9LkqITd/LwC4StQcGAt0nfxha9U8vcWl0slQ4JtWIox4sKyAxhPSCDUIH1jWnh53mSEfq5JyBZ4iXgdfTuWjv10D6r+nB+8iU/3jVW8PKciZI9ubpnsU/w53fpoiNYTRP22xSTgO5DQOrekq3xBFmxFLKG6RVmzaj0WZdYj67S7774XtUVWE7pIitYXXXRJELuUDwWHAdAO3HYGKhoVQh1rAuQ9sSSfePo4bXVGyPngU9wSlqYBG/R7UdpJY9EjmBTJubmaOzNK/oRpEpesISDV0USmV+HU43z6rCNSiRRUm9ZKvkvYclsi8UJlqUS1Cc0UqVy0XXJdLczMYa+YtwoTnuotUUVNecOqnpYyhQvwC7vnQTEZ8b6OqsIFShnkwkr5+fPMl6jQPL4OuV2zpx5WBSD7p5tuzvNqF7O8pglvn2Iarv00exgz9JdukJfc03wb6Qb4pVcOdJYNb2gyazU+XKiItdJpPIAQzqcIdnO2qAhIy47n/iKhSjznPAGvhXa1sWocreCJVJsBImbpYegDrTEdI3YGprCBlHK7WwSs3G9I29dXEC9b14z9qXyRmNrG6kBpuUALR6KVNxrZS34U7GULEl74FaAJcnQd1IqGde4TM0oHd7QeGOhTqJamsiP1qpAuSIt8spokJp2+KiXyktSs7Wl/hcbgVJ5tqYmf0rekHz0gWwvxSCNrDCUrpAckOQSOHaiJQSEgT85ecV0dRPPZNIL633HOlWxvpN1TH03H6E8Yeka7BJECNsfItjCzQd3f/QyX+tbtfb9EstPQyL7KLv7txuvL/W/5sXpZ2Eb+E2cCS6wpUV5db111rDcMz3lX1uHFVjJZ/x/pt6VmMquwa4A7jNT8Lm7XlTF7zGe6e1HYDw6Ct/Fnix3UkCLWUmk1nNz0u9I1I2RGbdEMGCncZVhH+/CSnESCP1ntRDybguKe+09Mw2W9cgHTGPkN2i2G5VrcTewUlRjrNphjKGJg2Z/CUd+9isRh6NCCV6hq7Hjz5GAcIaVHjbUQj5TPckQl8c0zvBCezoSdq9w1kFFl7MxDjxAEfxNRDWuUq970vaqALEaPW9cjmoMaNrtVzTK5ETSWhjVV5Uakg5292tOvAA8OGt4hwingLoNFArruZKY4Dl+DD7sipoTRnddXSXlSnZiTkFTrbjnKo/hvBoCwOxLr7uOqGtIiE7WQbpW1fU/pYfwhopRUFpPoFujJAw1ZdLlRKEhcqXpnYyGaYk+uIz1FBedVEtFT5J6emB/C4th9XrYyK60mM2NjNkLUr4NxiH9CYlLnydyh6g3cJgJzzG8GS0xtDi+5D9965s3Vj0aSiKXYU1R9226AK6CIz9ltolumJw8Irviw+LmRHhFti5oCD9OHEhyHZZHJRBLye7LIoc+CYSgodYiSCthEc/PsNaikLo3YLI0dDVTmuYTedH158eIA+EHuEDx4Q4ukHwM1SrRZqhbYb6OvgfLMM0bY0PZKY+dVpXausE9vLAerYPLDN1WLTS6jw4bwD7BmKXi0PE7isuASdGzfDpsjP7AD+l/VKH3+NOHcnKlgyaU7Rdot/qZTUf5hqAKEL9h5XM1s+nJhqs5sUdWRK5Uo8pUKzwz3R3dxcssGjpguNCw2gyuU44yTZrS5MRO4fQFS1Pt1n+2DLP1bffyq3kk472al6EtFdgBsumn8a6mUuAtsPgypDqP2FXlBTAPoDdbtdH17B1FMc+hVByP6oMZIQvBvECy41q8ktfFErySMA3nusGJUsyWPa+732D9gVBP6qhcq9lSUHdhbBxuqq4S8vXB+buttKZmUP99gKUHLy1fpVT2oOX+vU8M1U+mEDTPpVU8pTg4dImJ4EyT5kttxtkInpFQC3yF4rgKCo9rQf1eZ1KFMGyOTQPmHCVE7TftObK1SVAcbyP7NlNqxqYpPuhlL6VyK7aJNdNDs24bAIAoHVmMX5YREwnTMrwhoExIOcKVPyTxPS6AiCP5HGJIiudBwM6oIiU4nDjyE5aPo3wiKTXh14/69sdAhFpqJoA3fr/IBh6nwpYoW03xYs8xT/2ZxanC9cG21SFO1QAYhUZ9E9zJ412JZ6fMAJjNF8PJUE6JuYx7kuSveCUjBxSANdXD43lBpPcC8WuwLFuks7UsihRuSEKaZfmmbQlVvDfedG/6N789kHR267374Xhta9JSiBD/7Ez8HQznGr99JPWAFwiKi71pQyVveIzXwZ7c3dWZXobH1cAgO1/0RyCX5OV7HYVH2oNE/OMC1Q7W74fLzHNpNLc1em8avnesZK6F6a9ZJboQq+AIbUaLT+V55zHTyK7r5gTyDytrE8FFdPQUQXr6b3Qr6X8OOM0FXAkyijnq31DC9En9gfvbfEB5c/7FqEkgG3boE5HdRjjbUR9l+HpsrDU2+DlywBgvVarF2wmZA79uMo7Xke+0z17GcWzUDE5tc40J4MSexbFWalgz7S4gGxQhWp+WhDp5lMfHnoTo5uoAZYSyHajGT+VJYIeUgJydvWSvO3VffAV9boqUpUeVwWrqwumMJdNjR3vKgA70U3Nuez5ePX7yUfrb/hf9v/x+f17+VNjXY03f7Gm4/LN7KOKUsDM7bzMvBKKsI9wG/ru+7ArBMO5bxz53yOBw2LMLDGqbWMSOZ7n0m3F/u74YwONXukMUCjxiyxwUZOjLT5AavYilBlmRC0ARHT7rqFG1KnLh175vaecArpl8iJK1PP2cTMP0Wr4GY3gK66THT0L64P9711ToB6NsP5UHngWe5xzdekStJHrzhigiIpGWcFX64THvpTuwuAUvDZIs8nvyfDCW8TZAeHpkiCiLyr9be/y9sSxhV/ONvLZ2FIS6pCPRUpGuO7WmcyHSo3ERqg7mWzWS/1d9t2HVGQjbmeOKJX+sHluWQw5ckm7QhNPTP8HhSO5logquRBfpCaNhc3vcX/6vrhdz48tcnUcOW/TA273ZY8t86KnzVno8TPp+YnVMKXSEi5w/pnZh6UPLmeGOSjCl9leO96GcTd0PzHboZ4HvXYmnY5Xc9SbpJUxs9fG95WVv5Bz/T9dx5gr0MHYkPo/UJyZbpH7+NuBSUsd/MuarRjukSb0AmewM/gob8gGWSJCdodN99EzwzuNviLUhJ7GafkF6gwbUOEdsdfahdQJJSVUGQHIKG4f9Qj/nzGtMnPtpk1XTvJChlXtPOWp0xWZawAAs112Mh+sE56kNtA6JxFxYsQkbviAtSlxidZemKyHdPWP08w+KiRnDmFRZFtFrm2ELQ1a9Lx3mb7VKwN5eihoU0xUAGGXB1hr7CyX7EKUHdkDzpwRtWGPKFgG1DDHp4Y6/Ia8aBUUvNvGnVCE2uwmspa8QZYOtgd+tkEHzdXL7qxqtnpZ4kVT0WshdGJ56jYlwpTu/nQDlTVvAxUtNc6ZMWc1c/64Uax4p7Pmok2g/gR3oXcuYUP0eF9o8fwdxhFZh8TRU0v8wQJ5/OTeCR6qVTSA4EJS90t1VHqezLC/oEUkGGWAM92rxtGckwdKJrYo85v2Cg0mtZ2N5qA8j9OHzxTTvgT8k8q8l/8byvPsmANOYsQcTDafqXitRRJdefqr5v3+H6P4TXm3SycoeBerrjyBbS9S2B41/CQMFgo+8PdkoctDzRb7WCV6/yubskFiLInAEM7YseeCTvPz11yF3j/MObMQmU7DSPQ1hFH6NLjVF9Qn9OGtGFVGAX1enx4Rvq1oAdLyy/tfdRpp3nFAF2TI6cTbgaaiB44tk5WZA2yymHVVJY5YrGbBxMw494YinkpSWD4ATMRSZmdu0fzeEzJbNYZLBWsVK0L4iOol6CJuPAnVbo22nBsZZauJ+yhp5iucKvmHTV6orzaCiuK+lwsRcipczTaB7bY9S7OAEMjfN++bycNrNqQpsxmB8IbBqvAPM9i3VvcUq/damX7V/3Ha4KiFOo7VsGEBJXts4nrXWvrMNNAxM9JCy+vihEyi0ICOvp/WJdFGmmOQk4ptMZhvCw0DfG0fsIYey732pzgtwWjCLcBD9T6gg4YScXgQORwy1JoZrxO23Nw2q1bAyGqegndgXGtTFgSJhtBLMryZoDZZ6CJTVTv2ZgvUrsQiS78ce45Ssyx3KmQTQHnJkcgCV6HMLR0mM3Ghw6t5GBMCgiircn+/biFZrPqteAAM5LInlb4vxB9xxyGzeipWxJ6bi+36w/JDIUSyNteV4uLS7XqfrH2u13cnWIebUW4ba3to3ZmpC5/O7HtmhguEuuNaE3Si8UrYKglwuAX6RK7BGFaJw/4Hm0Fw+qk9EwWToplikfL9AH9pts7DLEo8sK77IrqkbngbrFmHK8Prt8HCIitPYoyvW8fflJnqv6ul8PQG/Pyp2DWD4d9G5wn5GNBDb9q8T/5X3Hcrs8VdvhuNYbKL+dXBOa6+/92+q8FD9O+jXGHgNMe08BqUn0U4m3NwNoJH3R5KjuKdAm3Ewi0zq1u+16RjBs5wAwKDCBQvgz3uRezrTdlAxk+qBcM3FJn2yPtwMs2ZHnCcmPaI0d9SyXP5pKfkRp5Jg7oWWPPYAizjmZAjjLkHnHPb14NixQV234asAgU86adSD7mi8bu/eK59Kz1vRvK89UeaDoTE4poxILcAxUVd7RP555SMJiZNqCZuVNNkXG/AyrWSWFQiOrY6wCDJasv29SyE/tvC11tar6L7iCK9VHiFopudoFtqzIcb6VUicmAXLvx7J/m25h6sD22qVxsSinEy4CeZiJxpaxFKKe3Mf7svhHgcu1VWAayfr9fhbLZiXdZBPraEg0wq1ztT5/S4zodsv0J4C+MfB8m2Yuzl0Gj2ZP99fP4JZ+6az8Mz/FgMzm+qgb3maoNLkWq+tl3AwQPtRG4lr60V7PKNijFuYQz8JMe9rvZsyGgC6/3TLAW9dkCoGy49Jm7+yvf2DAsjttw7dPnPRWfd7AkfwIXrt0Ux4bD6tNAwQ5dioRweoS0ujX5JaYtC0yT/5puebChzXo3hHt65+lwHIaNSrj2Hd9sOfZUckG+4ubSgxg5ZYufEkmYoZ3X3rXrWDjYdKGK3Ksl/9gdnDtMzy9XlZIhTEfT6gpwUXT4bsrJlKvCPB8KLsoa8xhV/bS19+O2lfedDIuF0zVFXxXaYH9w+ZLBbWP/4qYvOwMsBvzA3FKEUaBjaq/dmAv8xDYZSn9oJo7qn7JH3juVdpu/dX7lW6Tu7ONjWgysOtVRyoi+0v+Ca4IMSzgy7R9+RzI71TnkNOQq3sOFYCuU2LeR9plXJi4m+vYCibl9x9rXxwkPJ8fgVQy8J1kh0JJsKDOQhBBu0Gn4jowNR3HKRJFFkn3SuMaGgkJnDUjtbtaM3Jr+LLhp2oHXdgtOqTeCjVy83TFcx41IwkE3MfaHHlElULiQ0/w7mB9ESUdpHHuhOu464lcdLsNnXz2ZqY7mHVyooGuHi/sausq8j6AGmm59a0bq6gi09/NaU3YZKjVZndKpKZ3lqbWHmQFQTOTqH261s1lzqNxZAM2xVDqzYJ7RSv6hT2YFY1xKn4ayRm2WtpIzV0zGMX26e+6mx0NWl4FUPcqQWyz4vVmezhrIBC+O6H8zn9mLHBO9HUav2nuWdhH0Cc0d0w7jCokeqsyLs4IiZJICNG9nnuL1DbCOZdIlux+9kT0j2po2/1A1GLF3TlsQJKYtNSmRAxTNR9VOA91nmSy43/nNNro1/zR1iop6n4DHj99lX8ToVB4x44Tcfo9Fydz3SJwJJi1pdCLM8bNS4xy8sJ5KQmF6VEbDejod3RzSXkOhDtwPd46mML4M/trDuXW1ZrZL76bbdd0fxj7iVudJDLn7PyvZPBRFsfM/m7cyd0XkOGdskOl4O6HFx1SFr5QbYRP7K8QyVbv/plfLrI0F3iH1dMx8ByIhp8i64GvlAW02S6N1Hse8n1Pdk2cZfwqsAKZP6Rl56FLL2ItIaxux80LNWduvBhxjvOYz91SsaHbmMKDxvbB4ncW7W1+vjYhii4oGul5YJa+zbZk29toqDA7/vUF8fkt3Ww+82Zbyo31eJstH8ae31hFErLzgd12vPE8cQP8Qb2ZCKZu3uhbsW/N648yoo/WM+oDhU6Twhb/rHEFQE18v3xqz11hDxlDqztom5IiemVATilPCgGk4dEVLnwzQvVVvihF3pOc8CQqjbtsSERwUr2cCYpNtp/jMZU8oexKyszEbtUyOtMJWzV7wZWufuqSvVUpNa+m2iOkjv2KstHsyXaU94uqje63UJTpPO2OWp9+HzMDa0V6nu7UWxbehR8jush6Kp67ztY3UKyspnBaq77LRhB4/R1zmHC3Vk9PEa4IcrF5gFwkJDm6RbCGydjk7RhdrcxzvrNXc6y6rBfn8wbnWhhxzw8+Uq/4RDLCZlXqs7W45oi775QuiRF2vzE0JfK7/xmkL8GoUpXDotEU1vXGg9jfNPcqm4O4niv+KC6k5ehMRgN212RW67+LmNl9lCTM/92Ka26NFvV1LUoND7SpBdAGLasvt9Yn/9JZaiC+PXs5y8zinnzV9mQF4XOFg5zNhFSarOW8ec6xNU5oP+iO/9RhM6GrIelDUGod74mGKWtj+zP10HXvr7nnicId7/TWWL9P8zjw2Wi14XDmWZDjUo7XNgj7gcrcCXhNBH7zftdtnA4TjriBeaQCqSt7Baja+3OK/0OGXXOkV1Aw9kbfB2bXspGsMEcu/jHYOSZapUR8JFCOpKCgkeqKJG8SPE966swarMWuJwVz46QRSg/gBc9sTuoVJ2rBkTDllHnfn2ocKuzkEJRODe6qOunrvoaDNhs2l7dXfA6HZ53KxdWt+ejtl8gbb8H9eK+NuQXe6ae5LTa0VJUXMkkgJDZMV2BNdTXYLntv4gGYJTiV4XgwzSn4+IUb9PATJ8adlOIO+TKSHIWYkpAQ45CcKy4fncD3ImHkwxuJMzWANz3xKZHVi8Hmf41yomCKO68MPryx5UewLinkIMXSNbHuFlo75WUZPabMbuL5awSX3OOC0f8xFWlETpQdPXvu1TRNj8frEr22iMpJqvUyQwCEJjv2y6yXEKOu/oJcTqaNGQeFQKkEZbBd1DqEFZxAWH093Gb0o5IiBOd2uMWefn345HTXGKoPD/e97FjhVI4zL1phNr42h/TqVzgzmLul+Vds85WqNoeAN0GjwKSQ56Hk4CxgseBCU/oBerCre+RBKKgNW0EbUQoBBHMQg6wtd1nOAc4c2o2RcmeTtxmpGt4JpfAizTBD3JRXBcK7ZT611sy5d7wxqwFgLLLJ08EozYiSBGAu05F4tee36VieYmf8UevKzxf+U2KbYc0zDCZ+vZtGwXHA4pvSW/9iU4fn+xf46C2sP6Q7N+hX6XEOnDO+rwHyFqc7l/oiv+e0f/rtMz2ScaI4DYOBg7Dsy7eqd6NVY9TdcogkH6XUAD4lJd0JIHZhiE8QKEbjsyyvz1mRJSA0tTuxY62tYTV16pcKMqoBCyno38c62i336xCs50FC5/OXvbOp7pUBIOtfYYLrM6a70Trdc1KR3qrWuadO+VSWqWF5pFf26XRF1/iZCBgJZPJKXkLixycxy+Pux/NnlGYJ9TY3MUkiCJ3nkMI77CraYDbsMGD0nhPYCQOI+oplHoTw1C7gnZ0LhzXHpzQfsj+C88XlQ4bFY2LMQbuw3WE3xwx77uM91xsiJnSfCc9v7G+nCkA9dAdGlP5iUfZY8w1xGtoLfaZ/mc7kGDttTgrkRWXO84PVfrKyP6F07UBzGtUxECR+3xZbSy/QzZShx6qI2WE2K5JM3Zmr/lQIuVewozhMLTLzXqODoMIHMs2vzThU9PgRrLG42Evhx0sYuFHEiaqlNDrcaw83nP1HVr0InBXqUYmg0qFiHeR6QiNEErtBn/KhPfoKVpzKNnPdpeo9NJL/7J16Frmv+q5GRVih/X3Ln/pr5O4FuqJsjS9r4j5eXg7MEdg6l318X9UcZ0x/6s+jVHGnvsHj6/hgVvFaCHsXdquv5rQotTTeovG75ZfbVl08idD+KWWw07a0SeomV51rADF810z+2665YgyMMXAI303bZZd0hLnHs6+GCJaY09+kj8RFcna4vKHG+pyFa8w1jvWaVdJ8nZ+aVT/dnhqIpR5OMmKN7KA2K+fnBcyWzlif57+3HLqUTPV6/JTosIa9xUwH6Avy+i3HdDQa2gRolJz2tQCcfNbMimCbzwuEVFHIp8vjXU+KRKtDoxhzsCchLEoslh5yVFPGRnu0FJoL0rFv1Sya0QfRiBZHh+aYTuP3ZsPzm5m+dKiRc40EUFsj5UovIK5jLSJIRhhxJTu8EsmUYbqU4jDvTne+xuC6KzfjEIL+tiheb61R5vWtir/jRuxOoF8VN/xx58q1kEdW+IclgiRRqpPdmFU5Rl8AMflC/wIR/n++vodmgZVdTHv1glkHQt+2pNOf69vutJqHdm3H2n0y0PkKIMeO0loQU9EGDM6+cnsN1zx0WcLR+AxfOt/vI6NPve1fPeuMA5pmyO4OqFn10bTAv0sanAXYU9dA4Oku+55b5Rn+OU8bfeV/ezI+OGgl0Au6MNsmxHDaQ2K3TLd0OEto69pm5gOouHdc4imVDDCX84324oG92i+sBosPv6pv/Bv11iDhjS5QjJKxTNiqXQ4rbVviu+UvYzcNyTkVZuuMAvpmJHQALi2/uZSBto12eMiPtnKec8Lvvswoh1kdwJbW+BtpY0oA3h+vncqF3aY96tWLgIt9Eeefgddso7Vft1zn7gysHUHREfzDzuNP0ShKKw1NGUhZ7uO0BPosQGL2VHnltxfdhMyU581FIRaSnbE7jhJars0UVPHHrhKY4K2ZDmLIBCdEfgTSXd4/ZHJTB8jYdZxlv5aZLy3khGp3MS7RQDLkcezyGY68QZiFx6nC15DtViZtPo+YNHJ+3ikUWRncygUoFhIO6igUlqB+FlDAMH18YINUbUVS7xKS2Syap81wVdD1VPe2qoL/a+gXmgDjN0qazwO9WZi/ntQtp4I8Cu9F1wT293BrKh5yLaG9J8h6mtF65uR+BUocb/DaQ18W8pFwGefpHdUQyyxLVHq2IoZuP5CuW09k0jwp5czlwtFsn8iRfp5PXtBIlzK1R8XJ50f2QK0kLUYDtn5pvzVoOuDQpf4K18uZjB5lY4Hiq78KJB4Z97zKChbDLP7ZYDUc1nLjPux/nfKfq5HHgpKnuluFtuPu/GILrH89Ru0rLN7jXoR5XNVBVh3nOtZ+izGhP3F5mLhgpcg+MGQn+TjVvvu2fNmmg0PVjP3rmmuiFvd2xZ2POfPERTmkL6XqYH8myUsGu/ECL9FB7ni7THjDhTaP2Rphb0MXm2FsD489BqOdrmYOUXmA94UBSZ/eJKIIJkMKVEjN+MHY4cddqUyM9ToeS49O1ZATBkw9KrzVMcHRvK7dRYNVnvNfpEcbUvIjnsp3IpFrsmqApNkDfaWHAqMuo8ZABiYcsC3Jr5wWIF/VQSNHkekZZAS9eWjj3YI7NvuYO7aJU53XmyaPYsjZzBD4Ks2gEUFAPVw7m/HLFufZd299Hze0PqfgVdyqaNdtGViKl4JinxLfjc1h+/DDw6ahuTTRUx+coPRWPTB7FPDn8/sgQ/uesgFuWTt+89zjJADLK1GYXolnX255snodHAtHFmv9YLN7QzyR6+CnSNnQT8UqfuyZI6fdFNFyeldVcD9WV+rEhQflUL5u5+VL+wSSLwqzaDwdO1QlAluQqItXdulV9EiO+zowy08bLVFjvGyiNvaIb6nvc0cw2QjdpapAypy7ATIAhNtqXCkrkiOsJjBK9nL/6lZprALi/mv7LxslSqhK1g8zE5OVJnjrucgvYxfBk68dODiP9Vl3l892wtJJJeObgWDdg04pd/Y5OIiGBmzA3+Y/2qxnyIKA15Xs4Y4VL21ytrMnMx2TmN0OUlnKUOSQKKt0cv3qG+DmC7ewDYOx6vFXTbP80a7FTIN7d0el54+Hw7vw09wA5ED2xD0R5cm2ipWOFfndh4NmZfteWKyu0ITgqjEvNJtUJhGDVfBlxyHPa8bQKvamxRtHhag704cQIy8Nlxck2Pt/hNzkbElWvVeLMC1u+iYkX3wEbtboF35Kqzq4p87wcDGWl3UiFl/0uWY7RyHJh86Llbi+46pcLUVD+url5kiGx3N5oASTuuyNdqP3Jrmvnp5ueO8JHs6is4qt2WQ96Q1ah30fZSvqW7SZhI29xKde7SlncUBc1y11F1toiiHRLRV6OJwFgvQBp89j/874qmEqbeZ5NgshT5DSBxEq9WPKaM0dvuzLn3Vj92Ww6DUdUYgumVRvlYRbU+ay83dKyCFn5fMwtr7XiQCwT1hkrYhYfBu3ZOhMTRzP9NikiI+bTYBWv9ISYL19Nd4krQT/p8pDM1xuOaw79QGbZvtkagWDksiJai8xLiUkeaWj2ebaANRHgqIMXSCIrEo9yLPFm32fmz1RczGNhmo0Cy/5um8J9zZ026jcWaAcvXnyMCE/mWegRrKH9PYo/z2hKOej8PsrYVsNTN1LBBIs8J5xzfzS7mR6laqFfWbnfZL+Rf+VhKE4P2yQ517dki6d1ZzgU4kEfQ1KgkIN6FVocixYZUtzyW++1aAbk7Pbuvf4KUO42eTfSehE3GcdqNJukkpnNmSf+GL7OpxRweG6fpz90ekuL1G2vVwTOzLZ7QKH23Ifi7eL2Ud9x3FT4Nt1GskmW8+nP87bkNP35o3QXT92fz6R/Xm/e67k2JHTrc3lri7/kbQ3ZWAKb5uCcYD6xU3dVnnmlezGXgGwxmjqwbHQEZaHTlS3i00bnZ0dkxSNvIx18HuJa/WVSRnvMQ4HVOZOLYK2w0RJT5+y49OiQ8kdxCxwHDs7n8o8xj3WRIjE654+gH/cBzo7wszqt9Q8b32CLRPZkU2bXqHOfVtyvWoZgy7X1vlT7YGUpQyY5TNd9vR71iMegmv3f7t45D737bWs3ivuJv7tFFyEPz4DNXzILsiPIooHcz6fyDOj7o+IgUqrRtPZ9+Gy5dV5p8rJ4VSprbs1o5tqat/Fj+btpTlFgVVO4uQY1zPMjIDKDuKNQ4Iyi9P6DDv7+1X4uip9jwQEYyAMqm8z1IXQ6rHTCph7wnSF5NUX/dGfJDXhVW9+tRabPaf/UkgK1wufurvNRORW5hfv3Ks7SRf+c4kTyrGdmmfTpz5HoNVlF3R+NlyVpUcuKatjnQ2V52hQ3Ly9wpKCWWcp+hXJ4tsQdAfpCXnPY3FZ2EIMYGxOkh3xDHb7J2iaGE8zOYzyy807vosk70SdwOYsiZ+TG+qwwUk9bck32NT/1FRCyYiWRP/6awiUEngmqFkKQ3uXSDGfsUjCr6ihro+5GNNiX89qD4qHyhzTI6qc7OTUEk58HMVr1lT21FEIkpL9vMCy1I2QLOeg+afsphA6m2pyP8W7gG/5465Bi1lK7Iyk0BK3/+Hv7kOdatmB6QZhCapFrSUH1ovRCaY4Hcyh+0cOidFJByr8qCRY619RE1JtwR+pCtb5R83MPyA/Xh+DjwacV3of4AoUgHv1ZtOgDuaAP9kURqW7fKqlLovi0dijw6GkqtB/gGU6OisIcDoSZIgfy52Ogz/b6qJa4uW0fGgwwS2Yj4YFU2mkXsBP3Z8PyjG6A4foKVgWwcfUxNyAOnXjnS/S59jbaPVYb42uhuuvqvABpBL1TOMhgvFuoIdjF/QYU1y7e+ISR9jAAmtQH4V2D1jqPe23xwfBPAQnHuMXDgx18aHBQuYzuG/z9u3iPgBYfhhcNhPcOhdaJvBU0wA+7WGn4d4sscaJBQ9joTIFJfHSi8EcHMzpX+Mt36R0oQ9I+HiuozujPNW5lfKuw3Kxzp879pqHGPQVr8F6hST0AZXiU/RbRB/zGtAqjedaCQ13s2YJG2gy3cvqJATVDKnEMexDPmFqITJNvVzz+xijKKtUk9dnly/WTGwaJBh0DYs2NE/lTkXYBqHTcQttiGD7B8V07iT3/YOJS57fNEruz0Wkokz17D8gy3sZX3dEraWxfBx0n4jOgnsW6cX59hfW1FtjWnd6jG7O35nEoxp6U2G275tzUzc9yZ6v7QSkRyyWlxTosdFxyz9EfGMbwRkVtsz0ew9sr1nbYZhpz29WacA+vww0218v1qWulxjW7lBSMB3L/wqZB2vZhjSwnwtQSiqHrZxZ2r0Mwot5KOUEuTzlila/f3dgOrsBin6/B3AeaGk8uJ/mQ9kgB5Ym9MEHUZEvpKbBj8t34UNNTlNTf/sP++mrCGF4mswwjnrfXpdaIn809nadzvSxEgoRqkBHP2tqTYWnzhKqFz8bzFo2E4/xUVLJofbBVuuJFdTFDkZESpwTMK0ese3VAraleFNeYYlPAIf0f66nJ5zu7X6E3Cqli/0sNQrxJxlPKjP9IYPxXYssHl0uk443bEDMHlLcVTqHlJ3xuJrEk67sQ8KqIngtRWmH5viC3nYW1XZCw4/Hjgii+UX1BduZ0QTmJBt9deMrzglK8u/tl17b4PC/yqNW56/5dE7yac4skZk36/E6kAPdPp4Xjw0ZMii0shFs5CHx/9iEgnXXS5SGWwqopXzos9nhi9vdynhJHKnPYJlrsrh7t7bW3PjBpuzlO3Kc9iUn4duxkDMbTRf6+7CZCx5NVp5Nd+5OFFI497RiM6KohJrh18Httkr1fqtCzwditeB/fMBpBzmlDXX/+SRY29IUezxkbyrN4kINcEX+f3ql0/hmFrn4LMhHaR2HV3SNiKL51ncvChypeFgXMne0XHbXBcQObmMvd5t+a/3io0PDvGQ2JUmwEEDy0mQKU+YCcSdJ516MKSgC+GCHzBRaefHsB0E5o1Ht4oSyzU/7UzCK2vefhVp8GLB5sEMMxSLvUSBSI2Q7SWyJFWdaZUNzcvTmEuwab7ZArUMepQhWU8asNOQkvNMWXuNxfx7+NPa4eiuTplzPkaPkSWchSJiNMn/msdQYoYhLQCX6vr0lRJM7isLmW+hrFv2D1QW5R1xmaoelT1BByno172kwkicO8fSSbnpfMcIEaFUMh5DRb2wRjJ7unjpprcUnQLGtuKO4l6BiqB45TQ8qihErAp0IVbL0/aJBd0h75ZgL8vVP9AgoogivCsi/Jq/xZq6x8wFszckm633k79divCIu2T4ce32tqosKJdN+OkAk14HL9y9UkZaWHcolX8D7OuCQ0YBH7CFsax844jIpXjTcpdmny1ClFyKn8Jg8qN0DF28nQ8uHcuKnVFP2m++MzN8xIjUZryyXbclLaXigUudtR/pJz3UlbYZZ9V+6MTdX+7zHnDEYT1O1yPku2VAHiNpNqDiB0r8fMGThfKjxLEgJQ7mJ6au563f5pr9sxGnfWa08L4jMIeK0rw4QRPcq7f2s0PiIQ9G8GWeSa3+h0YiMIjDC+GDfNKR9HZb/PYCXUfcC3Ojh3DuHzwrSuOCYBxXIIPp+vdzfipebZAE6BYJujEFgzprLKRZwcmN+myyHE7+tEVaw7HitvE+Q0/zb7x5gQkYz8CvGJxCwyYqiI49NKjXiiaWX+BTVvcqnTtr2UVRT6niJCApMlMdAfiB7S9vqP+NS76vgPNKtWq79WCKrW7+/ZwzIqFPvl/T05eR0JdLw/DDQviYvz6+KDpCWJ2MZO3cAODEbl4xmtwg/PnvX3+ejPTxHJpgzq2NcynFZ9cFQ1eA28OZz/geFfN8qPd0/3Y1Ad/LaGr5Hfakg5Odem0ota5bQgCOsuaRta7TyTvlatu6Oq1afJbX4qDrAnirPuvON/LXKjVSFzHSR+SEPetSLwseS78ByyQKhtvQH/L6ZmdJNa1cMHrpJZg58KMhuugp0NMsz/D6m6XmKT7AC79T22DdER8t/vvu115RbW6dZxrjU94KnL3DDviek3WHRvptkQvKF/9Hhpt4ytQt/HvRM8t61C445F5tcud6eDdnCsQCXTF4W35ao3V3bl19fL+RHNg5WR5+y+ABTZOypL9Dq5yqNHrd0UPTn+ZUYJWshMN0Lt61Uk2svmXVCd7+TDqQ6A+n+Z8lpQF/BDWDjhBnl9mCA2ROv4s3+sB/1UwIhZcnBhffB58CkEWuohFczKjv8kpgNvbet1V7lB8WKo43fXUS3Gow/sv2nCf6Qd0v+6jyarR4FO8vuHDjL8PpkQMS52XbAlnXMt2/9H/PRw9I614zlZjqWDLvZl1cxNtwp+jVXxXS4JCs+DiSDP9ojgf7cA1yUWQBcLT/2GcZ6v5a+5mkKXaeka5TrTO7BWbHof4Q71gr+mnUOVyv85W0gDT7qpvNg1xmA6odiwd008buLgehVXcWN/fpYKc/Ur1GkwWCw3D480F9/1KUuMw3PRu6Rauo/YAQbbwNpRRFx51hK/wPC9s+4KDrJ3LTt+m9vUICReBZjijIZl4nWHG96OJ9FuLNF4+d3XVZ4JObqwhfhrIE+mDU6H++SGxNpRj9cQJNyUiIJA9Km8HSnf5Zy30b+y1C703TQPs89LO6nuYy74A4vjXd8YiunWDtl3N9wnJ8Hnl5Sc2rqnHoMx5YLdN7ZGC++8nCRve565G8UTyXMwb9tLFzEozT2roJtqnTkWX7w1mO1cmOJx+xMvn5QqUOMv6LdtppcR7pzVJnK2wU3KNlnJ4r1npTfSWhX7C1Cv6UySFylyKgVRp6IxnKAMMeBNjjNr6l9wXlMxmLc8OftM1iHR9pbJ4W75594yqP97+55gjXtDT92anHyi6UxOMmRX7GadP+SquBR06H5v9CU+dYfuhYdvZR9r5428d/yiSsknUzfqGisrs7joiq0WPyjDoHh9kelPqSdM6Ra50BMuXXXiZlstwPNe7Ee6Mt58Yb3h+QXG9RukGxn00/tgfPM/zxee2+wBGp2XDiXwSd+633SvrjUDHMmNdHlRfIJ8ez14o3nO0yFbfnJ0PKeBrOGWPtnwX/zu1AT/6YsV2cWz2cyoxDN6FeTnez0JWPwK4s+1vtvVEq8C2n9JqqlPuvjl55Ar8X59vocL3I6r9h0MP9vUIaLyjDs2d4X08SNb1M6lNe+nLzZjXR+44U9HxF24dx0XES0wpn3Y0yKwoTXW2WiPzRS84EOqNkR4vo8JnqX27tShpv0pxx8ye1fRSd7hCKFePH3xVR7S6V/s2uRysnVql0pVTxkRcuMN7L/hWh5Q9Yav7VWQAjMmkNba+q2h6J3tneVCzqHT+IIKkfliK9bgcE+c4Nfscp/dtWLT/Lmf8aQj/pot8CEbeLXbvBArC/SVYADwSWAlMVetfn9vloLgppNg+eTlOf/jjzdIPc9xqnUXEQKi0zdSMYvnAK9Hd75cRRGe7gi6NaDLOf18ALiYQW60v7eEmSj596I8fP4sqFeV/giwXxAtSK+w4k663e2RABi4RMV5YgC1jqBZDEVEV1Lxe/ooT+uNmk9OKjnFy4J+D6jaF9j+bfP75dS4Of3FlyPHW4MRtD0VLYx7H2rlonMpZRnuIOpLv+8rPhiIMekZUak+wklr2QL1LCyzB6fAxG0JgMjA1WmCl78aKfN69Xgqi5QpjbtbRDK3wfOGswcprF3s1zXc5z+fjpWCIj/YvnL2uff9CXzZ/+uC9ANf/Zv+tuCIcEYgfm4Itqt+92/lo++CojA6ffqH6fWPyr5Htf/EbgX/euoIHjp+O6CxZqX3hG1s/OuBWNBnoUlL8BZYTzyC3USuXnPqnlcO3nHPo3V15amunjCAGRuwXGYarWH1mz273FW6r8pH1INbIyRar6YgXMWYzdVd3uIL+XtsalAYf0ZAh7XcZgf9cOnYs4gQG5qgZ3fzf3hprMG8XVFW1c7gjRIOC2c44Fd60JonLOmPwVzp84NYkOrVfAWGima7Nmzr0iJq0uE28q8Yo8aCh9wNo56Y+JJo5Ki/tRyeM94wJpkWu2asWJ6v8Ah7TIXuqTDnTmcLr73OVJDc1R3PJa8ukZcb0Tjrr653cn+6xDV+vuABXU7XveCo2TCyYjOPT327mofr4WnloSX74uFqFppZ4A9yHy6Pyd6XH433iPqKynj1HX9WxwGhJn7z2QeLLdXL3hdtfp5E5rqrq18608yZGbzPvD3PPQVWN+s5ajOfyUFzF7tRi6iMT7s28VrxbOWz0lV61fq59tm+taxftB9OjmdIKaTCiurl4lD793CN4I+gktzgQPDxok0Nkilto3cxTfmdnsOJF88JwLCNHg+6Q3sQ8tnhMWV590LyH6VVqpfFlHU5QP4h7hpcUvqiAwSKz/YnPiEvHl7RwDLkoRZGnU21eeY2kGKhAs49BQ/9mG3IinkKMvO1VDy3I/pmqDWmOs+pfLodm98bZuKXxD0dtXuvu3Eb7Qr4ikEehTT+jnS7JzfxX5u6kWVm45fETI7+W9vE+2TbbHI6Z+NNOmJh1QB6whv7ATu/5dt48DWoSzVv5IEI9QTTNiR/YVXfHA8P5P7b8sCgiixgO//eRROOAvzaqJ6xLYY6O1YvTNc87U43za2CR96veEbemDDfrYazMG432P/AbDB/VVlW2N4UGOY2GjN8U0/QBWE23j06eFLx26j9jnWTdXJZnpf7+Wz/9fTG2thBZB9/8dfhJhOHbSoGElWB5WXzJxl1NeH5udEK2gKK39MzE6wbHaUxS7qqx810qaEG7f944thuESuiaLtEz1Oi8zWtgbex7TW8e0Njq8q7KnQgbS1dmtvGa9iya2DcCRsjIpbvTUCLLf2N2T57aK7N/qg+dy0+Ckquok1nbTtwIiY7L4dE15/a/DkAky4CLV0siN9jpWvND9WbWy4KrxPGWZyDXKfilBjwZAjPIdOOVGuqktgkT0rgouWRinaC71+J579qkKE6YeU3hrxkbu8a0Z/a9tXrCAw3D0UBEknixz2pVQi8D9kq+id6exuc40B8JVZrI3h7GvWfFYJvVUX3VLVHpHFn3IOXfai0zSx2yKFjneD9qtG9svAmcsrbJvxKMiw3zF+DFzW76XJrtzjlvuvZCHdRTfB4k0aWeT5oas4A7Ot0aUAAKGgLbtbSVLGI8puhDbECv45fFYg0cVQiKqBbLXu5Y7KlCcqzjECtvaMFe7nJ+zUxrpKFp7NITEvVlHxbfVfqWn/b9XA8Vsr03raQRC2eQgyGF0E74BwspdqKNZybyLNIul9QLQ5mLliKSSsyYl1n51UrbDeHjrix27qka0hVNjaq/NaJQgle0L0KDZmtI23fcSZX8qo6VGXjFZCgnRrCYENZVvA0Xy9hOFuzp2z2NIEdZu9H63K54pzZ0PXDwN9u5CyxMrB+AKh2296iQEm5CMZmHlOM7gDS4AfpDsW2zYyiMlEH7PO1/NCQQdyLYhtyGrmsaFA9qq9i70aSzAKMvkwSL4rgLBmnznuPhMffy+ut0LSS69RACkjOeAKccS8DwuA5ePf5iAjdqF/gYmM60iNCeFvT3xbnVb2BZ0ezNRmNA7/smaw7gHrwee3ZmvvmFXwEvXdq7S1O87D+HLW88VAYvU4OtRdwC4zhqWI0oRG/fWqrYe2e0b1C3DBohTVGg8wI2Qx4GQkv8MEanlcOh4tqSLhKtFfzEHglM2oEm9L+JDOFAgTK6HCnWC2Mf2SdoTGXO1WqQaByeWmmousqkXCLRfsZGctYPVkKJAuUCKSGWHc3sh1/WELhE2oucrMdjst3t5ozbsTw7JQbjH37ZgO7aehURBT0VXKQkia46aTih56PuJYRBEEd72preHgoM0xUyn3z8/LggSYGJMwEyhCTlWO/U8LiwKJKvH+77cZRe5/ie3nIw2+iIOQcG9kDOtDLNc4cs1JGonLVr5vMppxU9o0Tv4etTRO3UsvLObfJKNbokL1K9SO5wfdBOTTZjeji9K0Rau96kONX/j7UQ7ROKcX6/RaF2ib1pWeIXjP8EV5UPJ+/Vgdq2C54m2L2yLoEi2K6424So3oBpopUt/LgjQYK/y/hjTHC+QRQBfEQs36eN9SR5wa66+E0qLIh60r1Ml48HWY6oxaeBftsnqnvB/55Euud/6kEnQ80nScA9Ao5Q2jVh6e/VfePFmSsvoAFWZkifDFOzliYqdx0wLgBeE3ON7V/fCHAu8796rqxla78Jms+QD69/K9nPt9/UQup3F9C7VbIn8nku+bf0l3wm0iJrM7667c21UrxHRU8K6uzrR18vY9AjhSlf+QWEoNE+CRew9pI5qvmE00x2CCLJitGq3zoCUi4Go+/qB0xSl9O2a9Y3AbNZ5TqRSqVhaL2+vRbK9Nv/G29Z8s7NZmNrve95IbnoUMPqtaCMD4LGyosob7vrGeXg/JYyuhkMoSYEPW55fwGtuGZlI6Dnz3qHKC6NN900hiNYG9z3sqhAePftwpG5iwCG6mrRzQUUtCnKm39WkmKrs9LerTbqzKsYqdtQWVIZopFQ7gXgmiBv7cFOTnDKIGw53A8ERGF/bsyjsJYY57ZNoq+7Kd9FebndGd/8rRGS75lRKbXCCOlufQHtfCiHKSbewrZs5b0TP5h0LHTCxQo3rJVA3ZdqqKNYZXtUpm5C2njLjJFrOTnN8QJQMVJASUEgfoYImaoa1coZNnXsYTwvx7rAq2sZUR1l/qaVtUCUbCQC2gNqzaVtI8gpRfZ6TNzKm5Kn+nRvZSa8pRUr6QWTUTzV/LR14ZvjYf9nf+jmeskrxmPDQ2SVzpq/+IdvuDiXfptJYzN67+FMSpOMn6D5T6AoU4fHtv577wbrLo+r026XR5rbR/Z9IgU6v3ZLAIVkVFuKKSLNiwlCyvdIUgknk6Sp4vkH1hUcMdRyRMXxWG01bBqJHDbMl+CF876N2xbGpRNwZY4V3X+hJLMDyPNu7JiHiDxsDds0A/AAlfht9Lbf5IL2JmqDJOXoVge9tjidilDHNbguPaML02Fk7Ms8zq7p527f2XrTvqkSs/Tx+Hw6APW94BwNPqVedhQ9Ag7gaC8QRN/pRXKcIlhyHaP9YWCgRzwxtAYtsLmnd6k32G/3sR0G7tCdPs06H/1irJJd/57fF7/g1nrY5jbqXfWEgpUPv3t3ZX1xR0CLh0O2181pZNkeTyR3pr+9bb8IX42bbjPqH/0nny99l/NB/gJPhb1n0/1794zzkRYg/uheddbq7A/SUWv5gvpeQJf0fUFZQCp8ptKdPfjezmiBSf56MheA0ltJV1lYllot655iNlenf2ZviCcGgiRD6iusC+AZ3SF6Vj339YLL9ACvmEpe3vDEwKHr44WYXz3KhWucnGm27Xy7+ts5OGw+Qa2rcmSaSh711kyLdejNIs0NO/rL36n/yW/bQCdg8bVN/jBi3YnouPs2WkMfQob91/P4XdOrTOfywHjsf/OSlQeyQd+d/nT62kCH9PMx66SXmXDbv/tB+A0/hZyQAV0kTJj1B7NwzFIwRVj9i34twCdZ2SyRnXiCFfhJ+rqBS9yp3poDRx+bdAHiImnuoWec/EuCIjxU+idR41+rDN8GbMYK48V57OHZo3HGGIuV49RmIITRDj4wl6pgl3kiTFx3dGAgGbd+vR6WEJM+3sExP4zPbZfkwC/N2cQXUt8+Aa0Cngd4jxUun9ed0z1BNN1j76dYMWTP+FlcNx1EAKAuCvKn7MMoUGXxdkrAlJcUrj5HGSeyz0QrVb/FH62ifE+CUw7uDb6v2TA/gsfH/VAntujKYD3UQR+Aa/MjoJXrv/bSHw0y7zHv9fgS5B5swcjv8j7evEWfeUngPL9ki1XGIYlg4rgjzxC1gwrvhQY0HwdaNmcUs6dbDoRMuxhFrE8Wvpe8nst1LC2Hfy7MuwpjOPzkEwShvbXpKENZWhLHLplHPo7y9A/mIf+yTT0r+b9k8beL/Y93+pYIs+ag2OFDHmG6dxrU3WKPdi+UsgnFgeNxPkWn/t7LLRd8mD8HUInYTDuxyAUma/l6IfqTSjeYk7ZQJAXd5hb1AFM3No+0YGHgqSR+Z6NR9EXqRDrEdzEO3OIcx3So39iBaNiNmRlNgUnWvcm7qq35IKe8YzHZt9XTJm+Ag9vPUU9b9cKWWa9n9Jxeqay7alIA63rN1TYY8fjUqofvW7Us9GIjdIc8k44MOhbWsY2Eso3jeqxvLlRS0+7Xm/1+HbRe44cJLER+zRH7L5iYboyaKxpuFOC0tfxcJQcFI/swJbUr9JkiKfNEWPuum1Zu70Mr3d3Gjy6WuIorNNHxNyOfQuKKYypq8Yi0LaP4V7GPwVs9idddmc7I4AtEtEP5w8NrEFptAYuKth2x+wnLD61eh5lIwHvZsN6FBfij+vZ1DNqOSGNI12Rv95oDqHsRmmkCtIjOj8lY7C1E0ESZeNt41Ffr0xyk8kp+Z1AAslef6ea1hjhYgU8ardSFgmUwBR5G7MSnaGP8WwPdMEUXnWcSFbhsRCgfmEe3EqIeVNEOvhCpXWcUQuOqXD2KEH05+X3+j4TLCFS8lHooIYV2lZRCTyXseIknFc4yIGNsSOOtEnGWGGxwcbZ9Jh9whQQGKlAyjtJFL/h0mqyq+uLoHbd05ojkZ6cqu7fjxyWHzudBzt0q3jiSJyWEleP0Maqpq/mYLUvKg8B0FILs3jV2RFxcDO4dhd1dKZ1vAl6ZnW5jTqa0J6hxAQz2BCw2O0XKRVlrpdwscV5F71XfLFzfq+ZGc5Etm1GndO4TjUcXeI4GsnLP0oN3grxMSaqmed3iiqXwa0C6FwjGeIhjCSbYu7g9p8kNYBQLzKg6Z1O/JHF2O5n5AHwVvEid2cFglBrjA6OHYDJ+o87jTEKW9zMBbNZXLLTE06wHLMtAPEprxCUq69H+TF6Wa/gxwQ37U9CXjUEg5zt1sW7thzeLxweDAoPeRgtn5yiabg2h7M3XYc67S8oUu3KudlU0vCrGrSyW6umK23WamoVsSD+hyUYeEa/56vh9ZVWUOpIE8WjUFjpKF00AoVdLXldqeskagXuS724REKrMGCVn8W7xtkWO1yDrOrnNMNVZqn9qIVuUvMQyIWnNLlyM6x1A0fDR2sYBRgscKdLlSjQ6Mcy9PpdvDV8Nh7T3Vfn4TNpOW/nxHDix4HGbhJ7T3sd5WIkw341/U7jOjUDEJkEQWKEVPpLr0d5OW46H0Yk/gBhcxUrxBd2IDnK+1Z/PYAJe1+jfxXS8Vndy+6Tlo0NpskLabe4q5Vi+U9EXsWrNkm97Iwxlc8JrMT1t5AjAm0I111BA+adFvBTUsClWy4Klf7vMO2fiXcrHonOeR5i0Rzbh/odDK91m0INRA30xERYbyU94E47Q3K+jIGY0coy1etV7u+8y9pb1/18PrbrusvRUGHqfvSOC9s+pOKkoupUla1sER/zlgPkR5Ly/JgbOYA2/uJXo3wcO+DZlXGJYAJ7tFQ+h1g+SmHpwD/nfc5WWf80F7/9vV/P85MYwh5gxRY4BD+Y292wzKlt96PwfT/PRzuQNtabtz50rLDDyPw7bdeqjaul1vmCO6O79WyEi1TwLGn+fcHgIOAnjA4bdIs3y6GtyTiqz5KDhfEz2kHzOkCRwWuXoRCMpTMsNd9bfWAJ07xBRg9P0uoJnFEBeV831IJ3D8bZDAcLJLq3/8RRoS7rzNsH6dO1716MvWdHeXaNAArq4XK2Z84ae3qRAcqZoB/0uNO4v/Mgfiyxgviowcw2i+vP1MuEeR4z1RvGWH9h3SodR0Y9pjCG6MH7517kVLsuvQwqfT1tOnT4KNRF3N8xHKxpxteEKNWObF+5S8HCqHfmLnveLx8wJm4UGs2zDkpQdTBQVF64Ez+Xj+3pCWg8Huv2E9GRnnslGx94xRSOeEXd76kPLL0iu9ehsG6yiv4hkTcpli7kdZHL0Mjvi0GZkYN+tRcvYEV5uz01zsFb/WVFuY5n4scUlp9iZK51LbG1PJnqeDXyMMDjBSf41zHxNFCoUOy1KumpefwsobM+I0dijgwYFD+tJg2XiIlp5Qax8qg+vktRqHGtz5mcu+U4MuCus2t8CpMaDhpro56a5sOrNmgXjXUKlN31wOKG61Pvz+CFbG8EtnViQTpowRZEd1YcSA7F1dXGGXCN4loUB9wqJ7T7rDlKDfdHqb77sXE7cgX9WkC6+JTrQl1n5dUaeUpVB0+FJM+riFN9/+GTB0Du57I+KkDE3IdbzVHZaXdwnaTiwBTprTGhGxbRQ3LmN0qVAfa1Mjv7eyQNWt4SK6IpuvyFxMoxW6koq3QxcKXnnvBTXV+fVqRe2D2QUwemctOtUrfIWkgL+hM8XKlS8nXJKPkO4d7qFbmDh6qWrZAVGCuv3GDFpiYD/f+2Q2mDcYHU0wdOFkZdlmK1oio86IM/Q6WRs/HIw04wlZbSWwKoscAhduCtt9mIWUd2CGi75mKOwy+v2tiNvhITHKQKoSZq4vlTIkKjetTeZ7xFtFBVeXbFJfk0H6A2YYXX/cLzM+eZaszMB9i0ZSevOGTo0t/5+ECnPyhUaaFXSpuYWGierArCW93ePDFJRa8KLrEmVjAHKdjsee5pIm625yvhrZYK8SA1htK83QX7upquqYenVO7dv+AQ8HFn9McwvThmSsjK2X7sTLsCdbTS+fHqeObgKXCv3N0L7Q5bKke1jOdZ9ZB6NDJMzJZEQ6zr0Z1RpP7x9ZVJgq+fwKsE/MCm5RIZGdduPo0yWk7xCp+mXw8KTknT52e10iifx6wsHpc5k+nZdCWmVSmSS6UOAoVaeihcJjl/reJ1LV5lYuFsbHXCth0gx+ezMIf4wD2uC5O1Ea2VwBZQXKtJyP51iyUXaCnHwG7cNEnC0patf7bhUvPg5AP5cUUXhgq1lHQrr8s6CDCZXYQeqL5Oqd8AueSBKet+v/Kq5MimvqnivXqurmUN8tiP9euPl+vHXii7UMhEhogaULLe58Qc+7Ffcsaus0lM3+kfAAI2oY6BCG7gp3mBAcjwA9iEQgYiuOFzuMMHsG9juwhfYcm2L5OtJZvy8xWjrDteN2hXd7pCk4XH32mHd8PIY+u6Ubj3PkPM1JO8dR9nUAm//87PXY0NuYK+1KWWB0Ikm38h8WJyEVXWoIG/R4PZate14Qc/+LFiN1txr9lc2/kZ9yoK6JC8ZYTp8fasppx+LZ1qlh54feK0wT4lRermRjDks8hTEsrZ+Q12GepBesCV76mNHiieRuLHkjJoXXEY2COrEJXeUqm+XSlWC7Q/8Cxrqqs06M3Y7jsn4rW58+KYtoFr+sY/KQY+UDUitoirEGpFLg/ru+Rey1F39eu1GPIySXQh5m8FEiVzVU2YF58SByD497bAP7EhD+dDrKJ/Dg56VBO7zZXjX77Ha7wbe4T7C0Paf440vUsc5ZTJXUEI5HmGpzbOYBppc2bg+wA5flSpNUu8DptCrCw1+V5hOsSITSLmCmUoD6w7FK4kR2awNXiVtkdVZPK9TR1fLP0CNx4IAjgxmc2vTo31pmNr13ai2Z4hriplGnAe+J854Hw3LaR+PME57M55BPrDaA/4yRdOgNSoChsOzwntivgNCHjR4kdvc34bIQknF3PVw0TZB/V6tenRl4sRieQa8JM+ZqzjeewBgxbzqejhw46HvNXhQB/+ntuodEgkLWgxxWY+PryxeM1AG5t9XGlFmSg7D4/jRPbRjaKZej4UjYrP8r/aObx8WjY6ioXMuOUd7nuObjtBhecZzqEGRMfm4+O1217W9w2NPJRj1GAuoo1sxy7HsfYft4IRiX7Rw25Jd1bIf5uhe1j648Tv1EBuu3bq/BNaa3Mz4Nb4egmx3ulaniY+9NqOmi1QzOfnbV5Xa0nU/mwLo63qWEsRcxjEeXe0r7HWcWMWkXCmbbTLFG6OPtN6bdkuzZb+t7rtWUHsFrwvy6WgU5VLrMHuXRscMxOS+tdLgC2HgjQlyavQjIHSqeV7/9l8uzD082DVh8OujwuLnixM6hvao5mY+v5cHw3nQn7PhRnIG6AK3zPobeQ0ugVwgAe5cJvGDhf92dH6htoqqls/oa0O21VmTgFInfT+UmtGQTFcic88+BVOtUIgeCwv/LFrNL4dkHf4I3kPjbeqsKyqhxfeVXHxDz/UhaX+bLyGviv8QZ6gQof99ehdfHJzrXUfWVwvhSuMCyFveA/UvZqddTD4pD4fOTaOk6J+5Y7zmVWneWoPhwaUa1+JOmXsVhonu9Hd9/o0sy/v31hbWL4zo5ifz9X6giaK0gyij7rw0Cn7bNimkACTR4P2so23z1lSkAhum1OzwePzGPWGMIjiCmQXK5ISK/X5ZIuo4N9rO9nRiAlkBsA0JEJyBIlp5EQc3CFEfdvGdqx1iKZ9A+k29wNOAFoOfNz1k3mS//Awv67MP1UQrRTn4wp0nqYeLUZGokQdQtZAnvQXhRxXOPGRZrfi+U0fdF4hCj4FnUrNcMTVp0sSFp8sLalOQIS++SGggr3SnfjyRsRci6pkdqS6kGNiarm+qt6gYPW20UqtMCq+6wHCRgFdQKODUc1SWiro3vEp+H73ZOnp9uZ2zq7ltt7auZsB+FrNMdaqSi4OGo8uCydVEhnj5ecrg71WUKJUU+9vHa59MSmR6PV92HRjTFKsT/bquO8KSe6jvZwrLMtBp8xZvEKYnbW3LtkkFGu06K6XieKwE49R2koqRQ3uVC4KFiPCJHGm+8dZXse4gnFvbTVRNOF4tsMvtho1kpeAfaVL10557Zu+71w8GSqTe2rkr/j1ttYuIs+J4SyjOqBibLaDB25nrI0TdgEDKsIhDCAm9QeXx59Ven/39LOJqnyYWLraiNgVJPYIeXoUke2T6ikp/F5tiNrk00oI9AXZBceTA6BGCT9uWJoigV1VbJuUJ58hdrLcgHwlGXjrvU15xVjqAErzMnqJ+Tt+3N1wOzat4A6xtxfwFmpXr5maEChk9DdVUIAuslt/2v+cn+f59/P5+/LftcusDeuNA7P5egDvtWv/BG5WaFafL8vRlfoLfq//B+EsvqKm7Dx1KW14YriM2tPYRtmPtJQz6gldfkeqDaPdBNztajenga3KRC+5Jh+4YBsWKvMomxbDJYVFEw/Hn7FEdx7KIe0+ekrB/oSEuL7Ml6dZu5eJonDyp5LmWC6ZotbP0TLRBQWk1t6z1AZtNy7b454J1ttGlK5II4hWMk7/zhBXdV264S5W5Ir2hQrvF/SMWNwiclo09BeLx7DKisDCMHKWw2iOg1qoMpKNIOaUTUjeTRQ0w0YkGbpFMdrQ2H5OvqyvcDjBDf+8xye/n4TCxHRiOuunnZvmPcjeOhMUm9PcIB5jo37zvvqSEk51SsmCC9L3DxVhkC1apDx11ZhOw3SgnzMnZEVoknI0Tq2wTmvExj0h0zJgwj92S+9NWTKChb88v+TlxXVwiHswTmeZQl9CZxVcXOcind0W0tjsPl8znLWcuaUbZ9zYKsSWlkndnmMhMg/5ea7kOLrgReetygG4q7wgkCVjc56LQipseWFYROXKxGczdNXXf9qWgDHFKa9gcFClBKyDwZBV883lJqLTAj0V7q3BBpvIiFhf7xwZ6LCDeJ9dQGFJtvM87RouUD1NSVA5NFVJkDlBCcexYQFUBMoLTYOtYOTXVS9Mq/fl9ongsPfsUyiAFdwUWnkPSme3i3AJrBHv1G2yuZ7c9jRS9qWkfE1ftsf7G06vz+z+KttViAleKMzsFmDqgcr0dNufFoi9g2GvP2iBQq86M087xjWQXCst5hNiXD6G63o8QcDif5Ak9JKyvHovznCTVpfEczqF7JBeKIdP/G6v2U7Jf8xWxmGbOeBr4++Y/B0P8tjEyCIrT2fSaopRxGvPLP7f5c/M9b/fNKmatBDgtXFXq80kVm/r7c08qDpoVtVYeWuY6m29HeagLMui5rY7va7hL8MKW51Lf22k1nKhb4PCqY9ndvWxuZPJdxrbzOLBmisKJcqccEUeD6MMuuC5PQY8hrVudxX4p3PS6q4Dfp8Whj2uGtkP8MbzGZMxGOg2bm7bTtTTrYwrjLOpRtYgqbdbGVea40j/75P1UxCax3iLJaWKhycwaoKr12bFUUXN9ls0kSiFStGoY6hdd/Yt6i0ZeTf1nJQNANVfT/hWS5e1O6D3kcT1GXXTuG6uRyqD60yPqTDOVOGTAeMziW7//MsFd6Sx+y7Y8QzwkZdLY/eG7pD4z0dI7YavCYedQ/h3vuj3fc1QTF1Qp0f8TNtog177BFXHb9SlGXxKN1GHDoR7eAGQ/Z7ES3215eFpUDN5h2/PjOBSS1ZjWc222Rrj9HtTQ1wisU/+8pJHKPycVG3HsIHPRviqnbNAh/Exyrrz4mXuLxcMUOyHoEIY9K6FbK4NWtL5pKeTreDdM75rmVbsapO/S0oOUcno4B61AyVaPVY2egDT/XLbhvukAw1nX4dz5EEHqsO8f3j2dKDlLOSxfD/S4fY1QgB/k/bNPz7eisfHSB7uQmMd9jOgGQZ3BoSd7uGgsfv4vC8/v/ODf7VhVH5Kwp0Gko+RDIpI6m7fUcl4x8qOUZkjmU4YRNMwiNx47fv0OOF8LZI9ms+b39HUbrv7SNvdx6s27mPQYfuSdDa/Lz97ldVj/6KDu/VMidH4+mGZYPeXzGg+W776Ol6HoMNqC+HDDK6NTR0OcyBjDYSNbR02E5navPI+R32nSHfVcHVfTWlFJu0XueTLISHc5stm6dDPaDodHsb0RuzpAUtLXUghHMiwzkhQdmCECsX37wJUYFKpx6FuuVy5KHGz0P2qYjJhZK5iqGMl9y2QKyCUxxQP9TWBw2oC0S/vTzPHg4XItSwVgLqG3NhrIlWztCtHT6ZGzzJkPqxdvyk0NI6Gqief0RLs/Hvhvb/0d21SVCFc1c48Cy6xaNc+05qZKkBtO12GKPaSLDWD06VcGChJdViljwuZb8rTDbS0ONGuVEa0Psy5UbtjJ6PYtnH3glTVjVlei2MNpXZ+HNJ5mBc7sYo3ajTHukLR/TBTpenxsk/HlQ68gC0icDd/8bd4ex7uW6ZE1wl1WLfERDt1Sm+ljrVaC6bN0zaZncEXOmj2vw72kHGDiv3r9FTG/pMA9AA0c2aIGTi9y6agYlP+wZAtADTxmRAhp/SwT5sxAyeJUbHauEqmjwjiiLMD6D79tjDbfr7lMXTPtiSDN0OjXnieKcDcX1yjsfuRhggRjtIPoHzYMJYYaRRLIaUuGCqQxpx3Kgpuu1SbwLy8QNAQCcKaMsdDiW22syxs49aki4/rJM0sd+OnX+cbx02ctypoAMir4JS8TbFSCCQ0Dwno6s92cypwD14o7p3ldBP0JGK/+TrfZ56HDyvy3jNWVx9megVRjBI/aPlgB80T/O6jX6I+lr+njH8d05hNTli5M4zea+bmrGGMUKSO4CS0tkNcldx+37WEI/jWxthf0o0Rd6ZI8of83Kw0a3CjPrl8D15O+4HA8dtNDU9yGPRGt9qSsOqaRv8qXxdZb7qGU3euE2EYXCLm07xB9ghuG+f6bDaQM8In3RV1J4XVRYnQNsM2cNM+8d7ES/EaGukAU5wH0xMKQ0t0CKzOoYDE20tVLtURUOZpARVw3zriJerTWgOoAtm3hnBTFEjgBgNokjanNhWmg6co+14y2gP0DXtzKXMm4wo0PMAYRJCMFwmCFLTXupZzW/2S1veKfS1LUUVJS2+jlcXv3XTjuva832LA8LqcZJemZuu1tkVqjWSQNLWfcj5JHvYAMLZJEH6QGrHWow75vMl5WeZ6pT6Qmt2W+16YqdMM+yNlRoQmvFmmPoOFobSUp0BYyjKxJWbj23VOP+6yRWtfWlDShiaI4Hv+VF2bwhJXTLWevW7agAB7Qn5G44yGDZmTrrTAv+8qs3DGmb4qxdaXKW/3P6yAty8fF15VAiYkqM51R7XrP3kY8o1rtsnEL3ZsLF4vyvHOLemvY+8r/XXSK+pcAZrrJinRR4Xade84cgbcOonvGGTssO2aeRruZDxvDVUaUtqVfZwv1cTYO5FIilpv2HuarMDvUnm9K+stqRE6ECohIZhY8kuvt0pvV8NXCreZzA1is66grGARh7ox55NvVXZ807hBW7uTjzK2NOskJpGTfhGa4I0RtfZd34hy/7R6+Cvzp7yN/smbkh8iQE9rIi/Ad5yXb5k+g9swYOhGp5xfIyG+9nAxiP6IvZ3CaAvnhIebgBTBw/UXyitUh7tbWRmMwJuiM9eXXV0XY8Y2soxbUcdoJxgSRiwqWEk9dDtQioHMRe7N2fAQO/eZKo6JwRsmtTtriPk7dS5v6OyghGBcg81EsPAe02k9mVrbZu8K20A+RSOMIUVyVPiCLJugekW7zncwQe3PdDVg3vMaAFCbZcKrAuNHYyCrP/MXdtnBLwZmdfEiQ27LHJFVQzQdcfveExwgK+3sJozd3P3g2IC+DdS04aoH0q4dR9ox9RC9cK14i7gYJARQAzOekrTtZNlIFGF0U33BFiXqEpBBCj7bEvkQXXJRF43PmvOJNyPzNKIT1TT0ylaJIA5UDYdg8uvwS/lgVG4zAk7L7k5T39LOk7lsEzsVj2Q/DDyNae/lJFCPb1f4/QmZBsuceJ35O5MnlPztgJO65Fcf4ubZMsL+88l7Lp9W1fGwwWqxOCMfaf7ADktGF5jks+8cfzZcvbvSh3dthLZk4P4x48RA186Ntutgzr5ahX9iAdjgXIQeH85A0Qyhb9G6/e+EUszqFLCMRSXJzEKhr0roqg4n2rGoCgp5r625HvkrMC5opyYRPM1FlfDDrhjG/6b0wVLBfDynzDnKL76TcTpfxYlXISZm4I4L1sAU5pa3tMLDbmuoTZClNfo2c3nvxYoyep6v6lT+BzH5BzaELtb5KaPt2t8zHuVPMG1vWFSFbButMF1GXsUxDt2dtrGMnCVTctapFRPAu6j2INXlQM78wJIZeWQkawVl46Q1gt4nRCtYsnpIarMzweaJFpmX18xsJfJcmWOWVNh8m2vk/6cAThtsVw+t6qr8A3nFZrnUg3Awtb8P1AOXLRSrEqA5jlLIPQDbwZMPamH8P/dngs6tnzLEoZYvpfSN04YvJwuLIvNL+C+5kP/eCFzcw7xwxev/zPQgNpv+rG8xXTcoqfhNFxxDGMNX3VW9+39ooyXNgY6FxM72/b2Yg40TDQxbPCAmh7L0B3B/GcQ7BN0VbjJqg8N03M/f9GaUYc5p9GGeINdlU23JtxVjGbz1QbaNhWEYrCSXCAyCW909LBk6yPrOdu4ZW5IaPU2WzlqwdTWbM81S4zWU3qkDPlf38HdE780gHfa4UNCGagg1kRx6118tBElR21RNzsxprJWZNJvwzYrEB0aRb72KLrQRcGjALbaol8lf9uIV9qP9PR3xb+VhoLtjKX3xabJOrwJZFTytA218cTGgNfWQuqUXk8b/kU3jzkZDpzjH9v7bPsyJ+tsGN0Z5n7BNw5aLNKqN6Sy4Xx+5MLmjOwkKYks4N8w2SA973EBEVOCrn1ggL7AxCwp2XXo8zQ2kRBmJthettNdUev1T6hvLe8uNMZdO4wJfGssgpIlCtJjAXfmgdKBKj1obGgAuXxv+HCuOZzvFk/3aWMa5bQofiXF5c+AMvQEmoqk216qs5i/EkYsnYceP/5L325SADZw4W+We+SDoJCq75OYPdDYwRv2P7qzGa6EaXYA698e083mqe8ovhoPni4iHIQXxQNHmxSV9ZLf2dLfbpHoH4J8d35O4SHv9Nlt1lsbg8zB9iWv1/yWgBV/GyNtTnilYjna63Dx/itoT1x/Vgm75oeKy5yRWbnEZq0iZOhw38LtYD4dthb0QC1ZVFaKSsyZ6viPhGXaNKzGWTyBxfOYV7LctPzOU1RWzmIcp3k+vtxk/N9vXsYcf0o0sC1l3ZOvHc0D5vVmIFyJ9HHhkc/vwZfOruylxd6wrbg0sh9/HdHuTc7IdgtzOGVxnNdY2YYDzwtBLuW7YCpGORfj0dEGWS5emN5oVbqW4N9833zK/WZq+WzP/rK26O0LMoI+gsFJCpJotWJLAn+0eCamZid1Q1fjiAliVFdT4zgL+OaP2SY0MfHXBy641y7B2Ehjsdmx+Q0wczBslrS2hrKJQbAnbw8ToDPh0WuRkYTuHanxKGmWXN6wjaRx3rR7fAz5Wc6Wsy8PQVxq35RSzqA65iFQhPS9/wzGOaBjw+HBqJGeXldy2slPzGX2jkeu7D82dFUTeytzAk3I9pWB9hlCCMwwWiuF15baoBuIubpAqD2dNoc2hByqrqmmqBr2QlxB6u91MVwvWab4IEJmCKtompHSqNchrQV/HhF7nG5QwHG04lkPMWFgcxkwcb7pWhDy2CLuiwe7PTQ6mvT6W53ZNlqSe7O+SKuwTffyPBNvY+rQcGkMBADzzEgIIFpVcQFZGGV30qQt9uFXZSQqmVuaIjba6yESq6DvJdSdgFuBeOaTwkd8MkZH7G9fNYvNZvYUrvjOtfWl8lzIe1jpupYq1amvRCCFRJgjLtuKVV1kCh1KlunjZU7F1SQmxXTbMoubGrD/UBcahSORbYuOLS2M0bwWlxIqHZQNNvLW4W6O3vaKwazMhHraVlkQfOf0EOgbKXMLa+P5/jlAJVwjWwts76fWP51llZe81bkr/hOI6nKEOn8bMHHLNA+L9yyru1GaDvlEjy9V9KRijRkm6273gLLtFY7uINBdRWSxs8h+ELPKtPX31aq970Z687iVeXLiRJ0PTQvzZP4VWF7qyrzCMW71QYBrTN9PPw//4kRKKmveSQ73HY8hs8GPZgMwH4MnPuJdE1j55BSM2NGYv4+ebZUSUVbolS4FsAtchzxs8xeWdfwtC2qYUYDFY0Wl1ndJfE6hUymqpOo97gS2Hq7PBGFd9MAmG4lt/gGiD1vxbZ+LaFoZM+OlNil6A/8mbbcbZ+r7FMW5itJItVlSe2oe+m7KFle0BHRKsmXV0+kEWFyiNGVXubRgym9Wp2Hro6w1czfqJcm5q204C9QgGZajC/ewsqTGdigRtAs2oA9nKXRRYASQfpbQUPSEuZ+NsoQfMcgLYCgKaaW1LjylaAzfGIXnUfiF/wkfVVTSkWZ0j4T9M2ZFH4QlykfNuyTnndVQ2h9gMNo3va56lUya3AiJkW6TIWbr7yEYDWMELq/uPtLLl9kx7zt8rt80/8zLoJ+moRKCUzLUN+G97xWpaAmVUtrBkYj0CLQZ2TFeXC3P1WBPI8l8S0WcrWYE7qc7+kTRbng+MRb/0B1riUr8AyxU9GZa4DxeMybLRw87VvqioGmOfiINSOvFpX89WknbDN7bsSPss6vTMMKMltNQylj0VjtBXqgIt5PnSIeR7JIS8xk8QMv1zgMISe+ITyU3tCfG0GobYYXctHo6+XdyuznOCEriCSGsAOleFFuNBdXZNir0mQ7rGy1zU94KXJvWc89pLVMkst83WqoU4Je9czXLKeTnYj6TIlmG5wV5JNfQE8eH3iVn+AjIvglfhdDJHUa99sZivqFxqv89pqd32WKktV77mKBblnCLpsS8eMF5N1nzEHJZatEeKnIYaaRYgVGvrUGgM76EeHYj53sv/AOmU0Q7Y/5PSRMcjFBzWHxEKdxTHvSROpPOgztxETnfdWGTsmupNFSDNfv9RhXyg5IHqfGoYkKLz2vagm56x1+UeyPZwOjo2cBRiXxVLm/nqPGvFj7OJ5QPktH7T25ha+PvKSRNEd6+7EoLMVZMxXCYeqnOZVuAnuYj9I+bY7teQDpw33eyTSI+XRg81ZgKSrK9+fYJPuXG3ZOG9C5jvgnIEXyU7I3zknxWTgkhE+DaX6Owxxz9+FBL/Pyy1YCM6Ft/nW3jvWH7/WuaQnsLVdR7UbYXnazrTihTILNGAj5QTIMVO1WzD0aFwONQfngSX4XXjH1lFfr71LCLYsl8gOuopXn+BOLx9IRCjvjqrUCMbtPld4rDC/uZzbvdgpKfkEtL8FBFZx1BfUCLPUr7UnyjgYPoVTPgyimw5Cg3HbsqNPe3TJIThCZQg/ScjPoLp9aX32rZfO2TV9mjcih3DQZtxnOOHwcXMRr6+CwNR8BYjWQhoHu8i+b5xxg8RjDUnjQay482zwGQ29lALdbyXX0PwQaS9jT5fFFgujrtt7kVDuATZ/bYQBWJhaDdomIVFkgRicZalIfjUDh7/E7XSSrvXDXbwIJRAhsLZRIZmDnOZ7Ofj7Pbg7+NNfdv0EgHheNOHr+bp1RV58GjQ+h/v4YfTdo4fSapHvFQ8j5dYBwS7w8Ei8mA6nGyQO6Sx+TyJUJjIMjVJRJisTEFSmdP/z92i5Kblwjq5/OTSErDhioXk7xjZa4T1M6iRY7PwinyBejaEFEGc4wofw1NJqW+jxy0i6zgo56EoaFldQcRFlyy1GJkZQprC2myBR7v2uiP+AizAg1FkAxJBZZZdJDhHdzozdeEiNnEDmCDX2ETChYfiAIiYoo6fFguQa9oENxZaTBjJSJhoGGTDCmVaB/fR8WlECkO6VnJDwjGmXWUSsFDqbJhkLonPU4bME41XFiwjIllJV7wFcLm3HWRfRmQhMIyv2Gk7myAzkUtRMVa2cnqxkMqr8uQDyEsfzIfyG2ZsKJyUxOxc7tSM1jBn9pHH0vtUziMO/i35j+UlDkFU/fpNJYwsyeuEspTxiW1w2x5Ql7slmYrll8wdMyRpiW220ibcOZ7kDSwOxZbsloHbrVYYc7UQXpbssMQd8WlI0MhUNgqFD7+xQpLbsQQATWFJnAXj7B2GHU1lJ/3qSYRU1Fswy9DH9bF64kFJzXZM0gVaV/CrXN+WTOFQr3Ao+XCwpcRSWeJidD+mqaIhwjJXwaJSqcxGGOhS6hV2jiLqrQhYnrZFydFrj1SQx+alDVivpCVwWEx60o6WTxgbmNJKS4muFmYdrbl8ZK1DFGSvSl5ZawyrBjwIGliyG35BOGQcRh4DERxSHWZusLzgkd7OgVbBgE8NCZOgmKPFD0VKRonuFBXyx+91hZ3JfXTd8qRH+T93jtmWt34muyxk5O+g1swpkLvvmR4GrFyic4iLVXG9u5fH36nQXzu/WutN+I02tJQWl5vTGKfYKxFqaosZDCfcBVPDoNqZNlVWlQqFxU6lW9JeVBWAWUrdgq8EG9i9RKjA/iXCi3/0bQ7cqkzxtZKPdx5XSFtlj/v7m3RfzeQkzI/bqdtz6yuHhDuwT0B8VaUmo/6MEudKV7Z2qJbwFGaeqqJxH/H1hreapYJ8YJis1Ou6IQbqqNFyNq6iRXkWHMRZ9kGeAcEQVU3jDLMt0Jhe+LT8gDIzJ0AgEsdi4h7ta1d28XnE6ul8xRDWp19Rnj6mgzG9k6Oor+HvF+oM3vNpCZbUdcRXikNZqF6enLcJdTIXUHPjM0hf48gG5i3axBoVMeWeF/w4o9jwRqkM52UX16P+OpWYsQbiTnCdk4AZJcFN2EN0Kq6Ax0Xh3pBwPVjQl2Ld2VNpeQAUb3N2A2V/w4Il5+beIUn7xyzbgUAMm/EAY6DeUU2Cj0Tdew71yTG3qBOUA8fzM2HWX9JegBaFHB5YIQoLiInN+b2RbQgkkq858NTtHuOQSjzyKMvNd38pHLiTnHSM8nLuo9WDg2B/AN/oJu6Fy/ACbX05YWFRNhq75JguKjZRBWvAJadpzI2zm2De6UtAp1yMmQ84+FJb25NDD7qGfnuWDQu7ihmx3GXWGQRJajz/t33h7420L9UM622zU+eH1kE4ceVYbeAHcwfR44fqval9xtQNDdxnHN5QS1BmMqX3/Yt3z2m/SxAxYJkBq0oMSXEa7CGUQotTmjkOXAX8dSJLAJtRilvRz7ZHCwUzZIysIqU7KMU++95Yvz2mF2fEhQQkTqTYzcVc5YdPHJyNa3Z3QcbvPJrJlTDxUlUrCrjsZIYUs5x99qg0K2hHAATxOh5CUdfDMHr0wKTpTWPI7EZvXauyp9ul2t+DH0L7eGJxtR9XpbShu8CQ4h09pSjnmbAu+olevPjW03YC7tzgxxpZ08ANV4s/AP8lywPGwJBmdNNGHva6lbr2Jcq9rRVQd7lfAFGQxSfshA/6LTb0dJ/7Z+nWVr/bzNeH9gObBKWmvot2N4EDPwHzO14l6gaGhvnOYRo7DAssQ7TNetD21iHytlJNf+rro9EbpbM6X11WKUcmdwBV1tBNsDJBQVbmM82T2YXbCRF5i+r5brVOCHnuBnGeuYdOSrn6wmOWe+c2r732brqK6go04lXaZp7EYQ2BeoTb7t26Hmu/Veb141d6vh+v+VLadZmCqelPIR28aJQDnfj8Dut5FBRXvr34oeCUmq62a/JY8DWxY4CU/9qVUc4k1wKAlJuCDD2l8CGB0Srd1OjPziFnqT/jbb+IeaKua6+eqEIg2awUVak3LZ7s4SZPmeW94PsmopsVwj0Snc3bH3C4ulwZ7d0wrbFMvBqdH7aFDAhQJsZ9dNad/oqVAMsCikxmWlC2+ulzw71fAYxoydiQJn0zJnUkgboer9le1qtFqgqIKxvwptdbxvJ6TQpuWHMa9L6b9QqD6sHVePnOoU1V1JXql4z2pTuEmYJZrGKIWgJIWxq+w21rVzDU/2xuORGJPVwVTU6eOZCaaD1XMnTvpCyUhavEA1pmhWaFxjsT50EhNqzPT5Es0rSQgTZZJ3glSRLfgt5HVk8nbgpzenfZMDOF1RpaNynzz3jby0NMbUTTto4uGZRy7w3Bab5bAphpfwMjIoUOwwi2h1s+WbzloKuIkldkME9q1DthvXuIKCgDWv515gBNK89NwgzhfVesnkupYSO7uK6etDV2ew/uJ2h0WRmHtbgh70OcATEUoJ4Uh+m9MplOco7G8gBMlZMxILzhhqRzot4VtSjfOOqR/8BHSYbtUs15OZCqeulV2+5FIjFrJRCq0tdELmqp4g9HKe2yPj0nj6gRYbKNluVwNEdvUK2OLIq6TjVtxVQ17n20DeMygySL/T4NBViC5qN86u6SQfWlAsv/gmOTatLhjg43czmdXCHk5sO76ob3S9BM4guCEL2zDG0oIUlPmeTxCgJX2jVKqzy/9Jn70PIdLheVy88io+UqLGmqAx7tJovG2XlcbIt22a8mYC7VsPbP3daiAvjxaU6tF101I/otFXFhGA5wu4mz50HEPbqEhsQb6Li6rsYQOeGrQRI+jOKV+jtBt3ajti+1OA4ZuK50Wy+5QI30fhnbqfs0kxykMW3JhEsZjnDM9amw0e6Uikpgc7iP4q0tOCrgcUl9P9TDEO4OiZWYaxnU1ZOe544gIkMfridTR/F9WNrCXtHlmRbuC4+D1YI6I8Wf7wcJDS+jjDttwqcMvOAx/CgvUXLRFAQOFCdHda8NWgArXT/Jf/4kS1GfO/2o1d+WAprSAZ45lewEHxt5cTDmOAN6dW0liZ77djB0f2MuIhRNB+Q10WwSokwd8zpwVFc9i940gVHbv7hx3Uz1UZXgI2k8IRCgwM1LY8NBIMLqYTAj7plh2qvlXVbC0yxS7GN+b0IRrXpB+c7AMg5cQVgej7OLN5iCb3//NKZogmJiY4kJcGt1JtkPqJBETuFBw/XGALptdVssr9300U6VFXh+k3dE/OjUYfaagOEMWvMqKZbwurcVj/TZOY3pNs9QNhVZKrMBHE0YgmxtrP2LOhigBmQbXkmLs+cbHblx+KUR+Y0aRHsFaRDX98HKUxyDgunJhTX7szUTu/piN0es/bUAxqOOf3GX3pvziib/Xbkra/xm3DNWJWca5pHpcRsgRxbHFCQ+JBTREjxg9EbZY5zFxsiigSmsfp+Z1Id401ZSwDW5QYEERp20eqmWlZO+HjcAVc4NSXtPHsZoGRhP8Am50hJ23IMtBPbxxdEmV9GY904JdjWa2j9dH4M+7xhotWwofxMnRw4UOWzDKkWKAh0VQbk1oyiHfBhm/6ephiHUDhOpMRNFZOoueE366+ktn8NbwN7r7O0hI8FMn4zBZyeGCGsZukUNhDI58wS8kl+zvR+A5jR49NZo9HGxEEDNFd/w2EQyh3GIlz46dBJ5/6cQogWU/rbv15zdm4OrU4hvp3cfFDvY8Bp+zNNhZfn244JQkRaYtIk67Qz/3yhH9DcivGM+I+leqDMMzkZy5Dp09mJX0rFwixxBpvB2XGMviodxobJnDUhqFmF0C2Kaj3eZaPOCe7ZMHITg8A5XrP7WosyKh5Ev9b32WALznUiIcpn8Ba0bC3IOOSs7rM4Sh8Ys3iROdoZc4MDCV+dBMZSN8sHyvjZ7oGQBjv0JxPzuBegk3VfO9Xt5YeItkUJhrVi8Q4K+Up9FUe1lZtXbhe+sVEUExotzdJFreDItPBauJQRHbZ6l9afN36RTXCp07Ron3vIRmLU7++bw0uov9faM61eJgU2rnDd7Bgduo2pHkdPh/Ki1cIEE6YAOV8sqnVARialQJZEQj4jCIZ8VeYkfXZK1vDEH7eQaJ9MCm0Q+WyRkco2MkmfkMd8oQZ2rF5wck4z5Jjv25PF/CynbHptIvsmOkjlU4StStrKJHETltiMv+XyUJcnkujJKniuPea5UUIqIUtFPiMABd+JJx+XJW0z67FSChqdYFQEavoeO68XTR6LWrYw4TRZlHpfA7NA5a7Tnk6GeGQlsLmj9uyEwZrPYozglFLY0SAQmQe5+cXw9ZFHC264gxR9N1WCF8x4wkgOEWu119pTjh2JyLPG6ZkgHLeYQfwWMZfnr3OpNuGpszgt8Rz6mhgu9IWT6wySifk9pVoBgJJy/iFTl0rwvwkh63H3VVJHSJZPblZJSX6wNP+WzCO1zlO4lup2KFjJ3ZIrNgyeeYQ4SFM8lDxfauTtbzZHmvVCCHFExaQ9jlb9W0mU2bRnDb6nkTpROracgMAfRSKKNQlhlkp2rpQEtEUXz8tCdBPvOHATH9v1Z6FpyfY9cN0bgPPDbNmNecrHyvZXhBiiCVySqQ3Fm/PIEuEgwghGBztO2xB43tXPMjgk8/rWRK7DV+oH2ChM81keg7YhzqUdnGkU/49IAKKC+QmQBl99zW0cdiIZlY9Utw/CKcePU0hhvZOqBfE/I+UmyngKfyaNR0YPky4weZVMQDDp1CQ96bF/jInHvSR6IMqfEBruolZYPZUftBxxxTZ3jQuknQT/Jhq1i1yFXZYRGrmn3jYtPE3NCUYgRfsZjV7Algu0sZyAumIsFJ4Fl0XslNMVT1qOMjXa3cG0R9pmcdETI275Ql1Eg9o/3DRJcJ7j0JBXD8fKlmXqWrak4s0OQL9tcf1WJs0icpCu3Aw4bnqGC3/PidOhZg1wsU2bKIhBFUClyfijohHHb/doQG1nOrhOINyP8EAIy3L3OBrmb4G3ff2Vh/Kbg3PUPFzl7JRjaZsAqQSIFDsKNZ7soy/PpDxxMmPoePBNv3GT4ap/0sJJWR9fB2Ev/iT2MIjz4Axp4m+BNAjTuDOjCIBrHY2hCGAEFQb95iWHymsdZkj0523kEqbpAzeqwd2y43Enek6uHN8HW1PuFmyI4hNFJjtZ+YqIP4pfskQOuNyu568NSL6gGCW4e8rj4+0ztZn8vZlcJClh3tCRG/rWrSL4stBPjeL3ezie91Jdc3XInSSnUvJQD0NhNALFe/VvhxhBYYKUYciHciX/xhNg7/uKXkDMIO94hBSe30q9zB01nl/OZY0QeLbzEFFbBYAwFTZGFN7zDBK9YPhdjXN/9sEPy1TNPoszfhWAaLBiEKQTbREH3cYhRsjs1LqQ7utDclj/sw22ZNb00VjAUtPB688AsWAbzwszMmnFpJDJMpPe1O1a0xA/soHXXzax0d3HXJXNHe6y3PLERjoXuRH82ljOKpDNz6wCxOBIxV6b0csExgnWq4y5+SnOLpYkKI2TKWZ6j32RyBsJ1tMK5yt600TKKKm3L30TFVfY/+cz9T56y/2mZ2BFYNBgbq0cGJ3yFVT5e4dm6EJPwSefZc564mKIQpbaCcVKcUoxSRkHxqDAW+N346wd0NqNz6bPsejDiuynBoLn1LYTxoac5H+mjMY4rgJZ90o19gGVxov/AGIiiC6TosvUb0m/ZZlZmyZOceXFQgJGLiiEGu5na9l2ZGeUEjBRbsEYW/NhQP8rdaUrNocWCl7SvrfirXzRlNJODGxjsZjrB8KocTBGVVEZbzy6mZpk8uTD4T+8WdUl1K5rThKtkaZkb3PH6DnMwXuxx/lYHp/VdbmnHrQ7Uv7Ghmt7z7v1ACw5YZ1yRT5DML642ovnPoskfJ5E9dbCjrbmYZmzmJ0jDkauOiLqjJHowIybahrTcnXAx46uRP5a14DJC5PJ1P7+itxEpNf0A9nw339GYiA3HTzGxreb1Awbzx4n77x65gy99p15+f1Ots/3+jrxIIN+JF3n/jr78/qdaS23MU4OMkxyf5j1/EDl9z+fxQaJ83/1wvWc/XOX0P01Rlh9V9xMOkTg5SsyqMhlsHdPKnlUQnSukkjhUIut6yxnpCdYeot/uBKNepxzrj/gAmxBx8p9EqVoLD4/n6/qZtSwKeXybzu3oqeltLE3wYQ2ixWkYEtgI17x0rkg2JCGDgAEyfCVeM9E+YS3ys7E87e8aGVijiRX6U2fTaAKfglKBRvFGwY92wnxq9G5BSEKoBYVPrazUSPbyZFNfFXHpvX9Lmbve1YS7su7xLmiTcqTTkxBmMGPJEovy2mTUvspsirRKJG0XClaA2ev8tc3FTVcq6c68rduS7p21p+G4JBPgY5wjjcI4lqNCC3DnsRRHDUpOg3uss3YNsDXaK1EeA1Ojtb+ocv0BI8y28BqlYTTgr3hQ4lcx0Um4ZVEcFsujTlJtC1c25WqOjPrd2bJWWXxXBg5lMcj+Ac/VyUEIjqrL2M8ouu7HoP6HRgvZN+1CNZr9Psvbv8Qv1sMY79B8xOq05XmeqpNC2Ct9I/Q+LgALa9oOy5luBMuOeBBERDoj1c5wKQdLaVjnnMYe9WIly+x/mEjqzdP188LzwfnIwjEXVrbQ9C3kt5xQdEESk/9m/G6VFdIkLzWJEUJ5QOOue+Tg+IMznZ18DFTdhqgF2P0pk7V7MOIYq0fHg6MbT7PAd3og+z23to6rRjx3ZD2fili7axaIw3n1ZsftPmfMIl21lYIJZ+ovfGXH/8M3S2jedgW9ze82850bHtGby5dS7KmN7jJmv8m0dJJOATFNvhedQtU5IjLsmlDbCbV3aS7VsJpHSEabhkrzJlb8aA5WoynI0expoIy0dM/VtDcrwWA6UZOQkPdviLV4+4qXr3AQXSbxtcPoyAoDcN/6RZD4vukVJrww9he9LQwqQ6uGvghkcsQzRywHcFNx35QMhWV0KrLWMjLD7V/hh/lGbw6C9ullmk06K/1DF6iwwkEhG2FvCJB1hguMlvN3zyUd9oDCyiR4A9fKIvJv+DgSJdcxRifYOo4bEWQ1PeYtVh+kERzL2IvAC6CGzzY3F0r5hcgs0jmI70wnn3Ga55XnDKc9lFbuQ5SS3EVAD8L9LWHnkgpa4oHTLtDE94fIvvrNiPuO9XBv+KehNcrKPqBBc9p7Syx+90dYp4oVvRrsWYuoG+PSdW0EKumgXLNQmCDWB3Gs+Rbk0KdBz3m0OCnpUIqh3yzyN6xh548Gu/l5BtzGKfY3wssCmseUPogdRsJx4rVmib/jw6q9A/e3rAtkUYE7iwGJ2OnosngmGLxSQg23Pqr0hw6S7n6hrVwLQHeD8SRmEzTy8GhFuQKANssxJP2QNLFoxZnjzEtnEgEOfzWv8L8FMZJ4uaWvlRSrhZJ9+0OEB8GnzhTMW6EAfQRA537/1sDc1JHz4NhWvb0vY+NPIlKBT1vBvK740rWiQ5PAA40zrAHQh3K4SJweoQa87ex1V2mqRybhs+iQ6bX0UBihqIdmSqc+/WILVS22WBtnBjZZ9xZynCF6OCl5ARRsYAQHF256oCTZKwHw8WfRsVCwzWiXrQXzLCqU45pGPZCtvPkiSrRhAo/mB9zvVAhWJuOlLI4DRtlBF0m+oca7HQzhp/eYCXdVSikUK+orcTeKIT2KjhkFKKN9zRrn8MFkgR8oUy3lWJzeaZrL2j+l/Eha1VU/hRGOfCg33uT0XuWzaT+UJaUqlLVqiIhtlGIIAzDTIA38nRMPzB9dOhXEALKcXLAnYXV0vHXDsZ4s0Jap1jOkAhV1TjHjw6eBRiHSgUYX0iAdU0dADjjKk+Xdis/0lauZqdZ34BRfsjGrYDl7eRN6AIlWISr0CA3Ti3QEbkP00hMLrJdPOZZQWJRcy6n0IgANdaFM9QPH9ushqPG+89K11xhuOLWVdpLW1m7JHqXXo3YZx1l123KQtY4Szu7F/UpHY+8uUxcEVBUhYyntBGsoyA2kIhBjWo5pVbw2QysTeU4/nFRoac0sumy/vAJKUUqQXXpZs3I6SbuzgCjoZLQ4E7gKRxklAGXUIedaN1/gNj0ZRelRKxXNRCmIXknfBXeAxD+sZTRGZlnDiD3cxp7DIete8TfcNBC1GTqDuVxm6D6hNfq3cI4hbPO0Uly5UgY0fEHHTOEHcdLAAG4e3lu8HEim+PNWhOQ755XPKpZzqiwR/y72iK+YOtzR8Z1eiOjduEf4j+xNrhWm0CMGAmWk9dktiopDG9AiS0h9adCbybEZyA/XA3ZUQKxh3U7fChC11Xpb0bJCUIx9WitRAGGuxMmLIMFyp/31zscZC/KCwUBMS1CaNsmGTZPARUTAxdKGnTeUwbeHGKNaSNJTei+ZzU66JUFSwB0FT8J8prwsd5+TADZvy3n3SMLuMFwPoIz8FoHNSR8fFqrwSC5e8PbBzOyQl4HitFXdW31an4/dVbd7vNnHK7UaU6FbrKQ/CLZ/5u5zcTRW7Wq7Q/CjhLutSLQEuwJ8u5wDF0Z4sq10D2/9OMJjfFqK39uN8Ztrh2UX8gfNX1TZwyiVfO60F14VDQ/3YByTsB+X4YfbP//O/Ld3jd3qqP8BxmkpdIikn0NO+o7eh6Le88PdVo+zVm7Yq+73L1azbDlVHkNWI6ebHJK4L/IuXLyjLwK7m8A/sSb8Ly0yta13cSfaeOP0HFfghu8iKck79/udaTFzzhz07kYf9PFXnkdEFAf6Y6MKmx2dMfHa9DceFvLhRj8xbmEXxu7GqHYjhQCJLLwSaEg5KHmYao9luGk9dVlIq0Ai06/rr5gqa4dB+BiYI0Zt77JST0TyZI3Jq7YyhygmGtlGIgUYl/CF4i0Rhgfn2S9wFefFdG6VnnQLhhdd0e7G/LE5xFpWNaiDtVbL+i+icD1+h+5xeag6O+igrGaOEobFlLHNvh6yEBxooWgqlqPdJNOEBoeI/pHtlCf5ZF5LaDfAZ3FkQe58bF//zYKNR1r/Tfi3L0V36OEHvJ7jV9YJDQT4h172WUhHxOwYFrrwzJhWdmQNghF0ZNiZwvtXNaVEY876AqI2qEYshz3n6GVWeMqA12BrHPukO3yTt4FmN0lLQ8Kkz/1ZPdd/FuHHg6pVCr8xeOq0t94f6XuPislD2ApMGijdzeUcLEBQc0TphGicBrIgNAYXQx8H0mtxUtcOG0h9nVmrl9XohKiqv0ryUc0TbnRoiy3qusKDD+PJTYW3Cov3eGrTmR4oP1yIynhfViVK/PbisCxF3jBi1DkUqTnhy1Z+PlP9fjvzSACwcMzxNK7JjjKLK6qJN3IBBZ1ZZAMyV9BTY43Un47BQAl0BmOaLUUtIxyUmhmtrfgNFKzzX2zUqFmyUqmQOhQt4fXEPJC8tjdJ2J7uMINiHVuNMpPLoLgmvdFZBlUUGKJBMp2zSfex4vuY+GW0gIXP9qiyiOmo12vPl/GmphOUiV3bwEwXLzGmaa2xluKYs+1amsGqcaLZnFPJQL7kcLGMpjluCjg55+Slz6ekeTlIdHMoTCzf06j73zNLl0DT7+7eXHXNji+qsr+FqyAz53AyI43nCC+ZdSBwf2Q87RSSMKPk6395jW12mXjFhc+mRuaaMoMks1TXvCVwJfpL9fBzGOwEhTsln31e7QBSc7fi3zvMzcsDklnurWabWogoGuq6YB/ABuzUp7wmsYdJT26Vtn3yzkmwOkLkhs8jsynWDkCyv5/xjZJVZU8HM1D+ST4PxVbQeKPkcALsLdZ9y8VdmAGGMzTgNGaFUy2Tl97eaDbV09k7Twcrqo4r4K/Dm2ixrKlxMtjHqwjMZqe1/hqYMLShxnSFGCz9vvrrqNjibGwTKFZhIHlCM72I+azp5U7C2Eu5Lnvwg4zVx5SLfvADjv/sUrK3A6onC95c4H+lyGXoAnqAu0xtBQTzx6CiwaGdDV9E02+bXu/u5lbJWWYnAv4HH413uC9EZkSx/m4+0Ho0t51AyPT5oaOOMvrqMSpmKRIZkUawV/G9m9Z1TTUdfL7lyQ6idzX0Fef4AVhO+rDYKH2l/nxAmQ5nTNw0Oxx7HkBWe776B2BuIEro95wcINAk9PTlfkg4OcfhwUKTy1/QkRErcccKHuQfM+Qes4/WF6j+xao0LiwVFmmbFeEsvu9qa8mD98FZ1rscVhIPxWrTz6OS13v0HqoOsfC7oeZpB+XfmROIRPQ0wtnI7sDPjVzed//N7L/vMDe1D99pbuHwN5sWz5oW/33AeEmRmNlBd91PRPLEC1hNR2nPCqHhaSW/+3l2xQe67YaZtnEcQkHNmZlFpFnwYWsTsjHmzmFG/J2T664vKjMA4NWOFz5Kuw6Ap3Krqvth6exdMYrbL1cTTObYXxxinc2Ui4QlZZI/D7ejTmGEBLa1EiupgCZpoMG4x9g7tI1ZZjcyFJoWrt+9r4fQsdBNN+61n4EmVW0SXFJOBucsPPPGea2CVXGgw6z20ozjJInzFEq0d87GMQnUU7IoofgV0AhcCVKrN0MU79AabSnDEmMK9Gdbn8e/EqZjMTExkJ+MwTM4VTjwF0EdgxMXOs0+mh1YnUTc05qdti4ZY3WeztVBD9kML3fMk+rQx1pHT7OuqQ9UE0iKeWXpcIm/xe8S4xaJR4EElnVYwgE273UOvIFI9MreqL8clQwrwhmxkp6MJp7K1rB5DRMsLCRux5N3aCEYU4BUwZDPQsO2vyvTf8FTS5FTDoy3nDOv5ZiiU6JlPWbl3jRUXpKx0tBAA4kZeTc91b62TdB5fdL3qnkMkUe3nGbL/MSWXqBVq9VpTXW20uFveH5rRnWZb1FwbIaQuyIDmfuo0M2ETIkkTGc2eyjTnRLRF525CWMK+VD7khUKFCNEzRIEMQcfrSwqmYGYS3GUpOX135I5UzTYimhHFa1EhLQu1snF+KwrbdbZrfZjUBrlmF2VdB3fq5XDzGOTSVmMf0xCRAkHw0DzaMUAEA75QyePcUXT06/WqSEtfZOXuCI/fbTVMSd4nvCD3ZJgjNX8jI+TEBnVyAZLmj4Ye159WT6rKfd9z1rwLoHjswHtNRibt75iMnOFKW4XKIOsnZHrt4J6LnhH3OZBLZ2p0hJvSMwbEGzbuMLibLuDehvGurRPs0GI3thL0weLN6YVE64S31JjFTuxmupi84sujRTBGQrIdPvB9j7W1IAiNnyDO39LZ31ZO0Myqr6ipT9N6DmZ4rkZcpN1AXY/RYXi702cRiKFI/p+0Z9J2BJ/agEJOB27W9dyPUIjrUinvTjlOQazfRGWU2YDPFpU2ONpH0IhCj66dNHtU55Z8MOT7mTK6VtoyMqmUp9dYh8w+ZvScfdwL+KguskOAYZD6t5+T95OyP/bi2PeQZtY06o3FkzC+UmEy0CcGqrMDXrMzOLyUxllkgsHontLfw2pO1Smrx8RkP42cSnmWsYPuDRFFVEGekeWCL0L97L5QT0LUj3pjIECrT7s1Jtp2RpyQThESEmXIp8c9FCweBzFEwZ1ZirtKELItk0o6EQUmw/eqqmSgPALkhJg/S0EgiHI+zLaGIvVw+o7OJsj2dQrSpOkvEvxj5ivukfPeY7VPB33AM1uD+3pjgyC1OVy+3VwoSCMSPXIEJGSu7Trj70jQuQvvS1u+ppik4j5BoYRGGv9QSQiClDVWjbFBL7RgYwCpieCavlDU4Biw6KARMsoPyx/WNi8umtb0tZ6kwzesgruilJbGm/ZpXdlAVseb84yvKLalpuEIrqiVGladAt30tnd/iPSfLOKYjoNKpJ4szEUiCoWvj9AOUh7gRwfoF8XSsye9Ieeulx90UTA5T1+c30oWQXUZZArqQAmfguaa6kShk8Kgp3egmK6t2BgAWLJdq1fJ9uv6Fpgz5X7NWZa4h8qcyNrLAGBoRU6Qt2FUN2Ye5q89GA96cCZGRHfCoSRo3wr4a0ek8d7zCK25HiWWCvi/VHBpfBD3Dtsjia2iFCtTXM00gmmAkZfDOmyjd+aIITw5IxdJ3Zq7+zgHV/0GdK206MpD+cjLbz9WYIpyQa0UT3jqktAzATB6CQq7i4LK0FA59RjwmmyoTM9AYOQmrZthtsyPsLAAg08lw0FnaB9/CZ/kcsQRtGc54jBsXcHa6SU7J4A+cmp82w2YgYDdaIDxvM4A2UyC5VuqRom2DxntC4rtrr2ejqjgPppEjq0nLck8X2DIfFE5AnpAPlbIJGFs2JXbwewtZ1cZ4F8yEWK5uPvhOw52lGGhzZiTHp6ninKo2VFmblSYY58+ZLxrm/WC2V0uptnamzcR+ejnwReq2ebfmefB0IbCullRor2UpUok90hI2rQqExD1p2+xsCpJqZQmvmLZvnoNugVQo6pccdDxrxYb8sHh8q1Nhg7Z734JotUzJS/yUurH2H23+BlAJ/9mhc3V7qRLaniDeRKk68WETGSEZZVt+87w2xLoQskRSeuoYWi8hQo7bZHwnpI+PKOImB3j6zgcycbqN6SxOw+oQZ7re6AMiszkMsgR0RFpiPo+b40CP0qSzx9f0dFC7rDJTaX9l/0Gz13zJaoRq6RW8Fadeuk7TrjS6S3iPQrPhfOFWTV24sEEsJSn/1kxNcxoeucOOhyruE8hssEhInOeT1XOVLRLwsl5MrxxbAF31GYFlr0pgA866hNkfcbugm7kgGczqltVnMsqyXh1LbLh2CWYJfwqSw9MQltK0k+mj0lq213okHW33qJ71u+G0W7wGTZiWYku3kmeL2cD/sd8W0qYaynbOPo1GAtu4k5DRgSt9y2fAUpT4Qc28J9AzrmLBbutQSfolQy9XHWHKROtrW6EMCVXJh46961bj2S3KGDVMYbbQeim1uPv7hinarOqvOdmT8foYGqu1MQmxdiVqQFCX4rZ0ALmtam3d0MLWUpROXA4vwQOSCJojdv05uh9N2Fpe3zyCP5+Rk5Fu5qGb5n/ojt0v7xYYYGwKAmJEHpRSXgbhtgrS8K4my3sR5ttmhbuhlSf7OWez+T6EEJfcr1KFKy+0MTif/YC6Kf+m16XL6bevb/bJjouGEK3JdYvQSJ/JNNXbypawK5ZjfaEPhwkEM+GhYhbUAjqGKJUaz1AwDwJCGo4gk8c8j93nryxm6o+O9hShzancvyE2eKAMzWdetLBnWyDI6XGzQpPROEJbvAl87jAEJc1FKX5yb0ku8Uulomc/p9x7Dy2/0oAZogkvTFbbjH98J8f1fKvheX7lpQh14bSdbd0uQpLEMZDu1PatzuNnBmmCGLjynoGMDgDa9Vz58G6Z1OQLYV3vVN2rAlsS9W0wW4cCqyHgMpyu2JLxO9SdM/7Dps9smCPLh2KBozn6jZ3onTdsnHcVyEbjSq2Nw7CWydyEVc4rA7M5fdbCLzmDanrPQTir+uIoN5733NWzYK2wgW9u3CwBM3+vTwzkQecyINz54pL9iC6OG274SXCFs3NzncHad5naq4s0JOx9HCqsxxRgNv+Ml73PXlzkO4u0J3Jazkc1Oog7KJPyS0fQZoJZyLWvQKUXdnTMeMwbA8HB7Us0F8juG8By/y1nfvRqsD/QoCHPx2UAgdJqKfixr6fF375eBIfA73vF3P8ZpeUIw6/j9cUgnSROHFao7wLqnk7rd272fORv4vt27BVLwX1aHg9MWs5ZYWf1Mu9ycGelRWkORxlNMvt/lOKn5hVf/yaVQmZpVrrDwmyY9hJ3b98uLthYwtf8w3usYeeJdPUVvYFrut6XCSPXCzukHRUx2PvocXTOxeHUNW2nN/Jro5AmAnF1JnkJ9RaiCsNwWcLrT9gZCPN6H+RR88Yotg2EJw56CMc08sgpQsXdNXbKi94j1wtOv6E7vHlpVeZkQomihhdRpMIYvW1yaIJkQlESfO3qtApwvMWcnvao/0HAgQu6HI/brE9ExHbcxaeGis6bHaU++wnC8+kOKksplNkXV4NlPbUvugm/HcROjGNksX7+s8siMWQdsh4Z2GZqHhWvI8Htwf1w9qG9++kezzGBiGMX42TgHX30zBwR5JNlna9T9J0qMq+B5p6jRi4gbxAy9rdv27mUf4A9/TWUTTuTi4RVKTvLJGq0BugpbZ2GnYJk/7bPwWRt+MaNXzV5dspnEHTz4KGBOeT6lnflg7+LfQ8w+vSbPk5Y6quA8q7tK+6PxFgM43O1zySjXMUJsZPbG0cjtXvEzlRq9m3oY6YyrB9eRA1ZOS0CX3a/VNu678mBqSw6iiUISwMrD6tosZdvpUUdPRvOmmM7HMSBzzpIX5ax0ltZO1ZXk3kp9Re5kLHI7nz7A91cZCt7sd+VK0+mEmhOGivGcAAdEbylAJRV1BcbRB0BxUgGgefCcDk19wAwtaAniUFDyhRYKoNysKPjl4eSIcN0myyCK+iVttLcbJdzjH8+Ew1Y/i/NIvWAk2cdomqsJ08Z7lSxpt3ZElIcf/4dWdY1cvh5Xk/m2wyQxAFX7zUkuLqtgz2Ix9Y8QWT+Obo9skKf/y0HfPMeXQ3X5znI25rKKdpKv2rEKaaavhw9PKIvhsL8HtLXX5zVKt8Vwcpe3Ed4FX3BNEQqVpj4iYcbr1LW5Vi3aaSJLuwjJkOBEsZa1J3yvCOLnfArq5GfGxhke6ttYSPwSstOz7f0nqHts5JJ05RwujeqCpecqdZFS9fuP0GTlbGt0ThVbbVnNITmEVfCCHtadCBDc3I6kXVZG9yC3K3vm1pXioVTvXMNTl61zTwyBK7JEEFUtuqTSy8diVwEQ/nwruIXI6OcGb3ka3S+k38BFN1NXFjxjm53L++vI5w1L+4y5blyUK8+Y/A0//mfLm2ZynZxOGkXzzsGKeeDxKGtr5d2SCX5bBMwlknjlTbfpEhTX7qdwJS6FwA0mA95R60C9ckjK/NXtKPMq8eE4zw6P2QMdLwC9jnrKgtuyCEstSSfUhTfsHHm7j9yo9j0Gy7npnBrMPTDXAuorXpUZefoy+MKquW13qVMcZDceBN56ugcbaR5nudr2sGlZNqxYvGjTsDFfdPPhcOovGtnl5+Kkg4BdePdblMvVBudhuT01uLGMM++kImsakP5R0t7ogLI9zmgNdahSYrm218O9jifbdffqDuPFkZjjv++Munv9w5Pt4ASrDCOfPHE6smlcNq6bzK/VcD/W0shgXE3NgFqtFVXaXvOTX+pJfu4tf9iLfxZwXboHJXOHgWxXgn4rLkcllNIWH7CJ4nBkvzhqeHWa7+6IRangY19iutTuB4EiX7XbIXYRZyzaCv3aPDw7RU04kXPIuh2eLdYW98bKS9ZGeFINoANvzXlAnNa6n8MG9t2OPYSfJ17RZarpUpougv3owbgxSS1+Dcirim5ro7z+3dMpto0qJNeGY5qHZK8Xd+rfbH3ninnzcBkkB9jULTGYBu8rSbsz3KB8vsa6Kg23Ev6o6S9rBXDpwCjyi+yqHF/r1ZpzPUsTrtfRiD9SfwyiY5KP0cr33RWb8pTGPXjrcTThXPL4u0MiTtxajWWJ6o3iJ7WbmvTImjFL4689Mo4xxgzV7qhCyz5rVG4JPKrGuY4n1Y2vuaE9Eq3vLn+YacoI73F9zNqow/D0MeJZIbmm1yuNOrp5aT72ec07adONeCdsYQGGublkPbmf/wG94fdfzSmHQnq5j9ASxeeEwhCdItiwbGYeOyAIOeIThxAGCat/WcGxHO3ROcrXU6Gqp1iXe3lqB3PVjuO/HADFBouX0QO1D4xIrt3K7qoKzwO/YfTgx25sku25Cpnc4qapRQ7KqN9EzvfWl75ZKC36O0BqTMLLYPTKorMYeCi5QCgWWa0dPg9pxmDAkntbBqCNgFHwNPYFT1+neD4iIFw2tJ9kno2OX6X6w4Och1ExKDZZykop4tIUrEX1B27l2Q9Y3HVkYcpih9V+EaFXubcY496FVW2KsNkcpj9AmQl5lKNu2VIpDi/e/w8nH0r7WYjPrz2QaaDVaAyKNU+zdom2lIwaR1KCdOZiOw1R315m015xopbq7yOQO0lEZsdfK74vxwBtZU1ztZb5ueGQSmWbh407HL2VDdT21g5p1MqorQ03+a1fDy+dj9eXQ+4L5Pyn6oNiMkztDLynJI69DRuC/7IHAjRmjQbKOg2u2aZ1kewPM8pyanWWMpqlmsyvfTH9GqQKOqtYq+mJ48qXILfUIRmQtEgW6jkB+dVVAO8N+kbXaPd2sG6iQ2iJZN8+pc1bT3NuW1YR2vRpW1eKXg9nrzIS4YWAZDLnFvsRlsTatL1q7GPs9kGbsASOEw3/P8Bme0u9TvRx8Y+ufzjBXcfwQg6Crhmj4GQ4L7zu12M65VbIiBOd5m4rZquWFb1So+cyEcOuX3zrD9vDjUv7QuuWzS3wuBhKBSmcLfuNpi+LNnY5A+1vrIhUlfzqlRH+G+RkDWs+kW7y/tYbrn05h+WeYj392+cWsgPUKlx1cVO7++EHx9/LP3/R9NfBitt4UL8tZ/4r/fBjki49nOBSpfUY30XhYlLN1wsYcesESyzQ55+geUtQFIdKrnZpkdx1il19wMQkq9hNndPAWcZGmH5fp6MKbSFF0fCCJU0et03xvG38kS+0tujCjNOFvlWOpfz8eS93M9zcGEvN9f922tioGn8ggUJi3nqeKKh52DiVrjLgiBf44r2FM3uW9++s9YiJ1yj0kzjFgBckJ74AO7vWPLvVblePnvoXUaq73J4g1aTb4J4hlacb4q0kPVsLTOejQd1COwm7SZJxF73VKByqa/VmkXQgNiBmKF7kMou+Ht6K497w4oGxuQWndZXWwR496sakOOhVHQ7csl5OVy2eYQqtGNmtX4CfbiDwbv5eH3HBOLBHuyySFo4MkItQjusSFWCg2FVtRgiwXRHYXs05GGflJyo/8xFErTa7nnRfS7yBDVuigDYcjykWLnqBdp4yJnPf1C9femlNvbhAK5ldo+woNps6z/QsT1wjnQVyPBbQZZ6LUB+X0grp0pDxwEalKrkGq1lt9Kb/EgyEDBp2NRGez1yzRHdVsbZICifIeisYFvU0R885Bu1vItjdeSQd5YstURZJhFpTPVmbXWYdbtN4mMHP91c926z4T3Fpv/fVTMcHUvmJaHsmyHHiEmkMf6dg/e704B/v1Ya2QB/4ZY9HCJGt9do/BUbi4/OTDNxjtEdGlJrgFcG4+sEY/7dKavSx9GUQfLwNBp2/zWx4Ct0AfKzHPPvchRgfCdfIzRj1+h+uvKTiTBONJQBg1SIXVpGGnxb/ZiL6qQe++d/4s7ImuQNzGYqb/Zce1k0A6b11hd4FLmedOjsTOudoHxPbDuwpC4dmX+li8jipemmjJWUNCrkIEwl55PCSJ145MVAFX3jw4jgwUxnLYhBDvEz6mnAdGx2Z6Y/aPNgzYOIuHOOfojdMzAvOoY7ERXy8VtQXrDSYHZPwQEydxmHyQwLOclWZLKbckCm9VToNQJxWGWJGkykDJAUExAymARNeeRs65vy3QqyW5HQgQBtVmek+CrHLae4VjKaS/h0sqRT+ptAbgRGzRZ1S3TFJ/P8DLrz1C8XiPBLlk2GXOPtzsELVtrEJ6fQ3OfTPk8PE6vLqKczZH9/rM4F/wlQtR5jBL83UIy6FXElxOKb5xQqcyUFcWyDDrlNIpA7CVm21RuL/3DS4ef24GVDJY4C9Tl93H4hAJ34/fMph/4MKusZfIU+NdEM+OWM5t2e9j5RIJ6Gqlsy6rDOZin6rpXaHyb1vxfywaOxotKqJlfkCkfVbSRuauL8eA1H+OTK4qFnjkwfMKam3WghK3Z7qkmkJyWQz60LC2Dw3TrvDuSO0NjNIyBOepZ1CD+tAgcdnMTXFppbwu8gJzvdEByPuROe6LpnG2ONSUuiZllH4lzHQQkHo3EScFrilJACczUVDNDSYog1ffEpc6VxQMejlZIavncxghs1pn2WrtugJaEOIKTD57yXUvug/+j3yNLRoeGyqGoOZG5JdiLOHDgIxeXBIsG73CA73EQvXxZiNicwd7K73o+WQhsDOZCHNFdvR+WpZ9Q00Apr2e9Pm0MWTCxenBXrMIYo1GjmlOKOFuoixrScdCrB7GfcyaWEqWEdE0s6SC+DJb0JMPs4es8BBs5Fw151mstNrQe+egjInvwaYesAZW5M12iBz3ynJ8Iq8d3MwyfAVIHE/H/TK+X3VzVJdz69A0MIV5TKbcxyaunFv0Q6xkZ/i/5LoY4qU5o5+AYd0SUUdZ1SKysO00u8BxUh7kw+Vvg1TRtsJCYhFF7xMIaHJmUVHcoIP4C+/6cQh6eQ95Due9j0Nx/PJ8bWtaMYmEiQ0KOob7/TMjuosuFIJ5kxWF0KWPI1XmM3/gSo0osxpurGI8B1+alJvaO2yfa3Zy7TiSkQTFsPhovHgxO4P80jrXhtXVULrz6pc6iVotTBIRE1wiXNv0xjKG0YqdL/X5fZyE/cT4YpUdvL9ulMHZ+C8rySVNx3Ca4WHhe9SK7mIvKWRHXg9JRHvNDGlQM/ZcCAiGkmoRpES8jDTy7rgW3Mg1o8iVCa0uHGDvsCs+4ViwkhNUp5KmU3y3BJCGfwSJVCJHYWqQ2M/ix5Rhk4BL1t6VUcGVGjsUO5buMK6x/cr2xC5WjQP5S2/HC+MrdFMlR2Mx/gTeRSvGfC7gABKd6OCr9T/200Fwx6cGswuj8LbV2nIzqXlopUdDNPCPiQZ7ShCUqrcLpFDA6WHvcgLPGaxaoUmeZ9v+9OAPevrVPfK4dSYZm5OeekrKSDaD8tnTdUteSArwVsFXlt/T0ypJubS2kw7VZzzl0LKQUY61FI9kYeF8Qb2HzevBmN793mIHsyGz7/IMUSSr0FgY5/UWSeOoirdDCO94NRIk2R0qxSKmjMCPAbkk9InjcKmbL1nhFc6TxXmmP6viMLpcd0tO4/kgaJrGjVhLBBqhRS1uXN5gR0WnwHTaMA5lD1ngE4v2IhuuUqKKg2PuBBSqyU+IKXs8td+Wkq/7khlKbXMmWcqA1/g9duoS9Enqfemp62gv6eJ2mS8D7Cg7Rullwo+L1hrELVN5USEqz7TqQgiMtJlRb0WNxMu+f/219hiQVbkgoCoi9fiZotaD8F56pvVzREPbn8wiVTXhUMievILM19Pwsz4Lbaol5uhVVlT3qXSH0UvYtIQZxnMDeeH9AyMahW4+jBjW3PJucPuMYwUEQOHrT7Fg1Fzxbvj9SWVujB/dTij4oM6OTwp6pcune6Zj0imwhZxbAgVLYIP18F8dgSN0TYMDU4+Z1kJwSU+dXchknPpoDFMKT82omxiZnYrnMalC0vjSajSirBzFMAeMsYHSCpUhzUkWRXKQ9DPZzn9CUpgj15k8TVKW2Gx77kXBI+AVkYCqsPBzm5nM3f7WdnSaR1ALyOm1S5tqjbuah5iuTCukTV725nHc+KT5gdE+jlA2DRDPFRuEeq0EkJvtuVrFj7gnHxb+vP5Ij705q6qXu724bjwPttpxkDUmw1vSR4dQadU8EdUFAh+uR8mhwSPJiRTzld/MYGzhR9LrV/HGS9jD6DLxnRMa7OF4WfLUyDkwplHHGT0s0a0Zz77nSLul39NkuXChEXvwKgLJL1cxjvAkujIfuNLPgN96Xrz4ErsmCgoCRS6rJiykS1ayx/x8bqRXCGWTxsoOk9nFP45vIh6T2hO0W9xQRczpNeK+6qaYnwZDKPPgHwaBPuFrNSGnV2vC+EdBDOoJAuD6CApoumzQ4qslMPyEGj6+2GX4J2UI9OUcpL6ihbCf0KDcTyjBpyuL6qgoLscdpS+ETJ7KdxUpxH4fAnBg5VgVsgRQsMuP5YHPgUkRPn7kMgm3J67YqQWKHd7u42AjrL65ZHKSxJ9Av/fmbwsiOxnYsb207nkmYTKGW63zMQfIG0I/kVYg5HIDGF6SsbCUkCIioTn0Wd2VWmvyEYpgofQArYrSWyRtPXz71bwYgNeKd0U0TWnPZFPKlSU3LmXbswIrG1uXwqLom2Qh8nQdo/1Y5sIONFliF5YiKxlTFwg3qmFs7RZODw0TlhHojFVul6AM3UxT3OWokejssoCTui7vEpq6Yi45l15tCOU2TYt4uAvNSOTeQcF1sOGn3dDE7WzpnKJZMpzLuFmJhdu+Zgxa9nX72tfHPCkgLzin/YJD8Ad4D68Nw9s5n2bNmbqeD87sXfs5izlgJ1vKhBVPZQGwwCz5kUKqUxb5jNYPMwmVkMX6B7HPjHxcAiMpfIdInShRKTe6Imv/kWz4eftS39sMscspDcT2vgjwe4fvaPCVNCB+SnAoaWsNKPp4mwq06CD3oepOmdamPDF9oUDeL7y5OG3fYl0F9aXdZSYtIgXrgV/f0oLzORe1VnJmZru+0pV9+h4ZB6BaFDbJ1bnvKT83jjnzbjkUZiIoIEsoWW0t7e2YqxCkLoSDpYspZUl+IjNLUlSpREF0OfYRkKX7eriW3sGODsxwNFTHaeT1mDHWa+jS3kz2esXZDAdX+6cFa1ZNPStpudZEPBn3ZtYwltG8m5+lJHED3rLqmADPw9y+muu4anHz6BBN58gKTgT0uRHailjFUCeBh2RTX27WP658cH73lbMKT1Ld9fCJ1DVkWNeG5Nh+DOpwm5v9FoppbDZJJeZTLWmKhexI2Q7/GDvbYhxN69/7WVv0Ot9SFOWOSqyv3F9u4Ade/Q+l4JoeW5YsHML2+ZXv8GJW+hRWImAVFO3tf1iRFQYFG2Xub4uxToBt7mFykI9PxDphy3a5D5Wb6mANarAxjjJkxQhi2ySc0CB8nfvMJ/5z+e9/Bm5aJvjlbUlkwhhNcHI9IJwPnpdk5tcHvS++9Gz6xrS8/X7RUSoUNvWoydsEfXO55KCe0BVRXpg+lUMLe9fj9pAUhr1wH4Qtf2D6e8ZqMqINtcbknn7mVzN/T5JXDGvyplHge+4CPaqXZXhvLylV/G5CPyqJ5mEZh1rCxEJcsPZpvJ/oZa/CpSb/cVjmsyY4naqD13nTtoOtzQg8pmRPQTqaEDA3h8R6EUAk6xmh6rxwPVcXhjQ1w/STmGNKqrJPmSGuuOMi54lAXnd3dKMOxUwQV7DCRK9xaHbErvAuVCgjAjjlG518TnODog37eAQoOQcN+ERwHmf8FtdF14z5sPueS+Lz0kq77irBpak2Q4WwVR6HUNJp7/DS1IzsL6Muu3DlQx+59ay7qucPtRd0IaKrWKcshZfSr/1v8eYunNsXnWyHctXiEwfzGbQPnS9CEI9doLQMk29nJgMkuTRNpdvgbaRSTvdaoOF3e5Zdk123dK5inztE3P7O11i8p9b7waaS1Y1tDIAB+r/x315cduS1iPVve0kzt1wWi5IlgMNR1wjQgUuYEAN0NkBPJTWWRag8yESMKUjtjOfp2hkveA/Xd49NAVv07BgOxg63+5gkVw7WGCjxNgMvEzC6bPnhks/cSZY+G4DFjdL3bXJF8cB5dYTcTeTCkp9dz2Fw0cKAEfQ/UNX/QUTZ9U8+8BKHomutNNWhNkWm05NU0FVXypwe/Oo/JPAv2qvEkTzx259oWi2v1i2vfe9Xpben/kmDbm3KkycapI1Zj5UqeWHPz+aJ5KoRbMdG7iXu2R/bXb9C23NYaUE4HCdXqIfgOy1oKCgWMFf6U5rM3vmqAdlPmp8KKx3Oy0XzESYt/eyYukTaEeFqBxLwTr/YoUG9KEI0iq8+kYQSQ8Ll8OFrG4DP++PVEP+ivEoUdpvxf+imzm6jAyU6lh/TFJzykpXC8b91IicIaEQAULsu9MsAICZMk2G+hINd2bgvDyhPQV70Ht5fqKN/5fOYe5w4LY6FIeVpClHSB5FHKl6xW4dUPvkKSFWcFdss+Xed4soW/xBQA4jpyypwGenLRDAzPR+wnQhm3XvMZLjaX3+f5H+kvyITqIH8r0xXRIE93QERTZalm3AYa6USfsWj0tMremvBb8jbJ3PeRpEpAlddsiXVOTFX/5Lj1QyvKrzinT4IiBR7/m6PPIMkZSVxHzVJ82gljITnAFeqVEnuFaZ41WRJcFLT7RRqnpnkbo6QAyVNbk9LExs4q8qSyajK4hbFvDJFfQ5VcwofSUQbBqP9dH4FxBxPj/z2X1WAUfvReg8iFFYApp1Lm+kL/X8tOpv0nmsAlkBUaEslgVxVlfotEAGKS/jmJkPdiYSlCbp4x7NlLcr4ucqdgVYdU2unP15Dvi/4fLC1rRN7d2EQFQt9OxWt8ZDNplKsVRmLniWTOonY6omniexJq7ImLXUCsSu7xCq4xyMt3M6vZG28vumWwAkGDFvuYXLDWsiIOuh728K9MzA2irSi0BTdRNp1seXiS5E7exBAIriIbosqrGcljmdX7Gx3q6CGWd3y6dE2dq+cv2fUGXuHCQI4OQlYlT2SVS1R6HrVE51j2V3FlVWc1Vcn65gHAu8mKdmVqorkIi5c8ae1MBEbbqk2Q8lUibOwf0by3EVCazFOu1Rs6sB1ojManyAzm7CKDUd4lGmNB1/bAVej9D3/dDCjZ5u16p7QDDNGvD1xnGsmd609t7pzRwpN194zm/ck/M6W7U78XEl8AwVEYv8VueIHlpujW8LnrWn71jgTk744ZcuaabIyq0z1ZnlB32Y6XWrkrdcgSCdOKDSXS0vF0nYjVlOX1kn3+Zwl8LY1wlMpGzIp7Nj8k+75wEJO2vChuU665xvRnQ1/IYUVrmP4Qwl4tskxCXUm+lN5y14pKkH2MAuPKeUDHb7qUVrfFoo6JNtj//+J6jiQ75y3KLR3RSMjGPEVsWjLmmmTsRCqtmv4tXSwKgZVWjXyxCm42YPNV91BO6Z4uYLyZJUYNQZh14C4catJvQ3SwatdZs487q7L84KrhLwlAqUvwr/th7cTo73QnxzNykqZNuXDuR7C1UDUlewtkLO0wAaovdnaJKyN4blZ/8JUjxchlMCdzRMBUeYrwegiz2tLTNCgIuCwRIohxFZSPwm0qttFqYPahZhqsAqqor3bWhx8FUan0c4qHkzLaTCsQDDmK4LJKyhSshWyA1hZhbzoDKccrt2ITz9blttERyQ3FFEkDkRShBXJA1Fii2u6B6JISTgpIYg6LZVJHUGUZ8n77COiCAQMQeri002R8DrLJsQcyec8DU0Twk9epL4vvj85dteTvK3m3ZiRf6ED3YjshUQFfzmRAFWWuH76BXH8LcfL6fIYhSqkEhyZ5x5ewq1OSblpXYjKzLaTulE3cXNwuoLDlvhlp4mFL67owFVsjsplvrV/TkIxk3ryrsnCfiSOnsSPzZQ6csh7TROG4tMEiCcndxiwhLhBtM1OtnDw6XOaxX25WB7PHbJZ9CQSMvnbTclVxRd6bj0X6fYzK5Nkiw5Xie3hMMZlZy9BUpxF+g9zQxVAdQIa6Dwl/W4/k4b1dxHvZQDFTlB50oDEz2F3ok6P0RTDKAvF4pazDwJTJiN21pNVpSizdZKnlf1d4TVr80BgQ2Ny3mmOhRM/3Q8wtaFKPGjJQH2Fx5lFW4w2j3pltctyhlTxXnqI6rFIocbmg64flNKwXhh5ttFesGnseoIccGpKq5oeB3yeqQU6+mDP5U7Ang/24W8+0CXqAZ80lYVcq07y4gNTuq9D5NyyDqCEqQb2rhl7CaZx1x5tUdDOa+Z9aouSd8J+T4oIIWcr2mlu5df8fB4g10RulZC4diT+yP6cqDn1nIgsh04W7IkeRXEhOsGw7lmQMKuFOjEu6hLDoix5C6o+rMU7busb20vypLIKJJN9hUQrvxoZculRowobfiK2sI79y3buBGy39dcUhcuswo1ZotR6wjXMEPggAt2ylGDTxdBF3lIsNNLhiMwvUSBfOuUCazgk5a9ao0SWNYU6bn9qO5zZq6WHjna+hjvNvL5ZAsOYtiTnUsNEKuc5kNr8NYQnjdJOmL0wcBaNtbh1GvYrirkAn5r/pNYZD3+h1yAy+33eLk+8Va/lWPUAQtdRaIHLHhTK8fVJe7s40Na5K/RdIPLtXENOjPFn6u+oPXi2MlWF8AOujdJE41FWWdTtuPKfHuUqzEFwPu98OFjc7YUkrCbKtC1OZcpb9mJfaUv3ahCy6uWpMg0CJ33olr1bi+yBiDaRBa2xxXQllO+ve+QXDaSpm2uYHHTQi1+MSLhyQFErqgVRsyxj68SITmU9jW7H1hgi9a03XBPZCLiJ+dM2pGi8qfKrySwqRZAE8elgzgGrgHraj0wd2syNzPv/jybcESpia44pXUnmZoyqmq0OtU1DxKAmFdGwqBTPOHmYcz2Uxw3VtyQp4DZzy5LtI15iMtsXEaZjYpHcIDKCXLBkkuvLM/U6MbSLcl1cGo9P6d7AZBFJLUanRITwQcoLL4gw6EH7z93a0BWjAEFwpQxy34PyZ2HxZIHtMyw/Jt+es7BF6sZ7C9PMy3Y+bfNZ0ky8kTap+4ipbSV77pV6e4nclegJBstyevUHQ6JDhihYoorb/SN0xMseQ1WbalpmWAbfqe6/34yQQeN7TGYaG94pgmGH0ZrMDGr/kCxZDr3EPqYhixhb6EKe2Z65QZG9rWvrL2qNR4tg4bAe3uK7wC1YZbw4DziFvBMx91cElF1OQ34NZlEo/Ktvly7sqiFIoEPKJgmbTm296Pff2tdKZs/5cfYx3j6iNUEhQ7yw9Oczc+tybdfq79+Jm6JJOmZvVuYGIQ3TjwzXB7hX47fSjs72kTmRk/IgDODIyY84R651cZEdDuyTMEKTJ0w9UXMOHWH4OQur4lYY3Oj83OyNgpE57Daclu8EBgGXS16hPYorCq6i2QHVOJ69l5D26PbEwWc2ym2VOu1jj5ooWu6T5+ty7vNLCt5O0GHmk7c6s0ZogrgK7WO5xLF1FtlkMMVCABkKrm5x5AMRDfWyRBSusEXTEsDsmp2cyHfdK5TZfuyjAZ21OdOzBgptsNhoRd4C1arIeh2J3uSQh81HPnZGDjqCKdiFHphmcsZSzrOb6lCXEYVJ3d9+mGFGeiph9rN94vLsNEwtzE7SbpXEe8tnEKZAVxUAmBxCCJHdxQLjy51MrXc+OGTgV9Az5yrZXAjONw/Y0slzKx0sT5dddzf+QoJ0U/egFgiZlnIKC4EAUV88WXiVfkJvCwS/TP64pI+Gkg30NYcK49qBAXaOqyTj5MuE4HGC2kyiRmsfQYPpHAHBaCIB3DNZNRRrgmnU1hFkI7++VE1VvjZOqKJDrFzKGrs+OW/QdS7IHjewaalsRXhQCODHpLjN35V9y8AnToBCE9IG1syFaHl4NMIKCaoiht5B8BfvPrC/vGurdb/xACC0FIUunrvwyTZ4RUldELS/BnUzzFG9en+rhbkjoALRmfQ5IV+mVLYoCtbKlv1seKLmrahAjS3bbDoF+z4m/Rywe2YCDzXvbAVbhIf1zhSSxF9nCjf4U7MPzTpUST3yA6i18U8c5JsLRQ/4ffJv0t1V9esHLcUbbOcio6ZHEBQZh0kBHFJ9/dOPtU4CCKTft4nHc375buz8MzGlOzDfLVihgeTYGIilb7HRidnTKJLpV/gcZkRQYZMMpnJOjJEyadSQIsEicR4LB9nuKDBC9tEb8aifA7qx/D4C2OxJBG79+xUBZBs/0BCaDWnYgnUVeLJsnSyPN5r12bOQ/8vWZRTQk+aFSG7jnddps0Amfw9xDw5xUZ6SzDxmf9RJIubZSvW4hC9CEyJQcWMRo4DjPX1va3qI4KBRvjLomhdUEH6WIlnVTGSkOB28m0ExEL1uRNqtuINfWY5uAvrAoZbV4ErotNtCoNtsRHyINvfb3Lt83lUOZZEkG0ZBUUTIs45iJZZwFBtx1UlDD872zKLQZTfXW6BspKXhVEFqttfy7camV1GwAR+CyWRa0kHUXAjbD8Wacy6FhdzxqluOfb9eSLZOrUQbQESrC6cWCuN4cRM+Hb746MQZi7Qtq/5SXv+rvSmds2ZJnp8fb1b4lH6tYJQifD1IwZQ+lDaefmWCqkdLN2ZNVpKT3i6kNzl6nmzcQAobRpvmvhQHW5FXTOREdjzBr1HRz2HOzZ+pyLanbe4UzWbbSYPMFiVCpEAAWTXQ1hAbNO08nN9LrDWnofeB8ZzkQKX1nxGij7l2r1rWX7mo/FbeQYIsj6DTK1ZKTtK+TdPxNme0BaVw1L4CoiKWT30vsXAIVpOF93AmOWFn063TnAsLdcZf+s6U5Z9I4WgLL4F9Ys92l93nwcqDtn7+/BlVF2aQutV2BJK2yo7lM2Hfmg2pQm6qGRA4B3RewYG7ywMUB5ZdqiscmLfDhWTTcHHJBmSunEPIeZmNZHcYM8AvDi9ZNcK1TVO8J04ZRcMh4KtqB+yq6ABc3dNqPlJaKNjGzaztuzMaqyTgWibOz/JuCjm/ioGdDQECFU7hjKbsiDq5S5hRXBWzZudcddmDBwsn8M1jcZ5BnRk37tMuOri24P+rcKgjDJodYX7cxKy+xNj3Kcyy4QzWFAu8RwKqw+VCwKKG6z8EjDeBqp6WzTwJCBpkrM0UXL7XwfL88yA0sDRSZXFLGcot61SVPutZwtJH/yaKzBxFSJmCG7g61PCMG3rGeOMPnvgbHA1F2ott2XPVHHXM/TxHJ3HJ3B/FDTWiUgVUlHvBmSzuCqoo99TIk1ZYd+BkGAaJoy8dRmc3ariHHwwo/lJJQ5SA8OdV5ddaGy2i1sB2rxWMAQHJKACgJrARhS64Cwpo0rnBYr4xiZMJ90DaZ5MDunrOYExVX9hoZlkqBZzO49tqNT/MmsG3o0V878jNX7Zxv3i5N8buAzP/+/8j42LLrDphlvYb5mLML2dBVM96MCivYON0iv3KCq6vv0VmsJIJkR1FtntIgeuh+lkKqGLjLDpkhc0roJNYHK3ZIWfTXslqYhGmOTLxnruEm5z9PPERn3bGwVPHhWbcETjJNKKkVwsdZljPMipc2vnWEYhS3ETY5lKu7ZXZH5locyRCywdBJuEXexAeSTUMyB+lc19mVbcfCrNJP1YWcL42JTf96GScuC7EZAqHuFUcq9n8JVzxCqzFXb5f1W0RO4OA2SCit8cZA4rLj24yyIEgdginho9/ryBeDkzMw7jJDPpSXauu8l/4EnnvnaVL9+UJw6lZNZra59gyReKMGhtfn6uWqkF8y0cQWaFaqfHFVlBhOQuORqBCvB4+UEqjmwu9zP8xu3/fFifgv2/JSEmZBm06o7GE2XSM0OJaF2gQvjyxuxr0BXbWDAXIz8dM4J/7oYV3lIFEVBi4ouLreBJZEKoDZdULStYYSsJmuipypMsofHahXIqdM+xWCvaSfJx4nr/di0UZzHVKSg766lT0rToPn7bGWhaRawU1zli/0u+wnbqbyMSx2RyTiumxzV1loSL6yELgqsUwR6P6t5p35F+NzEIKL6LnVT3/ucubiuukZwNGlgECXtUaCuIb4zljF77y3N15VntNwuqLDz2IWMASk4xE8es3vsANHN7QuL46iuKNT3H2JXTkveVp4C/2r09/Rveu9Kp05AzTj0SyHdEV9bgKm1hQYwwoF3WJ0lyWk0dY9c/0AWTOlThe+LKoy0wyFuxByOgyDzq+mJ0/7X8KXBNxbyFnAb2KU+FvWU2q+Gs+Ms5luHUlISghCVfq4dMKA03BTWNWOYoCF3MusmwOgbolE4wGAZhFoQrY8MrcjHbPIhSnCBt03mxyZ5WEps9kjoVhTxM3EPzVRG8q0jwqHl+NWIJCw0CjO3Bh5T3QbK1VEasmemLCs5pqP60uFK3U2E9rqQ61XuxaXrvMU9fyzvX8+yJWzWHvQaTMYJ+pVV2sBaXOdhUXISPNiKc06mb30KSC6AE6HwWobl/1KPY3eIgrx1Ld/IofA0ThEgX8IfADVGkwn2L7BJQUrgtFm+YH/dz4smjw/gRqLe7Ig8eRuEXq5pkFTXkNAty4AynpQvt0UeVT6oBmLF5vD4F3SVN8QRYD9H8bcmLYFblyAmURYr8j5Sjy/tCeBVfJ7qqCmq8x5kEm+9iixV0che8jgFKv/QWvsLHi1VeY1E8Nf7gXgoGYYXtC0t9PWccmbeAbjpawZc1M7pvCa1gwclc23EsLtzoKscJhkU/g9Ey7ikPGe5Sj1ZAAoRywrynOfev4gEhnVZyIBGJ25gJ+oQNuV72BJ0Oee+kdHTwkYkz160U3/ze29OTQXUPX0eI7yhBfCYQlkfDEBu9es7Z5sRwBfwVtFpO5xtBepYE+/hwnXg9gnAvat3HuDgZ/8WSOfpHhhuPFdBZ5GlwQ5gNnksMlzq8xNuSuEiVllEyDhkgnwfmR9g7mDh2nlA8HVwFH84d4SM8TXDRaqBr+6m8eoT8SNMXI5lECVEy3vRtmOJuzfCK5jeCtkdJGVq6RVFYy9Kq12iPHSJqZSjV1oEM/jPjn0FQ1ingI9W+d2oleWWRIm6pkbpj5CJX4MRrenIJUXiEDfkZ0p7j/pJDD8i17nsQmu+NEgBIkv8WYLMJTnoS3qo5vQ0LztRc8MMuJSqFYYOTzhZjZl2eNtOneN7fl4kNAQJWGp4wu+ODje2JnTzct2ZePIrNHkehqrKou79rZefPVwpzi5y0OrFB6b1bEAajkcmtVuK8gsOXTBI6xK9G1gAhQKSmsE3jBkHWPRZcW2zwLrJ/eAuYI45Qq7BljFJeO0dluD4q4X4jTH45yROXQYP1I37Zw+2uXH2M56gYdYkqFIVmdRiOn+HCIMUNGe5A3qeCX1GU15w2Evs2HfhsqxGStsRfojcxSykOVckE4z5frUuNveTmX3iY3vaiKlpXXD8471bxYHn66nQl3u/F7d/6Wjb/lzK42QHQtlDcGWWULb2wIt9hK2oVd4oqQIRdtwFYebu8yrZRLlIR3tpCe7jkLN2dHWxFXeYf+Ac9SKlnqhyXgHIsmK7Gqu8h7nfnb9hYH+fqthjLRIpCIcTfr+UdXnP3+xMb6qp4f6nrxD8ItMawsmLnLpfyUBJEE/GG2o4QFo5YWSGOMKwkLw0Vckzg1yryHKZZ23IPWD+PqVOvuuYdi++YTO3KT29xJWVRuxqF7VVLgjXft7khtSEPlndmgP/kHw8MFf26QHDUfG47vnRxRNAQ/A+vZSv3ZnDSuWD2mY1hPT5NgDyI7ipbZHqIFl7LQRm6flQNjiZ3L5sQngLu6A7T2fbvZ0NeFngQk2lfEMElfL0GILL8weXNPkFe9O4lqf+lVhEuaHhU4Pwf68Dm+/RJoFFA7/exD2P9MhfraUpdxdb7wEXEhPo6OhEJ1U6aAjiC10xqhe385pbHRRiePP45yZL7wh+GSETYo1HlfylTvbzHqhrcwh8fqErtJ9vnkp+0TJgZQhw+AlHOOhHOkDMzyzY+OO7vp3XSHxnV+Zp/gcHIUWBzf6NbpPa2foXwQu+wmKwzcFqKJV96N+jmmPuqevo+4g2k+OzMX9N74257DmAllVrMe2/4a5lgpjKJxmNH2TXReDLx7NW1u05XrZKMqO0Rcrt7aQTyMTETU339sj/KvIpndRBdPWcdl1MPgJh7ZV75kLL7EQ5p3TnINEwkO4/d2ZS88ckM40+Jf5Xwuus2Cnel0xw+H6voJZQi2Z2sGCiQGDZ3Ce+zuer4NP3zsVzSwYcr/qshZMNAu9mzAIkwPqvFNBWHwNIbNgoOfX2eqx/MYOayaAHMlJfLUjGlGZbJds+KaCa+jmaltC7dOxVIx8zK1cLCYWI6x4Sd6JGbN2ZKmDLo9Mogyh8cxnzsVR8jnxzIklNVm5sfRUnq+81CECkp4eVCJqdWaKPzNRTywfa3k5UGQQfS1VcUVm+SRjb9lTGaEPy8tKTjRpqDD41rz2q7fhrzjQ3cXA6wJgEx1d8x8YPVucHkt7+DA9gfqSR9HybDIcrZ8UWJAhbXBR3m0hwhC+RY9em7RIAM6WUkVgPNCvrBpl8Eg5DAEC57z8/xNkjH78eE+G8FptCbZAwQXsq4DnJa/0i/yVo6XMAqSBZgJbL5PStpCZkoLVxptKZ5KmCNWEFcqAoh4VR8MEnzMncnaHt1xzx4J1oPOHlcxNd6DL1PXB4i5RPB049Pkns3w5iSMQ9qZM0kHdVGqp8UtOnMlDDwIZH+7ZKe5aIR2Z6ggc0G+Dq2qX3QUke1Kba8H/8x2giwFPZYvqEp3Pn7YgTCCmS4C79y1kdHLJFCY5R/MZyo3QmJR/h7KQsNnEi8J8klMoLFm1sZHF2ayhQ2ZKpJ5FddYhwtmXnXoUD4ENrgFjnCQtA7GQJRM0LBWS9CtdL4peOYEkThkmCV3bANUKtQ9yhfaioUrhvW50teLVX0NAX4OTCflDO+oJAzyTsXew4tLSWMFMz059XVKxbAxAD8ufv3HcJEg6qG6tuA8//B/2RsuS1WDavDFgE5x7yxrvzoS0d6m1+/9Pl/jtfaYQ6KF6/Kqv4rofa267hVfm//fDr/vRy38axNu8ItRmoS9K3Zc6lJux/nZDFPObzbzHljhYF01Pi4tParAYGjn7mwTDo8oBEi7INUoYV4paZEzjxQZbXaiYopKqkuhbjaqt7tJSYI9KBP8wNadMEiJgqZWaHD4jqmkNZi3KTmRiQL8N9Okh4OWZzy7CF9gua8r4KWahluIDdjcPpEVVhmFhomxu9dYa+tzKEfsL1RXPJB31LOqTkJOa6N+9ZMxRzKUlJXQPpQpjk9bg864uGDvnRagVGoHUEcWxIKzLW1My4OK0UUfeYqCXocQ/JpqsOoRXh8gSTxlRXkEy5N+c7Kch47OKG4Jm4FEmWmhM0pkWwt+Bs4GWj+pfS/RlqbNJVBozX/+a+4JgulfzHNjFww1xbDtwz6zw37cBwkvpx2Zrq+au5t9D+nDtpxbcNvQq/4j9vNRmRWmrhZrs1+7ZfcfXZz/O7j9yX3qquxrl8YyHiu4+MKgeel9fRKy5fzKNXKe6a9faDvqbPp2nG9xwFd69WPP9n8KlwPZww6/kvhr9J44dfyZ/XZTj6uHej1Pa12X0MJov/vzfFnqO1/79mWtN0kZSq2jPBhC1aP8ZVsv6Yrf8FjXYibNfJBH/dvBy5Ons9cfYd3pbZ1/8Yq8TNdl/3d1IgxWKSUIU7o58tF846EQ7g9WjRZLiigX6MTOwImxHRxWGMfSxc8TzGOp+Az+nP+KFfeWRws4Ny0IGEq9d39IpQymyY1ozzXtz067OHYT9QLXsH7dIcJ5WXNgu3KHzUN4fS+tdf8SUshkKaeMDv9Vy7I1kXywqGGIme8w9waAY0re3EDfwSE/WejQIO1+juEWqH9h31Zkc2gyzNJgz2t2S2G0nklIeeou2FqsYbXElv5ko3kpi34mXPl9FovvgnPovN+ZFzWgbD5M9fFMTYM84VrRPs7R7uA/dGpLTp2EEie5XfzoCOu0xWR9ieLaY9W24L7ukwEXKyjVQ6B1EugOQNxUtTExGL5dTYOzfqBJ6ABtwEqJ31qWZVq2Xhbl2A5MFLjWsYMDnHtIIVK0yK30Z3d7lOg/KOQsjkTkY6JEkWhKFlbEaMEK5LBJNG8xaEPg2sDCxAP7wt8Y3ZBvm+h5QSjhYMjbJ5WjadGn8uRA2mXowStpDoUOOjGJ7g3UadJ/ipOb6AM7uskh4dGpyx1DId6A++D0D53TvlOO7AB4AHcgOm6qsvKb4NEv3tRuXpagrsmYiS6OTO6im0IjeugHXtE/MSdGjQHYTdExaHZKwK1wmxBCH0NV/iXDim/cyuIDnX5Ylntz4s4aYVhJifWs+kRGlPxY1sJAoiChKiB3d50ryJvuieuwPlJaIifXOoGidRj7Qev7QV1vQwGclVYJWasELTp5MXfFasdbLSdZw0CEmwQ3ISo0w4imARvBSBESiV7JUUPEvGnEFVTNZxrSSuh4+mi1Yxyal1ZDFyPKCE14/6j/VBex7TjznZ3L+5EkORfhXpAnQmEHb2GHwyYvSJRhrg3QGg+dlugLQ8LbRn52WGyLFUPnBRcGpW/+6ebjyLB/ewzt0w9dazEn8LWtQByiXVTP5DZRBjoY777lRNvH24HRIjmweBMNx13QOOJ70tDrVUD6F/GrW+JTikcpRJW4trnam3IkqwOxGFdJKvfEvLgv47G0l6RBvwy0+bQt6b3oKFEWRWwedyGtVEHSgNrPrlSBLJLk78yFfKi+XGFMHsWQxjUOJu/9yxp4Y2Po07n0edRw7b3yxC6RFnRAXezHrJtIi/velORfLGSXZcHlwe24vz94OqR3YQcQ2+r612zTDw5wDavX8NJqB68e1S6fajx6qvP0ycqL0T+8lfJ+XvtrJ/cFvI/PtzdPYLv58ZM96vHukgaVL8JxZjxj+s9JIYrJLVDRvWo9CqfPyjuPD+DQS81eqnaHbjmHn4sR0qaqLZJYGjmxg1QFWrcIpwZpVqIJOyAIblEiR2eZrWNo1+Axpp88JOh6yGhsP3CuurUZLpOyj4coKeQl8AgDJvH16T0NcShR7j3Q43W9fMtcxQwRzLaYdOOknDCsqyhMq4+m7DWY9Oj+zn45Q2vU7F9j7I6HckKzoN8lfu/zH7R4g088Cu3DQjulPuhM23nnYBGuylGk/IbW74PH1rbyHL/lyXAmPX9/brV6+Ld8ZSZgdBQkkWphJxXtVBvgqcTLouIPzva7O3dHmHv17TansBGDnpuDiyI0jDr1C09KwA7+tf6SQrfPQB7x1vb+nILEv8m+Z6r/7N/nkx6rTTvDphRR7B3zsAPtgNe8q8eSNJGNfUXzlVGZwhxbd4a8dh45J9v6nYqNtM6iTJPjLL+r6icjHj7UYaxGRLIZK2+YF14d9a1TiOgBJwBTpPuT7liGRwFJ53hxxlGnnBlYWAAyNCVwsGCqk5jZ/W9zMHDH/FUjDnDtMdyVFv1oLwITB4eHByCFVXBSzPOD5UBwpGLNb2hPiQLeF3vDntcgmiqXKR+i0yUEoDKSJkcIJGV1tOVNRFB4OOAzO2CT3+mE/G0S8Dzs+ZCZPu0iwCfm8MkG7Dq3yIhkAkmPfWjTqeno1ZQ6PNqBSQRS+qZRvSaesLxZ3vjkkCgp7LCxAhJsWIMcVygeIsmIIPnRyu2xzJPDZpLJrUzNsoTEVxn2hk2KBsYmGCMlBfY2pXX+YeHLOQyYPQq8Urk/dnUEx2vWy70aa5EG5E5X3Pz3rMS/WN6mM01FdU8Ow4aVspyows7N1hkiYbp+N/txmw2x8/eXq8SASxsQaBhnc2n/q0o4YtoL8z16RYJ47v1y1bHrUCX194Rt6Bv7ufNw/+yD/Zbbs9zXojX4LcCkGajpB4bC+jUrK0R8Jzd1EBZz9naW/gYdb2md58v8/cF4TP3zKJPHsDigEzm9RepSlxPkJ709RysLxI5Vm7FfG7x/OaMiDIz6yl0KJNp+80GmaapfY+K+SKdTYHiIFURq0n5B02oOV3BuM19JPQ7Peb/tZeJIf43dLHbNUlR5TTcghQ3Tz+toYjNiww6jw7a87EPl7v6wJpVs21ncmu4mmhYnUbXdafRu0r+JwCa4Q6ASm47+jt6xL8pQ5WNZQ6aLZaJ8CrMQrVmyCyGLHemBZlH9PzxpmBMhErYKTzHEtEqY/id2AoCxCZBbrBAQN1dwQNhQUkEyCWFA/XCAx2nRqWG94iIRXNxa//HQlr1yWolrDA8D+gG66GgFi0AvUO68yEdNUaw5RNoJ38ajbogPWYGdL2yddqcM5Ef29tmYPzy3/9NjyStFv2gZCX8cMd40ScBnqBOgJ6jweLXq1/lcv1RvvqQhZshETl4r9qmtpGrT3YJGVnQICfAkqCxMO0Gd/lEt+Kt+DPxyFzUNob7VQFHTyiUeo+i6puXH+GVfkDD2xZEgJwdkLl24/Y4QpdoADJJQge9jL8CHcX7FRjI37pt4zklpJCXWM0O3rUsub0qXRKxXnEmfHtw2j7GPFwYZHDu6Vr7vuqr4ztIDvTeKBSfvAfFEUvVLo/Vz196ZHxfXgd0ZhUq8MjtidsXILnQiJmcMjuku1CSSInRBu1OqXfI9zfpTE5o7I9evYIpCBNo1nTCGjgq0E+ehpR87ykFkl9eogMCXkpM5yjuxCy32qNhoK4u9PhekZj2JD4lMRyjndBn/wDxmBKBUeoPUd+0BoZpl4DtP9gcM1bho4aGKRVe9RVhZBGD75tS7ORqWMkEgUNK8Q7YO0CHoJC3dTghoWuAkwt1gIjm52eJyIyH7Jq/ksxdgiQG2GpIeBLy5oYzCx/zbPtgPBorWfFJP7zUxRHvBrMlLVpkEn81tYbKnZLsKu/8SqxZtd/A/IfpUtcKRwJRgG6y/mJ0Vy8tkoggEowWeaAdNyNniKa5SNW4WdUUB0XO0AlvugvDvOno8ItYgJQcOpUfahekmIe+YgtQzlHTl/a7cXZpByi5V9pyY3FmZO2xRwYc4LVlDkhKPBi3AHzJnRMmjGQPDStfaFWn9YSShC0TWcb6F69kN8FSS7Ubl2XNnnvNRMuNF+XDuvBO4j7HPbPi+c+dZbZ1oBoFxBungmkbTZhY7G3jHVLTqmR3fYx6ZGVG/AErylpiht1rSTuirZOJ8sp0cy6S2IPY9xPqB1JMoHZYmAbgBKobqkENOifHJAqqLKbP1oyJBmtxd4sz1jIZ4vY66898EzPFo/1vkN851K3hWrpzwgFySO6f09XopZHreWoVXn+P2JimbvEf2AbvW0F4tmN9BoCjVu59+on3LGKQ94qgF/wUFxe7yqCi+m+Dxd5i4btSJHVM+Hjjm+vT9i3fqFWI6N490j1ECEiNvZwslmO0DV273Nnbh2xy3GdFaX9mI62x2eaznBSGhYfchP0CpZmT0Hkxv9vhSG6gBWrLEGR/qfJ+QRjhriUADFnEvkltqimViO51CsnCH/ld8+KOndByxMtIpaT2Ua9fgm+zS753q65FfEEygkKgpBOMn01pbKKghNOC0SbSeenavSyU9W3xq7pt8PWOLZXEC+AE1jmnAVTOE6wIq8N6rcSSOKzrSzWpKO1H8NPpcSLnYF86AzQgWCZcMLJp5SEU54bLpAr5BidKODCQFpOtpo6/kSaMTgRjrxlFfzx5arSMFMyaWnGzcIbNiJhC9qqHGFomHHulGP7owQJFDrtT2xSe7NHtWeNx6pxO9FsHsGlHyIodBnSZQxmcmNfJFadweB55iqxf6EhXj0D4JMIpygQcew3foxFGfsKtwCGmRwx8IPl5jV+PZ1Xb4T8GfSmhYfQfyuKqq8MolcSzEEG1RkKpMDIBkwhnKX6lekxVjYO2geP329JESXk0ltaY8SOfNs+YZO3vu8uXppNbQh1KigsvekBxIPscQMydkrS3YqQ48IhdI0EDoNXjb+r15kqy3jdbdblcI87rf7HRzsFJRbxstkekqidJnVjsm1kcy+cpzm20CSVVR9OzsEdxPzMHz6r85cM3PwhqO6aGAQs25gYRr4hlhFHlxI/SYst9uoRL9+HyN6QUlL1jeKvdi7wxVsoV8hbKkD5AZnhS8DW0woS3IGGM7AkuTnZ942o3tJUlZm0m58Zy07/JAYgb64P/bPdeZtnZH2YwQXkojnb0G84ExCKVDxQDmfcrENkyQgps4nlOUeDaOwFQaRKBiPqMOkXMhZNmlHq1FGrz2igKAan2jUHvFRAkWPRsPxAGe4kakWgfL3CfpF14+ADKB4m5RlXInp563Cgn4hJrC2nbNqw1dbTKovl5BICFJ6SORhZxK8tEivCInQLQD0lkuuxyOrmsKAkvtnHby7iHSWr35U/4EXfT3JotBPzBzrrE2FaM3Gh7NQhKFIzfsxc9vK0fvyc7poX/YPyqu8JUHSy0L0ng25QSzeLNOJivytpw64SkGZIMNjolFp8O3Fk64OE9rIFjpnS21diJcl8XZos42OIg6dRcITccy7MZbaMn8RGna1PplU6g575Yu1fpuXynVlBZLyGxtI5PcQMZN1Osicz2FH29lhZ94QoVuHtKxSZ29Uik6rIBvx5CORJo7PKmV847oru8JdpkjFnwKnoWsCAa2yu4FmnD0xwyok3vh2ubOzprCVeCaSgO2UaC5a9H133XgVB7XDvey6yz9cZ1JpXSmqLwomcY6EwXa9rPOqcTy7PxiHUibtn2roythD0hH0CXoUBUTZm1oxd4siWnnUpXF9LjVQgejxNZxocz5rtenGc8s1lkk2CEuOwFeQtxWNOwjip1nTo9+TBzCw9dYPfR/o5IPKCvZIeUhgpg6vZjVw0EG2IDHtUpUmZrW20uVULNsbCje7ActA+4FpzUtyjuantrKxdMawT53MchOD487pKVssL0kAxD+93yd/b1wP5dZ6vYJJJE0gFkgVJr+bVCPK5skRBTcIcSs6TLBHD7GVn+M2ddsAlEhdDklxx9wEvMLDsFDkV0sbmEpdrPWyH1wO7bscZTt7RXUWqbJZ2DSxP2icM3eYUgZsutybi31ooiXQfBd3YICFqootgLRvgWNZo3XOFFTdFbH5Vyjt/Lle/O0azver0R1kC+s2lC2F5uv94WBl9itR6+ZfSmqzCKYK+GYOaHYuCKf/35wesCc5iMb6U7zg96T7Ob+BOvuuUh8SVx/ZgAWXLUx4ku1xcsGxi0m3UcHbdaLqtx2/w2lD7VprV5ykDHb7WU4ZU+jkUuEHrEicS9iHiwoA4LxeSXV7uWQH4H7bYfHckNmef4yYVL1poocWCT3y9rrGSmu84t0quVEC8Ubd6mj+ieQC2CsUjMcG6TumjpX5rSTHzvVrioMi/8GSx845rrWfXPY8T/2stC9Yjy5UYa3dXD3fhF5Y5rl+2yA2Ly8rr+1sMXmR8nNC6Br/1SVk/9WMSXjZCUdCj8kedvlT+nO3DvQY7+jqGZV9J0Uxu5ItlUUTvbwDpmfv3noOrdCLYdtCIAFU/E6LUPbe++38U19sI50j3n6dRbA+qfE4VPRbhGlcftvirUjP/+8TJfHNxTaPlgMrrX9HQ1XnTymGY83qPH1b2jlfkIz0wQX7GQnx5XmyEoI5HKcajvTvOGOe/7v0jEq7k1QHOq/62eYd8fAeFqJlVoJthGpNunCZ1CecBOX5Qu8V+5dfgwhY72TuCYj/B/gw8s+yRm67cscfYxa9nz/txy+R7StYL/lLgmfCYY/bzyWfRwL2c/VDr/CIFQdRdiPynUJne59hbkrKkJ/ZyHxN9CTiZ8Wyg7OHEp2huYaeQ9iuZ+G2lB731/ZTwrdB9uQXaUCUp4AFtVKF274xJvusUQQ2uZ/zFWVwN7b/B3jTrfwXr+JYTTTVlwFn5g68cefztTyvuVDvY/bbkh1neTaOZH/ap5xlBT3953+5saJ/mL7vS72zWqokCzb6E9bd+yTrrIUHi4V4QBlJjwUe5g5aytfaC8q3D5Odtt3jkiHU2KAnzlcxDqI+95yeEpUukIVFZdSyC4XETLEW9vGjznNvYeKhFzSIRbdNGeAEOHSHmJLv9hA68ne3gHY/OrovN8+2LMLdbNY7M+Xki67j8wmiaPRvQ3iC3RkdTYK5BfAhyq54aRfnrCnVOFSfJRr2VekhPeAnq1rZUrJt/bM9LFIokYoK1AeFOjz/Rh2zXdELjkr3MrMCst0BEUnc5hLRHFmup2z/U9nBNmo5jZz7ET3scJdsqQScTfyIgvP+YYNL9c7R5EmpIT7Ia67XgT+lG98Zu494pdSBXCTbX0nIgi4rTS+a50dvGr93WpNXApxxE7G7GLIvfwZeAnT2OSmh29IpB848PozZ+268176Subt3w92XH1CuLsYMA02HRqIfsb/ewCnueLAzh9sO2wojH7t0EZcbmTOjkK0hq43ve35eWjzoOvIm7Hn7sRX09Wc5xCr5jb+Xs09jPpK6QvGLf4TgCfU1BPjYOPZb9+YN1/J0rd8+R8xdulE+U74e709F6A9Rs/Q4YW+0s22YUO4xufDbKcPUK3ojxuKXJNmHop1uHKDQ7aHRqzLLdkxnXIwPZXucQu2dDaNXt1YKSB9pcaRzG0Ynx4o8qtkYi1EmeeGL+7vc+iow0eaHYj6i0177duzOOITZfzX7DjYcUgoRPr7Rpnf5+gMajQbu4bpNah6jf6+drSl1gQOMn7rIc3RD85h/ShUoXXzI7Wpuy4nVPTvkqIAQgq7U8DnHQi/wy2qk7BqI/L3UHsaasTEQvv2hx2WKyRV9N9yUpRN73t17Y93+Kybfy/SbxdnYtswTutB+AyhGA9XO0fJbs6xnHTtqIuAEIDNne0GfASHvzDZqVcpMiq2C1ISdl6o7IY6k19kxdHvu7j0Nk7kb1GXleBjuG/xbGJmxn8ng/URl/NfazT+pyBOXDG8wBP+30g62uTAFF52y7NavVBbBtlw4Od4K3suvhiSGwPesBBT+9Z5IXgsqKI3TtQdMAayYMBDgimDJYRXWxgOb4VCsxnlP0Kq6CH8T+IUI477/65XuQzj3pj7HA3nvHwG+67sJ7vXuf1Pz3V6gMLP6TPrCsNTz+cDN7gccHAnLD0nX4ilwrrCag00YhJ760d3C1u9jPShtbG2EX8QCikNss+02AA5h3QNiM+eB3sE6AWGhX3/bLbm5ZkfVwyzYKu7Vt5elpt9etD8kDM+egIrw3MeBl/c+gTsMrh9nQFm9rx8Z/D5RTx1e/HJTyeh9/E9UFTveXB20//5I3LAstz72k8n9N7/b2FZlBShe+lJt6oqaXL28VPIguQFctPhVKjE6W6n1rxDdEH23HXRyek5l9B76nly5LQjnRieAuErElMQK+0kH1RoGiqsdOh2XBCkJeRNZacp0/xyPcMzWMyznfZn5L1Ge37+xVgrHwpQHCYQBAzt6c7d4o4O63+z3ftnTa9e8vQ2H490uobEHA7sDFKUSBJpDLzEUfkwJXnvTP7gUtrvnJMTcm7D3lIE9kz7JhxHO9p54i2LPDSxTbzgT+/7PfRYRfeND2cIFVLqJEJCW7OJTCapvcfaiVT/TX47TIFqas2N7hVymYclAwuKxHXCxLon3uYPN+iZnXs+fH8BQ6mr384AujbOan0MYJ56bXKidtVG9CI1M2CdDDQ0Mj++HDlwtqTqUGHwSP7KckmX9ScRWLJAI3R3eqt8Fgl90Xv2trv9pjRF2gFw7gQ7a2WR8sEkC5LdAF2eHV7X4MHNdqd4itWv2nrfTOascuGcNilCR5wso6kfanXd5YMhul17JBb9JYs3gWE/UfPyaUEVNSEbs0t+NF2XZ5oM398dQHLpxhvk5QhoqPW19WEgJkINFXb1ToTHip1RW/4u0jDmox72/eFf1jFtWZskQmwVJGmEnfK7Yzuhdds6z1yaaxVQvzQG7eBq68j1xRyyJPu9+mMjOziHYnT7O5pk7KNwgJm3rRVsbJ7L19zadj0i3ssGZ228KHl3bS9SyNWMCawLL42j2t/5Gv1nJmDjxbWC6JM9syy1fs9U6WuEn7UK8PiMSwMDuJDNa63EjoesJQR9OBLGDpZAer6eVsXwWUHbavLCa2/cM8nLhNkL42xubv9zZ+D74+1Gzske+OZnA4vA80UA1q2/W48lgGcnnGanRR6cvfV8q6Kk/Z0oWh5+Y8Af4rXb4ISWGqRSX2R7iMgbF8Dn5I4ynNXL+T3RTb2p+GiDYL7mnk3yQtJxbb7S0kHcyz69YbvIMv0BhzSODZAcHDx0JkgqyH+kh0XRp1/mPnfuRFw+uHTzXBC79cn1KmfHlw0vQ/UXWdP1lfxMvqSEtpJrWO7rfB3YG3VgZy+RBX9+n3+6iOEMJ89whbMdPOgXbwcm3fZmpeZW8PHGnRACjSw5R4j8a09dox1UAnELHYDpbex7sA9Q1HYRDg6C5fm6ZopJ7xk9/w4v/oVhFiAdMZKBsE9QvPtgFr9+1fm4QTYvLZbE/R3LdsIXG17e865QaP/wjk2bYJwpnvYeTMsfNfkb07UdR5Hu2qFpQzUtHB+aeCAFxCGHYQ1a5LpfJMAL3z0UVsZvGPwWO0i067ysb8ChKsr4eNhYLZ5weC2+J//n9Li/29oGRlgGcamjY4S7Nq5G2nmWm+COlRGkW9v34SsKphs2/3ZGjh7nLPvJDLPRfL276I/03xC3j2Ryiiko2aGyx6asYZMjZ8PKyRYF2uRqJPnoCYBtIOFWqPhnggXyTyFreCiUUKNbm6sQ9qyXvNCwB7L7oZkPQdQNGNjkQ6a3P7IHhCMp6XKnBWjuP+NoewVY15qcwSdvohX3IPff17W8A/ZVYHo9twyQvaF20iD1nNNwvYR26LjB4T81il05hW8EoYe3sz0vs3gF9ycFRPp8IxA2DzsJZn5FDMADVy6JwxA8Un/owMDIBrIQvz9ZXbQs18VxHxCMlDvat0WlbOyJIJ4vxmd44mJXkcf/Eq9z1IOvMGSai2mNk5lvYbR+d4Mv8IECoJWFm6XDpGmLRQYJv+AKeUQtX6swLKS1MQ+tOB3jzvDXxxs6SXURVHrXGC7IH8HBsLLsKrcOKKbBsOJcRihFY/rzbQ+G4thease3iPb6tQ3BoDQ4JZu/nf4Z3//9acbiXrboWPoJfa+xKEKSSx3IEv6bY4q94kKBTBjxBxEaE0lAYwWkwobiYpfbhlv+4D2WHQQFUEGs8L20nnSM4GW5K8JmuQewasko3DiQprIxmew5FN7tEVMqSRf3SWoYmiz3t0BSd7P7SQNHjcevAD9vL3gNQaLG0PdDz7tWACnqVeg1GChhfDKdiAkjeRVOYAkyX4Zl4lj74L1/AXnUqCV+U8LrXx66GZAUuJ40M748pz36/mlWiQtezZ/W8hzIIkyJEz1JDR0ONKrKAbmd49ZcifK9a99Ej+2nqSMda7TcZRd1okzKGTmMYzBhcm5QGygraiWtLOdpvfXIPrzZlCoJGpkdYQ/dSqzlKFUG1LOUqi6jeqj2lWgeMF/6n5700zn1JnXG/jJBnwMkAzRAi58jLP96CB390f1Ou1uXHhB45O0Nf9cnrmJh2k6eqBQAubNvcGg9ZzMiU/qnfogGdAcQJKyPQmLEfBUktbGAB22q6YMZIhIC95QHv4+17yuBLWoMIb1JmEJOJBO1oC7sEPZOcBXZupHoa10z1lg9SIR7skGZP49angkEkksaW5ErOCtxiO7N38HM/AFN2ahoVSNw4S/IeI5ghw7U1zJXsKRiJTQL7RmoD7YJTTjgTp9cW1VIWF0iHsp3jrA9e4Cyl/421r3QvTQdhn5OeuacYnolCUt1eVF/iGshE7g/v3Zt6O73ixslqn2ogktWYx8fyZxRZ0OqTZb47fjXw67L4Rb7bAR7FJrCAAfAMkyMVnKK2ypg4GTx7i21DjXjX6KQbop8HV3+VTkn5sdmyeyVw+ISWKjWWmLtaw0GTCDehbh1BJmfKRr9vt79tm8xxq7i/yQjteO/PAFOpjRpAclm59ie4lfOXs6T1F2GWCBC4KqNepYTcGYPcIvelVjcydmUuULcbu5ZX8IA0nS/fCoVzQ7Jx1Vzi7xpXzOIF5CIyGijMxIcjzLjy5bzyXfMo1NiCeqWa5bSDPCZ78dLtgYISnydjVD5ppdGguK5rgiDKKwRU9qMmYlRPi/Y/e8kX4gulKf52+lC5PNcRUvDa11rRA+edzhHKzzIvb03gOU4BG7lbnRqnnpHVTdYPD/vzfNALFGHY0747cCXtd22FqevTctFSK5ywUKzfOkocnpfgP7MrWLU7+HuzzkzvCs7wSp2wD0buz4DStZeEfBh5isMbslZGfspIOQBS0HQ/hI1smVvQDJb1lOeeXkGPSyPm7k8GpTVimdFSQqVxWRkXV9zkD5zPH2ffy2i0AW2iEKnIrjJwnJF1dsUOzUZTmW4WjU7iMdAZBmTf1zD5Pe5TZhA5DqZCJsqPJojRYoKZBwtuW8QHy6nwXiXDPCwmriX0SLeF+EiMCfkl0+S8Z0OHgxIfodkYjq+75hJm7DUIxetD83IlbbRbwm6uh8EIl3SYWBNQYVu9PRAIO9Ms02+Pw/2oidSl1/3vMaYH4kug1R8aAYDOomqqKTQNKYwQH+YMA0UGecHDVLNpA4Yb11t7vP5gQkUE0S3uhOnC4DiDRjx1S3s8dYxQthGGjIJ8KDTWAi/qdGzCxMuEVhK28XhRP3aWqG4ruKrAPbZTL/sM0Wu4FUg8KzBVSERsgMVV4HthVO7M7fCUqqecre0fffERpjl3TTFuAumSOyhKVb7Werf+lug7kUhWoxksvYpEmXlbRGmkd3+e+dqaG0L3N+KjA8nqSILulR3oObXJo3qfWrWnEMT4PVtTrcNoVwCeYwWeIQ7mjx5wLFxvE2TcjXz+iZ3Q9JM5vuWZGvpHyXjTfOdTzdsbvy83qrhUV7dqJ3/w+KzuTn++TZLQ9CRQn84ms3xhT31hrzNbbYf9v+KH6yWncrNbtRv+F3LLGt86XbhuasvGDO2NN+hFcrt0/st1NoL6ZXOi+W1UxCbTrrd/oTioYTSLNZR22EoSEwXlI9XaHxjA4nNn4wuANI4v9fL3sArqm5P6enxFsvwbZxhRxDvGujdbXmraSxwhlf29HBLTBhgNY3CI+Ullt9I41VwQ19S6r+bn8vclNJhTnH8sHRLs3ucqEq/MHPm7kT32nyN9DO1KjhjVsZvRmP1bKFgAZGqizDV9LIDPZ+QKUJYs70Sm5x2iyaiFSKKOmhnO/L3KFtYv4sYU7AL+Mi4dkLJjNVBPv7tmNeleyInyStj4nKm9OaTjjZeWsXNC5eNPQSAwZBKmJHSkHacMDOyfGaSbwWZMwX8DuvGg6jOJdPMIPCmgroQ/+wAqQXoQmJwJpD7gjHVgDY8PrUDy5W1MVSu5iJXnub9TxW5yN0YxVR81r6wly+m6NH5hmSulQJzUJ9OLCl9LFVNx6q4ggpkvBB7Qu9cvOT0XCKIb9UhenM/njfofggTJqjCQSbj2W2ujo8m0hHNDkApWiro7kukKCFbZAqCImAdlkcjTWVTFByZdMCfxI/ZZ3EO58LsSnlHuJ0e7ZCkmPD1/nbb++KvNsxmhiBozdLvXHLBQxGK5Y9WsE41eXximQ/iGDZrLNpLLFXjJWL4oCtASMjGtWl4NouAo7Hscv9EZDNtqBH2PM76BTStxOHEF3DMpEcndlfH6lUSkA/guZwhu5I/Ig6+FF/RxhxG3E7NLy510SG9E/hfQUo4puV1ae0BVTV7mb8TkZpYotgyC9JXx/+xa2jFDdLltUk+secNAZvjtrV/z2+ak6+vnQrivQ/0pWY/uYxXl8FIGceYuQ/A7JBjjCHbzyN097CMpDsbJQfXLKSZckOS7A3EuxiTKYCoquguKaCy1javfE02qW3auA8zUaZ0ViyeybyEA+SQoxPqGnDzmCCgVsyhvFrgqytyzjAWbsGwlHu0X1SyIJGaPQwUOHbTCYXGds4aMhh2VVei4Yq8LZ+ZZlXOWtYw6oFYYVjWoDyP0co7s59cDI0j6ghJDjZ0j2ipHljp1PbguiXCmCsLGU0usJ41liPuTsJiClbKGjNTjpkJ4TEFQ6Bog/wvstHBX8ATsl9kJW6m/sl9RChdqeIhjrQ6ggof1S28Jwcmob+ytL23IbzzOnUqIiVuPBP9pMpt6/aHnNOvg1aQlUKQjYqdVycxM/OFXt+3AOCdRjK9IbsFrZp2Cc8eTXw1KN1XgYJ5zFEN5LWfisepE2NODm4IiWgjEjVAhqR0NrRAIxFZietR5KDItQCG0nyCCNX50vdATAUJABzeBhLUrnE21+u4U9TjFizzTKYZv6DYS+dnA9ifHOin2em2jChYsDyetaUgd0Yh/CV01tp3ovajJSNlJR26bkYQKyR5OW1HBMCdmnFvG8Au26USVNYOK1A5TtORzSl/k75Z8IEA8xQO2cp3u2tKo76/2I95u/2puYr6irZAa8QBqawZ6m4z+/FaDYbNdNHACo3S7MR3gH0nye/Hc77hO9CJTwLlaY7R6DKa5NkvgyybLYuiD0aR1Vq1Obiez2MPVroeZGUWpnhUWwP9cHN5w1k3A/HDY3/X6Og4D9RBIATtovIpoN3iq1lLyZ//PL+SBmKL/L8di7IzlUpbpQnU8ypbyCLSN8i3u0jw/gg1v+cC0P0epK29YhNul7jfO5JNNZD25dzsaqTd/dHNJiV3tPQMPsQw3Xk8UVTaA/XIfmF0uwqnXFSjDWpvp5KEzmwmKuzxAQLWjp6jE1lM05aIGgz2/X5dTg7hY6dHmXzV+MFb8dT/65L7aQopxYeCxUyr2a7rM6Mbk7R+OasOOXTiYmkwYYdrQelWr8S/sjUhXu9mI+/0gZSf3ZDveFJU95qR/njD3Adhwewnt+vqLjzA2nK1kRZ8XYawoP7MgYzctP7MQMZmmqtc9u+G8fe6H4NkXwBli2+S42tXQ5ZZFCGtz+V/pIYtjKoLnCYAqRp9zy5pHWWNTCESiPjo/ffkZgYlA+FlvY7VeEKp1Hie2mEatLD7BdfRC5gP4bcxdF3MQUdSaRqSZ+BDXMagraTM4211JmpquF2enjh5AAoo/excEG8g46Gicym4rXkp8FskAFNlAmgz+meKcqBPtKICL+/mqw4cxoMyhbvU6omd74WDXUGQZ9cecVLgkNl5Ax8f/F83TqMDmj4cK/NTbeHBO7DuCQWXepeviefXp5jG6tFyO9rQw2LvBha5oi60o7f3YePPflb/MbX4WG3q/YEjNr49v7ctvMfdZWkTsREuPOvvU7/Da92kbf3cczwz8QRt9oP0CtT9lHX/rOzk3V3G0sQeNI7vS7k8D8SUEMFYkZLI4AsIW6I78py+celbs78xZw1K4hjgsjv09dy747vr6y0QWbNMwuA2BCkuntGXXTE8qviTgdUBd60gAn/QNXAMveOVpTT7AoiDqEA/1sUl3LxIDAng0qhDg1A4A4ntQSz/pwwKRdWMlbaMrwZK/932IdISH4GBTBut2VCngMDraiPv+u8jZJodk8J2ID7Ne3tj7dF8bQ9618E6BjR0nfcwLCL18JzC2q2HKdVAOAWi4eX+reJ6K9rCkWNKOiO/bOb2ITPbNdD8tiCIx4zTkyWHiEbmtQTNh1/dpG97gjaVrpr59GB6IyWA5KGKxBijKUW3tIgbrgu3ZrYj6b+t6Xx1SUL2MQc7r0vUw11Y9X2WkWWDiY/SXvOamt8KiSRG82SqFhQFuGHHhEvNKLuwbuvzPTFuIu28t7dPRZSsUgutXzzPBn9yPJybCR5WkNlOrS+XqBu1/LlXfAsjS3bBQjDtf3Cyq0ByIbzqm/kyU7jTTJecng+tpudxm3CKXfDXqYcSiFfV5VqsRFHNxuWcatNkIbDESITVd9oGGoNLQTVUpAdtHl+Jxx1B0T8bJ7bmvM+XuVYNGg4zS0eHsgSd8siYX8Ho+oiBzxmPtTM+imb/No8asS6ZbaOdNfugf59KW2bh/mEgl3kwZcm8LXqqVG+BPmjO9qIS3ggCbzST4dS7wfU25eX66sP9g3ajRXvTuOP9sSTEcorbbM3nKo7htiLdRTy97P+bZ9V28XSpaUQ8cUWhJ0qDi6dIi3yZPo5C3+X83MsDwORO4hmQ2st1/NZlFTprZBt9AYU1mGKXAyKE9HwdqJcnsBGGertCWa295/ss74u0J2HdJngYJGk97UIi8gX8p4N4Swi9kI/cCJ5L8s7oCffBjnOcVl8+85fnXiJsmz4ab5oJcVDWc8OyADWAoEeIhwY6GvIUSfndH5TOC3PYMbChzBYbKBXYkmoSupGSzlvi6sPlPS2NsEAveFsJIjAOsQOwsRY8xBM9pXtRjRT+Zx9M6GHx/AkcH3sbvKhyyKNS4Y0IBvyBBNQ4oqjw/Vb7XkcTRWzJURtJyi4Pv20CdmC5BaauqfQz7kwlM+bEcJrT6HiMs7JyjHZXcsAoWyJHiqHXi4Wl8GZY/U7xDKOEzauMNq3i96vQ3iLjJZArwGkMTGnQSIZpmTThFYa/24FVO8dL92SfQJXBmBbLBgMFIVTS8iVUcA59j8IIOOJy/FvOUGUt7jHYUZFLPn3KR5WiB1SDn1ENQWv7cdcF5TklRlDn1ikuEdKkTMk/PXZleiTmpm7GCfmfLjBi/4jJ3wNcVnl8CHAaORQJYeBiUvA4hUWOm482I6IywXf7eisWadHAhZrn3AWPdlQ0Uup7TPcIbuiuSc5P3TFg81se9fVzeGP655Q11mMVnEOkK64l4Hi+0O+LwnHosXkFhf3VmyylPED+U8PaJ1qRmVFBeDk7/yR2iPTl+Rg2xn8qFCEpnIqrX5bH93LPY1Htz49mtV8XPE/Pmzo63gT2IjFB88jcggc8EYUmEBQ8iUjC04cyni0ub7GfzLSSfHNvhRk26Pssrz1e3Waouss8Lt0O1IfulbPKSxbt7HpL0Z98LxHxuDFcI0r2IIO9fO2Csm7fr4VC/JyVITs3SXkAAOGMHygnjmZgCj21S9a0pcDDDGKTGWqDZs0eC/2vFqRidAi6+qoshttsf8G67xZSdxJM3Aoz+77uHidXOELBtijpbIMavzkpFyPoFOI0YEwPkQJxALavYKECswMmprhSbl+FLD0i7/T8WAHfzL31m6Izu4hE+JK8q82jxK+0rWJpc2MyjpJ3hRd4hXWN/ydsomQEBJIAs883KRumCECIAhrVPQ/uUaochWyeGJIE52G4I4ZD0+zGojY5gL3p+dDM7/Da0BRquGCEEaxVDJaqli34z7koIXjejHeD6+yLnsG+L0lnR37N0QoRPqXMFJzsEKIkgf2z0DORNYAf0G3TOAVZLylIJGpARloMCGPbMFuBDUEA31CPA4hsP67vHpisDwvyd2QUFrI0JFwVyYNjpUYzTvHkyaUXwGHywE8PajxuMf4AWENjyzgxS7vuPfDOHZ6yuJNtzHan2620KNRwZMBJRZVLktHInYLc2CWcxueiiMDuQtZAn5v5HWU8ZUm+ag1ymQS9wjhYhyKhRnX+ti53Jq3YrLsD4xl2Ds+OZYxfY7Fqy6o6bc9dqHb6rj++hJNK83gmD2yTKP0SXiu9Ez6agcNbfawmKDAFxyw1MpsjLQo5pe6oizmkDEreMsLLMdU9ai7aCCofpSxD7yBXiITroRHdp1LDMH/nP3rE6jXz2RyCkRas402Z/qx4uV/MR9fjyUeXwagiJ4nseiztsfwi8MIuKJtQu8VR1xK9N7hzqKnItMieymCzZbvfkbo32yUSuo/LPl6nL4Ag9K4UHVM0dmjfS1qgidk2vCwXCUWnBj77BC6cVv8fU7YIT6ghIXbRPscSpctUeAH5e1Bdj5CI56RxJetsn38RVun2oiDQmB/DzijrvBcU4cBnfK1jUoZVstazerpumWs2uE3oj9JLakM/5rblajT7yO48EEehuLvYg/a476fr4yb+ldabwcB9z3YwT4UUxqIoguKPfpAqcB/fejTyOi/0EBVzgx2sSJZ0NIHaKmXnjmLZ/bFfvs2ab3jbt1dUuw1ndTyAgdRNtFnWImynxFCrO3AO5uIl35GFA2cN63HercP0+mr6xNkyTEugd04jtyAZaxwnd/gzXnPJVps0JGheOYyiKuuXXyCZPCwWtLzzHXPtgeJw5iF+GiobH4tZ0Y4FBZgDElA0wwGOL424XXUTk2eMXdORnJvCO/FHfoJq76lSPNhVdZBv8XDiwEUhdG2UJ+lw7yXIbJkw7Bu8CSf3d+ikseF8SpeARYwKlRl1ra+KGFAUVEL3+V0csq/Md8Cz4FIgbQN8poz+XdOHkh9zbs2m4gFnD1M3a0zmY7Sm08C/pH56HCGr00Ti+tSmi1Q+bWu0JS5Rya9KXSkcSb43FprXWiibfbtgOOjCXsE291+R7Z3Oqg0Afu0zWWAmNVEErz50jDJx0aafOVwof/AkhyEZeBnMKI5BKLM0s2JwnYrbzqY8xtsoNI15xHFSXkuRgrJN5k2GhiCKBicaWMvYNZ6MDaeatnTVdHMY+M77dJ1guUtXIVTmBKY/dHg8B1o0Fc4/Sk4F1hUssC9tjyAuufzQdsL90eMgGAQF8nQAZd1wpVVsNV1Gw1pVrsCs8Da7TNj7LKrrHiRDvYlCT1Zk/YMSoDreHqarWme19gEkHRC5bZGt0s5dAw8s23qA9dUmK23JULP//tOuE2AXoOel6iLtlHtSlsIIdTZZ/4QgW6rnRAu8CB7ogCD1wf94VWbpeLinCX2WB3350aTWBA0k+RC5DFNEBkxIGo/5J0C231Hu99vTqwTeXG+U8P6mXDtmq/lWInwd9PGiSMhvq3FYPMArDTtPtqs95kVOjo60TGvMH/N9gM5vHgpX7jT2D6og0y/DGFONuXAOZMJV5dc7kRGR7saXfPAXLoYC+P/Z0TflPsIPbRFVsxmzsl1WMm9ncHP8WxbRbytyad752hCCYQ8z3xfgn1mTV+7xVfrqtzu/Ek1e2CmmMRYnrHTtaIPsUV6IQJ8KleLzsVBoB/lD+88tnoJ/5XN0/UF/vWQWV06dyCOhDKYxQ56XwYQAiyiYjSQCKjjoYkdNG3qU1XEF1GqIf93M6gOF92nwbc5LnO5AqlLMJSb5BnOX7Y2fFy1QKEB6F4qiiJnry9n9ytJhxI20s/C6Yha+g/dgpKYtaREnSHYCKLQFDirssYcqrqdOADWMLtupgxAMdxm4cKkG1CQgbZ/n1LlYt9+8M8a3nAN7PSMplMEcSMdW3CJ5LRiqsfEpbiEXZ0Ttuk1x1O/F3wrfWNok2ZxDjpjvCLLg9hoXtS43tFn8NwXlIg1289JkBrfATdbgeiKMRN/ZLo4k9cOXydI0RnuyWZ8ZG1dXXLcA0pLjBr9KIT945PGlMTboucmZQi4yceKq138WnLJsp5lGbE4nsEkV6xL5JpMzpG9l3DxjEJLzUgyjPyjKHxSivk7zdrmbh/B8tfc38jHk4pHEZVndLS6pkoSZ6D3U+kxThYOtbLnS1rzQbNBKlrG8h7pamkzxJs7otlG7h6fZG1kIk24v0YJ2g7vU5VuCLN/MRoO++liKH3fjToUQ580kFp51rmy+CXSu+SzckAb3QCfsT2x2JGGPRMThr1Eq34khxta9xbRIgz+SezozvkmNpLsdVlR5+o9bbz04Mt2psJQkkkKDyH9WEbX2XS4lAg8pg4JZkIB8fTk5PDKTtSrnmmmWJWpSnaj0Xr4n0p9JYrBAgm/MMQ/BkNHZMlBAf4c5vPpcew4oFvHk92ZJasSAmXgyuZBbUts1oHzbWXZRczqIxplu27WiqFQ16OclqsrrBTG9sjwYaNQ+kiFz7S9N/SLrxdhVb5rtU6l01CIPcaXWXMlZFWMasEIcw+5wDbuzxHxf2KG6U3ZJzMoFqY+TnUQaehuvvqY6gT0NTPZlAAdARRvwLVtpoSc7DDKbTY1SV2IIyj3h3DvDA5mRdTDCvTBnq8RLLZrkIhF46OcQEbplpFVNiS2qSPLBRQQkNYEFFUcsFmGQ+C9pYnG0heOuX7M43CnQ5PxXtZEw7uLa431oq0mlKwilotmmZGZYhgLasSPeSJvQPSD78qEqHAbJBbUHQQqNUclY74M6LrdOKrc+HZUsKT7M3YyFxZIvDn2r+WmRPN+2MiHbm/m2GQPxeueyDxsFZRTjtJk0qXdusXsiOqdXUEc/q+LKQMMFmadgLb0l+4fcdkkKwxITV7kzkLQCDBnF6bCxraiHs6lvs7e7IJOv3RVxpx2X4jW/hgcfoKae8aa+KwEJbaWCufdtkyqo1MlzjSHtOD4c0fE26GgCwiGSxIhwZ7qVRAyfOjoXNXb4NsMtfyho6ZAODbAOIaY0BWrJShmla1feDQ29G8bHXsMozHvmHjGXlMLHha9hl+mFYYBl4bJqkxGS0rtOf5biI6uYx2pey1dhKhhHithV+0ZZtAQy9++o6fAIoCTDqJ/5v01nkaxyny3nCnGa3JT/hTTfZeykbkLwZglcr3ht1SIBxq9Bcap9gp0/STnb4540MKz5lemFGjD+oOxSmmsN57YnzGRB70s5hI00kVv4lgf4d3ZIRDybaCU4045Uus6l61oGqJ6zDGYWOJ1NceLENXMCIWg9dcuwgITGSdjInM85tvS7haHxsyy4g6Sm1p8DcLdEQsEpwWHbo/ssPa2ndtKDSCqcnR9isCfmcgHi48LkvarTNO/rQf1jwL7FZbPupfe977NcWv9btd+WfYZF2te856rN89f4aMhf2A56l3J7HetRJFApT/9i0+X40ihmsuWhg7+gcR9evkdXyioiDoiEljy4ep7mfQXBthdxbUxk2UNV+rvmtVP5vEEF8Znm8N9Z3KfYICKu+BjNVMoc71atgTKCH/RRsbeVluXOEjyuZWeXLPtE+OvxuvnvLsd72wpeoEKOeEqgKrFwok/P4DbSMPDaHafiFFHax0hGFfpKOu9AWGlek8YmhOsE2qSTXSTsh062ELEbEpLdLWEyVEx5FVD89cyM5+14PuPitD1lwFuBXWUQ8AiyfdIZz7kLGivwEVMZHDgIS0Q1UcxQEDQ8vN5CW9yCa1xIlgWlpWY6pfKMTRM2yR0rOyvigSRpRHT0JXrT4LDtLBMl9oeca1WrDiWn49pX4eVts1TlDu5VV0VWxk2rPKI45fRKY/WlTtF+XqLIgsngFEvSb1DQsEiTCcuBLMcKBDVC7aKY8kNwV3BmO8oJUZslCXGlfWWBVwt13WwvO1lF8aidG79bWbcqtfOCMeZIsfsZloZNj2zjZialnvi3QRqAPi6kdAKo9zQsrQB864H4Yi4jR6zxQgUV6mMSv7ODCbVZA0w31GFIJJGuwhiffnuy45t8sYCKAFjokNZW+7A/etBRUPmRSBcteWeJWSuTr8Tnzxyl75VVF0A8jiPqqmw29gnnx6cdPAb++PRpp8T554ulIgmoFRI7MEBOBu0E54WZ4y4leO52uemp+yVEwxn+JHSdGL0ztfZkiGJVmpBYSufL/B3ksD1uwDN5CnUnytx299eL7UotYJ2kCTfzu7jPNyiIOgQ1WfPJ0FQRMK4OdHeYvbQ4ukzr6D/g61r6rvHjsrMvEKX0sgORmUiWZUx6dzB9SSq6YYkIeAVE/P04GGxfK84HDU04GKY2TRlKu4RoC5UGUcHOh9VuoaR9krfpJFSGQnk3OqV0ubW+s+o8aUMWnFKIQEal7TBb4iwvt1gJpicwjsqVujfSejofiouLvjJ8qsw36rxZXTXag93FxZcYwLCvUQ6aqwPe7zKKP9kmMsKXt/jo+Xj2fPw2whSkU1wy2QhCLQhvVlJVjSDQ/ARB2Zecnd+4bBFSxhB5bgUWGr2pqijYKfDyvTTVB2UrylWixVJYAS1BhVHdj6evFWcAod9TZOvFBnArpNS0OFGcFaWUgAiUgria1k8npvNR1KpCEHvHORf/N8sYLQNhJfhGozbW24VPIRyDh4HE1S4K+XFFgZE6bgLzXbdLMO3UOv+mOMbUds3nJSYFBsiZ7Rv8aMR00r8wH9VUVtJFJeF7f/QyolHYBl0uYiEl1q+8r1vWH23tQktlDFw0pmqVRWyE3sk0kjzOau+vv5HU7L6d7tZPk7Sk9iUqoRqMU0GIRqKKzy4OR/fXTOAmKxJ/TyXGSLXssiOXroimfq77sXUp+ufvIJmj/q3w321WeVHhk/O4XTJnxQ7LD1zsX+mmS6atRR79cGCMF0frzfQpoIxujt3a6/d5ZEqyWQ5imQd1nM4RBmKm1OQlRwskjQC4ypd4DvvKnr+AZ+cZ8Z78hqYVWz0/uoRP2Qsfdus+2YCqwG8NDCajIjXEs6Wm3Z5MQKDCkWQqsAq+Xq3JE4AL9c0+LPNywKoyHc7pai8rLW5YssiemyM0ma2gXkz1AXHz5RzgTqucZSHRkH7dMKkqXhZ2oRxkM2YZMcyYpqeKJd27zC5JTneX2sGzmkPCP+JXYVDStzid/rScyTbAJqwD/T7z+34yfYGCiFEdN1dKuLHNhFdOiRpSp53topPrAHdv6ZQaDtrC60aFb1JVo5YnA72U47hiDj/lthGgfLDlo+p29FwNFlZXQx7/lpijILPUoP8RjN2UzyGr+hPc/q1fHAEdU3y7AWpsvzV22SSr61+mOdeRRQYv20kYUEqXPQvhgYuKn4VEO+bf0wqKhZxmutDvVZ0du2xrq1KhwLOqiTz6RRDUw/79ZS17HI5WcdiI74rOfVDWndPo35X//59z/qzfrfrQeMjIBJydGGnpwTGqfLseqJlFIymFT44sd3EZjqX+HsH9OWioO1DjdQU1VQsVu12864FnrwA5fQ4VKVc64XeXCmwudNP8cJSLID4Yr3+9XDvxJrj+bB2RfUNeNqL0xUWy7SiIU/uqymCqdpEXDMBdzbPJfim35RMeoNiQOddaJekL13Ay82QPuhrSXILKXLVE1bzHw78p9RSf4XTmTkVaxWZQhfeal5b4KPMQT7ysIKwSU7opC+ZJnabTrus4YoV0eyB9UlUyS8LCXqgP8//txu3utdvFufbzmVsWGxE/4amfAAcickJTV1oL79K3vcSlm3JB7QyjLsWdO/8H66+Np08sQ1htNpT+bgKC6y45XLsXwvPjP8YuUNJzj3GzVlVM863KooUDbivimBdSc3WCXXNAPOUaV2gQYRCaHXtJvh0F4fWX2bhMb28OV4R1stFoTnaNm9+nmpQb6gb3h/FtGA18h37mg9nHUky3z6A99qSVBB23EcuNV7nMOv1+0+Kq01+fgDk+/pGmxXzxoSkOM+m28ux1Jd0wZiPKARwRquhieEcsZnmjWJs0W9IiNHUZwFgAutiFOGRamoLTSY8DOUmJVussCqj0tHVxf/01Sc9iRczWr7AOj3IGNZ5R2ataqXzmavCCPmdUpfU2V6eePx7IpWLu9vksWoSL1uWij8OksZRwLqW+1M5EDLKZK0gITYkqSmvn4QQea5bXXRqS1Q7KTiKXJ43E/6N+OIxB0MJnNVi1fZOfKFtNz4rPCBn5j974HoorlHvFP65eZDdPVsZOK9BKy0CxTV+HYzApIDhLHL/LusnUxleu4tbsTohgH/gJ3f1nk74LLAbrrfjO0o9vFSQT/6bB0QXXAfWMZeA8Z9Dcy/Yz9GcGgdQ93W/RxgGnlNnxQ3lB9R/fTpGj7zWdYOxOIW4fZAjf9UXSWQy02PWy7c5VIDeF/WLEAHUte59wNCsL9yv19M9VTfuAHV/FWqFDg/x/6i/0LDAycgIlehhOZsJH+OaZ/DAdsiMtHqRlLrLyXH5+a6H1+EfG9HgKbXv8sAikdPAFf+Wy2fFwegYHsgNHqs9pnNXeVYWTQH+KNnbudKov0nqJA7fKg9QquGL5qi8UCdG0tkGnT2UBJ24nOe1bnuuskWGLW9y2Nx+nDA6/qsS1cqgV7MVqxFrWlFjTH8qgkVUF1vnNhBDPIaOHeAi5OSIVkqTtQzA6IxStpiMPabNkicdWlgceBV3baLIAWKvpPGXlha/KaJ1kuuW3v2S5QRR5mKpUiTGMtP39EVMLAEIvpxJ8zp3QcVVmOhYKZsUI3/+fDmDoPfyFiPtISDlHS0HqmpFPsQ45FFi8TyHIAbmPm/9OPgVmKvxLYOISNuBZEpm30YLgumKyT9JzyrTrBjWFl+EktiG95tV0iCShRMJla3vENqNmLboygeZySU5xD3upAbhxa/JuxIxkuLFamqc0FMn03BWvqtOvCld5qGj/6g2W1/SCGawCEZvZhJ+7hyLV8HOZ5hwDrmmwxqp7q9bVU7qVPnhV6/JQhfjfA/LWAzOZwWY3xydYoR4zumEfyd7iscZ5TJ3hanEmiDt7KJD305RzGLorfdfiCBz7rsxFKVxx9I3wduKhDuxWwzGO9Rq9Wm8c//joLiOI3V2Gn7dpi6u35+LXwGxLKnJIRvj4yF8mEEEjvFUVx+kuJvfZOt9cChqAyrB5L1c+Lan9+8ztikcyrKVy1CJF8KXG6rqaocdDvzDaOVisriigRKUs2HTWcVURXwL/WKBThe0xuUqAJy9BsG3aio1kecKrpY9NLGWX3W37GyNJBP0Q7C7EXwj0pNX0mY1scyFYBdsukMXu8zUqNIp9W11ZlXJ4S37hcgC+90pTPdBHb01SmAnxaWvuDLu7QJVo+RYBoUWfc+bqxLYRMyxaoaPYk6qUQjWdHHvTIQ9TRARFJTm3cSwZ6iJR1i67E5fwjsvU1SG9iobkhjTPJki0E8opiwUPlah8T1n8BgXUPcA2VmYAuxyYs7ESHx2VmMLCe9KMXPEeTANv8yctOU/EsYP7pjEjRUyTOrJFjXDuFRGRhvGojfni34i/DjOeqS4AjW3LoOdDB1n/DsiIVARLmD+bLIJnuR2cyJQ0iUQ5rn47mLor9HtK54j4QDDj6gPR0t68x4D8uGISaP2Ou+YfqNlKb/4tNWEkQ00OQb1vxRq6KBLsWI1RXWlDfDW/xO3aNrXF7YZBO8cgkJBxxyETL2Tqso6okSmB2h8BE7f/k6mys/3EEUYiPsWvsSVRgSmSD6adUHUdw2tY5R0zupqZz8ZHsQqi5H6BFcKD6nCGA8+CznZaspq0r1H342kQJYkLireR9mpsOIJPSk0QvHtoFiWWcqafmgFuOcawxiG+a9PyKwywIQc79W2t/wkOU1veKmXvKwXP3ebYXBFQo6QbmItIB41By2hYUeJhtn2Eyp/2+1zcUVgMNjJivnfB7WSVNFGT2Ik5dMxcFrrcMKBdVgMLCQ1E3M9MbbsSgGNpgK3r6DLeHdHGXgb6R1Mnzpkbx/AUY5KA9tCWbIh5qCc508ULd+n1sFVtKkHXKcyP5ZYwY31GxTO4Bc9XZqRYMxVuoCoMWmH/8LGZmum62FSl0is/Xwwd25cgBtM1mNyQX4BblchIKh3Adkga/sVFZbOky5nu20Dda6e4Ey1sE3qzHeuE1HNECg1P+0Ugce8q+WwZvduyV8c6unFhocWAhPFkCqxBDVU7ZF9bzHtGJlc42hP8cGXvKtF6mbuEJXZ36Qp3t2dPafDT/tnZdZ4GRYdA9HNs+P654iBlwdYvU6GS5lsh0JDcjim7zWO3STl/wIId3Wiqsy3FN0TZ2/19ZU9KY6CQgClQRD3XWDyjG1MbCPjz1ZXSlJYNyzhcq5IHLeBuNlGuVkKzBe0ZsAn3wkkGXV8OKVWcOJNcr6Hwqu2ihr+FfqYGUfB3V9Zl3gefM9NfUlraI4CDBEZ1bhdTMhfu0gJs7XbMtB/rOURraO5owpfI5ycGT1oTJ4IjB3wVVI/RY2pyY7iz5dgU471k3hbVo4xn6BKC/pkRy/ZG0yJfPFlEk7yQxRNywUniYUWgzUvWEKhpMZa4WmYyVXLKEVnKvinMYw5UyAdnBgp3v02xFr6w67jlQSv+RqZSkGTb4qA0ylJbrOTUGZGTF0SenZ9EOcVQWa0WkjP8eblItX2Mn2IjiSD+zhyfQBlJsGvfWcYuxhP6BKLIHxeFepKC6vjEuIkZFHkAPIbVsUd94aEzUdePhV1rw5T7SokXr6prrRdzT3pcG/UZL+uRXH1GMhVMuaV5UX1CYEf7sUFi7G3iunI1t7VNoP+SIOcsb8okTWWCEBAxUrvYNdq3bTRR9ek4ldURhVWWlFg5pMcpcojKM+TEAeHysHO/GY1kFwirWwepNO+Fol8RmPoqhikkJ1FlzMyX16EOAERO89yn1Y8nzuZg3j5V1wwqZ9hVehe9q+g3ZYOmiIiLqX1ssTKIqD9wn8GhKcXp41XqZM4IrtreTm8uhAvyh1f/6yJHYgQhFY7tJx/Fiy1VWSVaI+CQwpR/Kqdb2YLLDCmrhuduB9NxZ/DGo9Bw/h6fFTz7mwGkTZjL6RQUmLkTM9I9jqrzsbobyRXBzq7ONy6yLVHyuyXJ/iY8bCzsbHh+Cl+mBmMnfBalxkEdebiB6+zCeBwQdaqhl8ErEpJ40Ze4QnDSDVJcu/WOoZqzpV2i95i6o7TlseUenHssZgjK9Q7UE/j7BNTuK5fQp9Nqs3jNVzd58y0K74fleK2Vl/iLtUxt1koJYabAPVtZfPIIL6vMJm6aKmkaLz+U5P4+DHA8GQ2zzwUZBdngicO0KxDtOs/G78XVpoTGfCyKZXHRBVze5hTH/ZOupf2FBykr9m6Zx4VHEdFKPO0TuM+0BBI81iUO69ENTynClDZbQo6KTuahE80kHtNdRyWlpSxuR40t3hHgDK68lquON6Eu5uE4Ct/UreumnyM1bM16ZRzwmr2EZOq69MkWR0oGKbGfAP6ipr5qD0ks+GJyDodKrSyyshjG7G/H2eTImMENNFcZvRfGnSng9HQm/wy5/vdzjoiNNCUzs/kBi+qhw8BTbi1msUaIJa5NOyvGD+uS9g8iEjWSqraP83p3Cek2CYGj6FXe+LlHWAMG60Fum7EGbd0oT9O4QWLcCeYZL3f4Va609Irt5zbpXFVV48jP0vIa5iCDgh0CrV45ABOaRhuPqgIoHH7gdOstXj0fJZv+nPlC89Hya3K+2iSSLhuUAn81OeJ2SfZJGbtlSzl+2ZImJ7Wg41KeZu5SXNZmlqtplbZROpLAX47nWgEtLVjLlcyKa5H5+azVKysyrQ/V8jItX3Zlo8YIa0A30hPvcLZByVFGVmpludSiS38VQrQ4RzFFhRQiR+bBbyTPKeD5tNg2u+ggO2kVskmLY54stkT+ai+ZRu80UtWNwthGctOa28Zy+9BTJneuCbLT0d/bEKStLwcyo5YJ+O/DRhK84wGTLn7Md0XT/b0BT7vWjQu9W41ZyIZd1lmSUwSnnD2RadVeU4WrcjbBbp5XzHPnxpbxpM4SG1J00meialv8+EZS0jWd2TsrkYhi8RzHO+qTZDaPcmq9+/VrgyKkNBXBiHD3ipsxqS8ze3RFNsa4xbRoi3BW9CWNDeVuJ4mOXzcUROMlNWOIwAgBpjkS2DV86e+yC6enfoUek4xCf0bOwdqTkQEqAodyN1NeAebLpTovsH34BaI+S12U6r9WGKZHoJFduUcQfwpHyDRYft/brW03vnaOCh/mzdhis5I3TGUzgpe95pxQvJq5lsOY+j2DRRR8oWf3mKJ2zfNe/ijfOhXivrXoYd/GdWH57S8KWidsgDDZ8G/ienmsJSvjynG0QGbuRHnx1qKGeOaTx9vEScttnFIS/nGt8727x8L53m0wcm6v9zhybq8bXG4N78wcTaPQBXroWfv9kAuKYWzNGGbbtdGX8BDQsARPCcsY+VFpp01R63CZiIvwpwfEO3K2K3lh1g9dQO0UnQdVVHsrYccpu5HtAfkO+47srR9B6T+OccQoh0CwE5WboDuwYXSgFunit+5GkClNoNwgpqrOyEUKrzVEW/2nzNRf2Z0rLUYxwxY8DSrymLAWpDMTo9tCqoKEjnkiom5VjIaNZZrnviElUx76q07pNgA7OmHDJ621J5QDoePQaLF6do8Xco7nSoqkVI6Um0en/m5w2GVgtS0WLmkbmeiijHp1Nu1pH5MFo/Hm/Db5R/Moop53bnQ2vTC0uxvsFpX1xYgMEYYAt3HVW5RD3X2Ih8Yu78dWtxCkAjPGXRbxAALTIhke4EFX+1mrhmYwNis07d+JE7qO8pR2Zw+i30iRJ4mdYGhRnqBhoBKWGLSqz3nVsjfmOhqzh2Vu+qRjYCUtEj7Iqj5OcFBvZO8BxdOGRLgN1jPlIQ3z2bp24gwbCmSMl3djM+A/81RgESJoM+vc8oirEiaf+yohndQhb0GsB7fCj+gq4pGTAqeO0Iauv0Pg1ekmnbZl5/6cIzeAslJUli9tapuBi+myQ0PgmpYZ/rkfvP2BbdAtnNP/qErCvurJaAA2crpeJ+5mG6XlqQpibI/EpviTEW5YBf+PKihc2VDCfQsoUDCUwCe0m3kEFRLbpPzJin0uWEcCcwRUcy0pKNA8W2F+DQ/z2KSv58rnDG4nXtJV9Qd0xNMzyVPKpCf0fW69QstJDdv3/xEKIQ98mFK4yDxTIDPqjn0+pDBqnqMkTZRooL8fSZ66kev7T5gL3ZDdJSByMAOgUU6RaWt7PvD7AT5NkDqN2mEy0JlXw328QBr2/uzO+y0cNQbbu7WtiEsYz+I+/zLq6Qmg5eMC9fcPBlv5hzn3kjJy9i3kjt/OjaMwe6t2M5Azkz0SCFH0HFV7G8m2uo5cXmJPOPM049Yqk+a2RRHYBUvEcPtEc8+2kRFFIQRbPrOVnKeuNraVLzQJEEBedr0c15NTINNW2fZfvtVmWmQq3zUUgxUueMYQYDm3+ZhbvWVuLG3g+LbyDYFIsWd2XL8EgE/cSoePr3Lot1WDtHa3Mm2CEEGXTkyTD7yPXo0pSDdGWF2HDFCXyfUHM9aW90RgM2uGItN7tAcQTXBooOdRjmi/f1/qHkq3L+7v9LnxRnQ6NyvvAEcOwqw8lQ/PDcMhQd1jn9ClY/FUR7OtK2+oYIzG6pw1TdyLmzZ49X1hO95nEgrNUiYOyrsOQwJWAtIaOavTptSFK0jFUkuEasdFUiEuSwYaGkR5vFWlKbkkomU364yxHHs78J7Kn2pm9fCAzWcJieYGw+6rgJqth91bBUUs/fKq3m049ve0qYGWwEvoQuOZn7xecEZSN9Gnrq78yRgYuN4WzaM1pnzoxaFzmCowjGRA6uGRJdV2wmedLZaFTt2ecDtWpeVHL+El86bKn22C9yrr7RbhX2ojLint1Vw7DeLybJm8ur1H6HPDH5AW4LhsKPLRk1YJ1qH2B4fWn7KyftcsFDYuKMH1wElvXwpUXyDmZ3N84oZW/d/W/8KfgfhtB37cofy6gygcTe0aMEoo/b0NXkKeLT3nFXckUm3nR9d9jTgsWW+aiS53wl5N7eBuK39eSjmu0Kz81vQXq2kZjUc/0Lx82vnUQffungfwycRI9v45+GC2R/nAHePTlS2VZ4c80ltNTbEIC0HrcYxg7FC7Ls7M8rfo5cvLbCsfHDMejs74Ry45B6aINxJs8dInZuzFiUpBwlhwZN8Bu5TkUlO+wnypsCFTEH2Ptt46FzA2l3cYBnA14MLix1747Bv386fc0TXBTcCYWZX9SSYKOOyulWkcUPwuAhebtViZPF/RzHZIjVM2ypBMEG2NoVtsU6DEo2nXnPI46BZgeufsF2fqibbOliWmHFNJZ/hzEB0ksFny3GmM5IlQ7U1DPNEjEBQ7GzbIGkOPggBmpsD1ZTEkL1W3LXpR8YYVXO1f6jQfWuSitLpNTgutuEO/cnDX7Ti/NjUdUjwZSdl8oe4m+5AKYROUbX/EgPLm3bhnpYjEmnO9Aw6StGtyrnAArTVLSfPeg5MIGJv7HU6WSI+HxLONDeUMf0HDEDNxtNieGdwPKZSsBRHxDPmF4c2F4WB4ntqRwfo2M3ax5UWrlAgB/6Im6AMJ+RVx4ZeEfIogyzgL0e2U4QE+g+cslyJ524NK74iNqS0OUSz7avzQs84oX7mAeisz3NeQjfVdXpfSueOo/LxMewBv1GKrLRIfgxzsUyA2lM6TP7237PLE8shIu5HDyPKcNaoT7R8PIElV2ksJ2O5ngC2hy38pEbVM5PZpdTrmp1q4u3Bw8hNpPMSGOZg2XLzEdsaz6FHTwGJ21HpKDssS23CDwltpm5NuSCwcxgGbebIea/TYLP9W+ygiaLIZMj8rQXanDNVYI5xAhhPTEAGYcOn0RD1I0uFj7dA9Lf4JFdmpRve3WWQl27ImjnVTiAQUEfkRUy1oOk50UymLBAkRrjmOA+IqPdl4Urge5xFRiJ7wskC+nC3HeVRtI8Nq+EDC/AklaHHC4P+dUDgUDLTvd9EH1WTeekxu72oq9omsts05wOfeoGtohRvfIesiGpZs1EoO0sjukLRX64C+LlFCeT7+YMr1BsWFjw1ZU2H1bY1GoPADuHnuFSQ9DkKY5MnYelm+Eq3Fp4zR15MXsfTPW8NmzqL0uq2ErQqFS8VW/enoeycEBhoC1/NM9wpT+pke6467CmwRxWUx7azCcC8fk0ax74h7VpqmkpwF4lovwBlnV+Xz8vxoUvkwjJZqQ3UyAbYca5boqSWOsug19S9hm7lzergEK/1p8cEJgYGGwPU8U73GlH5On4mgdFl7DHf6G/744r8d1kb3vjIPDQ5DUPdK8PqvUt9qiSdWpHRORhaLytLJpCv7RpbsyzK2tvX+9+yfQ70zQUwAxlHGkUrjFXMH8golBqPk8elm+7y8RGsnbiusGAbYwHq0P2FP+TENrLf5Za61HR9wSSI+pW+60DddVK9W1Su3nEoLLKMnObB9T6GZO0NO8OaAiWq0j7kWed+jbTgPHnS3VDpVFvva6wSrI43+Bh+8Hlx4BVDnn7WIG5X5MefJqnyJ0Q+g/UhKaRUv1YLDu0mRhgABYJwU1XR3MtPx7d3vzeRkaa1NgQkvF6z0IMXdr6C/Ei2D/ND9MMd4wZo6dPOeHUyZuX8Ry5JoCdZp+wwtY2hxQVQp4Z0k4a6bOv31yfVyi2knN26mRdQS7TTGviw5B/t92qhFdIvZ3ORg95WCZ0YvqLXCaPCt2QbzhsGY3hwE0+VVx3se6MsWhYtqwSwVuloXYGXINqDdTvsD0LIHh3tfs4fqDfWUcXbwJFb/cZX7zCQG9z8ljirF63pIShvvOozTZuxI7TwDlLXaWEz/g6dWNc7KsIHSDKOsT+mdVDtigJozFiUFBL6cYUhLBWvRsC/h9uhjRaX38V3vUwKolCLfS2P/cOX1xXDY/6iqOsYHyJuEle6D7F4/7XdcxwQAvUPPwOf7AlIYqvY398Dvhoa8gjTPdHxAyVx9eRHw3hWHSycQ5dPcAWXo4VBjIVhn+PTGl0kPospsI086naTHnXs47B30IC2j5EQlBkJyL8cSUg/XxOZyy6LFGGhUpBoMGw+rJbEqDLNBoWfTUF61He85TtY8s8L9P4hDC+XX2PTYTxi6jitRiLAxbIoR9YVpyQ5De15xO3awEzBZUyKpXRuIeCljb9fRWEUwEK52Y4y0B0MgwmPVVd3HWmRLV+h7iFkAGQUoENmV3gH7s2URog3OtBpG8rpix0evJkndMiRGfbMgSnuEwWTmwsxuQtFHQJAesqAcXTeEpFYIYKAD98Q1Jl58uFm1HYRVt8unvRz49rJyWnV1My9IFVY3GxoqIIoAUfNuy1Mngqhln+LSWFuqF9nwForyTpWn4jq4J27/KjywmKJqmUsChifNqKcyUS60LnmKRqvKamdTJWNmkutUj3LE1dPC16pEz4WDPrA3e2tQkcI2V9Om0UxCWw/Lf0tpJCRGTjkB31thNkof46Bew9e5WyrBXdTH97jvXZbrDfHvthPWi7JyUgJTSwsp1ZtjafRjkXLSric5QOjRSUkho5CWlCvYFmV9eNG98g+0csWrZYAWBonmD2Z4BM8vLldbSppQA3QJRkJbsQJ1lpSK5WxsVZVgcUWutql3jkZstE2qFuYEj9VHkra5mmoAM7TzqCnFAMb9xOtJdYUaA7iSgHD9vK6uFsECFhGrdRqVAwDhKegsx73iCuKQyYnuhEQYpvIst/F/SbzOsNJMysAK1rvqNLql/qpINsavqVDlVHBWD6NbwY6WWMsozmd5ihRPadR5KS/OZNOMlea2Lv8ZkbCwSmo18tEeugOSM7Io5CaPI0LFFiFVDbo1M+dL/VTSLacWlvQ0dWX9x5f2DbPr2cXPZvSsXRFw3Ei1ZzS2XqyQh3uRzPAZWSG9pfOLTb4thubxVkokUPASeFWHfQrCn6i3V7IzuiJ0t/5WdyuR6/FmUDH4ZX851+IBDZ2ZP+44fvPvRjK983vrHk5CjOKSXkNrWw2eUyIkWwCmvuD5JInqhDa8/mJful1Lr5wSQHOnBV0xfImnfc6eDSXfNwqtOIKRgxjThMGBV9fWNwfZ9O3iKw7cpZn4RbZOZ6v+DlxIfV3UH3ea9gDB6wjXuuGwmxfGopREc8gTMtiP2J2x+OnCLHl8tRPEyzgqlidL4QhgpuelpqCa5QgNW2ho8zDdASlI0NrMTqBbcnCxRktKABlhenzXGbXEQRhSmUmmL+n7kda5BPXCJf2Dak2UOlekSOAy1dLKWiA/edtKIouTHi/kXv8w17XlQOEYVoBV8WfGjG1eQbPkNH5Jo0/7dZaGhJ2iU0fnLvaNXPvol/RGswKlqY6jpxi0fDUwI22QR10dXAwa5D7C2Woh9UFbRydTZTt93IQ+/gRpzyeYBMskdphb/XW2zrjXisBnOVMCNTOAWt1aqYTrj/+rL6fzlNwBk4knzFtLgJTpGQnnSn8xMTGs0D+ZGLx26o96e6ObhLmkxfJjtVU1JcFTRc8cyepNjixxm9GHxHATNHKjJ98RURw6Zt8xFs4+YZi2DO2ukt75QFglKKrzak0V80V2cXN9oh2TDOKtnCtg0JNr8RDS+24z+z6wCTwR0m1sHpvtSrdfneBkrW1CUiM8l3mudykLNqkKXbZZVAd2jE+vryPLQZbNMWYZK0gKy3H7EUJcPrPXKwbQtwoh9b4FCASEzc+7lhB2dn0rn90tHziZnvrbCGR7hx8UEhIT95D0S45/F+djGLaPD7LqJBvjZfZ5XqmHdKBAeV2DUfPgcES10DA8LcLC3404rLrtXrcRs5M3hxbTbg7c/Tp2pbRkYhhzvHa+sWO9k2asRIgE/SOVSeyc03pe0B1y0HHAMpSyoyEg5Sh4oDTuhIV73MxykV1Vl6pQGyRzsfbk1R5sweI2PyRMq7zfaNfNEX0SGdqSLFQcqG0/rRPaFRcOjcYvq3qTqtoltXBuVVWLVWq3fu8fN3C/gL9bqmjH2sEUfzjOeYiJC8I1KuGsT1Y2OtuHHVUEty50VySh3iMVGmm1Tva8sKd7bQ2/OAm3ebMkmWBdBrBrNF5vgQOMGJvPQFDjy6VHHIdMdlL+o+npkdd+XcnG4VYUoJwtYaxx2J/m0kLcj6a7zOBao7JUJjb74CB8Gh7aFjREhn04FmQ4foDSn/S2LcuxdzRKW0kdSz6Ves79DlSlUey2Cc/5IypbQdGzqKOwQy1ottijgDHwPuakyg63Zj29X0GheSuNhJmLuMuIDdobsQzG5yp9v1i1LduNO5qUSpMfOBKYo6FqvGya8NlkxnLFkBq1O/worcCoaOYXdEQrZtDh6pZjecZrudt6OAyClHLJejwPBlF09AbDBYcIJXagUNOaHX0hFc3n7g7rw6AIYk9TLDmJOOREgnlng7abBBO2fIYbkhIqBU/Kj/g31gV01q9Y1yu5VZgjY73cJjsdiWl3JTFfLMPatCFzPeWEy0iJAn+O++RzlMIH2gcACPDV19lUe0bx+bWl3AtzR6RlCx+viziQLvMJrvEInDRyUCDbM4xmgfKrlz4/w6ihtB8BJ2E57XhGyYmm0OlgsBuTM/b7ajKRWFQOduhsZWuaYZq3G7U/rnSfSO0vFI7IosWRGY2Ls6vzxswOniWR7EiPmMy7vU2mmvPdhL/UQHoZlzMt7iqnuJgHs3Uf/RqY2Wqzv9tWQgXiPG8ySa5taXc2C5Tud4kroqkyhayOPfMtliN911WnCYs117MbP99ACS09nhJPm+TlUzZYDOYL94iKh3hsWSz1IYPEsqdjeXr4DXjoCslDmllXfepuNgk6QY16rW47jSCFB2pgqErHvDNXuQSU4VNnfbHhIGoTz40aIjZxEM6teP0L/RvjJaZjPftAwOW5655kHBdj1eBy6fAXaUgt29fPuu4wt9L4ISqm5tkkztdvpu6GqbA657+f1YJZs/szmqEMbCu0q83ctAUXNgZovkbUefO9Y66yxtuzK4DcHtnvy5T1i3DrtRxE4oPd88N8j7+KQd1/Ec43VziZ/HTKTLfDRFaAlpe5oC2qXwbi81I9Qxl7S9xqAbwnAusRCY2atkBZggaERtz8IZjj7CsAgxSagY2RiKVL5+OMYyB0maq+x98f32K4z8/yougYR0DnFDgqO/eYy2GCIG9/9gukDyVT0cmDwCZjkfKBc2hQ/1CMuWbpAiwUsdwm71ML2G0rCAML/b/r3mbsTvJRNX2KxAkJTsdNJ857wVYYBE4q7LwqxXtK820C1oXLjtHns8760qIviNVYX/3TwMwuP3/X1PjJ24Ya1DMFdfpNelGRs7mXcCRBL0PwNdzLJEV1mbOUpkyl8xX4gC1V0TZRpflyJjOwrJI+LBUvp6jXBw+YCtdef4PyRMVwCuYR4wZZxhPffvFbe8tzObtR2GXgtIUcggzqtQdXSRGnnqzlz17QvbK/9z2OPUnxi5cQD8Me5RhtCj+SSGCH01IymC0pTruiHLYlHyEcqX4kzgeAvmLwsiXR9/P/ZXxc4n5zG+FJnG+ua1VLWFHcufILvkufLfq0pfFI5mr4vwAMXqZhrqoKdYM8tRH6hosyHDidCHVEywLQx05Mj0JumyzHZkBaVUeDpNo6Ihl09JdduIUKrH03TCICYOkejpFAAkmlAbTfxzY4jlh+RxsbAw5bZ7cpj3pJaEuDoMtmwFa0ykcciXsGefEI8vEJOmuuk8MTuzmEEovHnzhGWrNabZ/1FuZGHgFvBQPN/jxPfxGOVsIH23UuKeXqLHdqrZ5C38HSHI4VyRjkgEUGrXmxAnt/tVwxFwf4Jqi3Dk6PfQIlSDz/fdOb//ot1jeA9OIf8sFkgEMC25rUlnic9u0jInzpc53gcFkMbwfXEeJiwRAmctkmvW4IIpZuCiEjtRd6Z6I2II4bW7XEvRIBx86LjtAq/QjKXclbWDIWYPiNBJNTu2+MXUHlZdVQssnAOxvSlYnSUU+xwwiZvfmmG4MigTUir2xWVt6VPZJIdjXaGKiuyggsYNqk/sGIVvy5LsOjpDkggVQ9losqC8Q8DwFziJTsZQNvnM1VzWeFtDBWMuG5Wfd3stdTE0I2SuBqOY/6HtTxmL/8ofTxVkjuyckU5uAl6u+J6qVVDFE76x1/i2Mhj8452pEgAvT6J/O1/7pGn8eRjDPa5OaiodafGUNq9HHo9HlOL4/PYMH7zKMEROF7qUhsnVNcgKOtE/jPeNe75qWuXt8akSMO+wtVU6D/egp0MnxyqRmWsM36W33z60iSWjnaGzov5c2TKM0G0O6ss/Pms+HWy4gMnVe5qc+r4uEhEpfX5N6iRYNGMwGGvqAavmV6I38H4ySLB97gxyl04M+rYiJdkw6Q6N+Vup3XtUWLvdJWZJERwPXKPCxiosZee8iU6tVNqrQTy6WSC5gOTqZNOXoRlMlx7NvJZn/Re70pQ6EJl0+F1JxQyotHq47axMQwYhdg14ZM9+Io5M4oHc1NCQEOrriRB9f5QexiW8uLFcdZ7d/kIMow8uu6XVyiezFv3P9Lx+sWHPuMtD/gVUoR4gpr1ir3VfzKreefidiVdxnaIjVpekeSMdxRx+u3WCZ9zviroDJ47gybGd7hgEI0+A9biGNOuHeI0vM76oknF3UBy/M5HuU8b/JC56Oty9ulnT4Ycs5MjV3A99HWRq1RxXXtH+nilY/yZYw3fB8EnXP+Ow/2d5rt7wzZ79P2dxHt76ywv9PKHt1osiGzY9jEHVHv5ARz8UKl1hks9uw/vaHosYOuefl40bsTIwR08ABJUtCpIgxF8AjnjyD+2JXkDoqOks6wh7jyGR5kSZBP3Z6OhHqYYT6uaXkMvAZ5GkfkCG9deOPXC1oIsG3mfp2crXxZHOUPaHyVa1d4uYAnoKLf2da6ZKNnL32c3RQkAMeXGxVO6CinnfYq4xjdT6h/LpA6OEtypHw0prxxlS1IohxyIcurF+McejjLkN+yPKKVS+r9nHBNAJoMdtsr9TdHmcYzycVRYS0c0WrWK8ZfQA83tJi7bYTE+zfDiaXLgwaXRme8eaCea7NeWepLNGYCqWSrnS04ulgdxzH4hCE8R0YGWCuchWAJD7sLWN6c0rN2SzhNCNLjdifXcs08gNPAn/ko3lPGqZama+Hib0YN1u3KF3zpFzy1mqAnHEc8/VZOHATQo811ahBmnTXKbnHgfhexkFvAySMph76Qn+7s8lZzsCm3+jwaGPldhRnEWgiiTetlyfUdJhGC0X+7WH0KXLPWr+hLnHkZsRkn94ntsKvqSR0Q1E/bXHFJ8JZmpOhSapX2Th4fcn1IJCze/q3YFXR0P9j70Ndicbs3wmS3Rx2W6iYpKK13fFX4YnhmFn6HOQH7VvdK4St2MfFILE3Maf5Cmmo67Y6zX8SzB1qF3jkUEYOSnyQBLv+KT/990P8TePP+hzdeNfixeGwFmVmUS/ZICoTDrSAisL6htVNH9FRZW4Cwmpi4jVyOb5viepBYb43/f5C59lGLoWJ56cdxHGPgq1dojoec83o0aYHZ4tu3VsHTncXg11Zx+vII6vwHE5opKPqvTZVe8owLn9SVzNjW02dmVZ0S8rB16/dS3cgWtRKp8wEHgfDOaoDc7CkxTGe3Ucbu5/TztOKbKF5mMDS6g8dpraMxysMiwBTxNkagN2OacOotNiUoTZ6u7JDNwaVEtw6K1DeOOzQeu13N5z6z2RegE+3WJxcJt3eN8TRwdm0y4nWhetn/1xuJWq5fcbvt6Drsb7wtQGox31EoxHg2epRX/uEBkoYMFrQav4QMlZhkiQZLLWUMEi37l9GP0SnFVv2ArkfCTbong/n6T1YUTFUmhhuTys9Btvp6mG3HXk3JjMERo45H/i8tEvNxQic2mT27/OGRp3/MHEkG8bSlajAjuoquQiCzPvkCm497Jky0gVeIGG6EVR/0FJsnH21GJ0saVWV7dGzvXlmAD+MARBKjESTNtasK4igxRGapBLHAExDGqmQ73wx1NYN40aESKvYDuN8YAJO3BijC1OrDgZZbnL0anRsmeoGdCfYgAVbnYGAPja91y21n41F+uwiEpJP+8YlPtQTaXlFTiOy772QoJqxLlWVJ7WYCuzf2xcXF0DyRl8/fWCWprXFvRfYSwvJEZNtaXSs6M73j2U8fy6PlM8Gee2YBEit2CiWbXR0lZBASXwqTB1Xk4TeTL4n05KpLMCca+aCYp2XXIOMmY3ZNMpGTWfmdFbJEKv5zSrdlG25WWEqbW5ms6IZU6Abz4leU6rpbC793lAx5zqQzd4VMe5scchWSeBTEVW5FJKNEPBKhj80FTsDLp0gBGkIC4oiDF+Lx7xqh1e9X5ic/bxuvLxs3IXgtlRETMPKNe1ECMHlcaDigVP/UGLclYOsyjQiKDU7Bo+cUc7JtBZFRZSYBkG0JxgWkF86yA/k/pWwf1/Dz/0QE7dKn2j4tACd8kSQcKYlzG+aLjjC0oMkrNXsl0dVS5HwrTrCrxvyirqBx9BaWNKjgccsETyWp8BWp/4nph6DV9oxZuyn+wrJU0JqaxzZ+KOoab9pLAcoHu1oLCdDe3GJY26gfhkARbWqskzZ8z4k24rtaWAq0nSNx4S5yzEbERwfgBNureK4gVbrDolOCP6e7IuBJmQEQ0SkfniYb8ZT8EKTHe3iJxZQV5gudB5Fh7vcHwKOI+8RXvXtSha+eB7cjMFhB+UKdsfwyHyTZiL7BlpSvUkHlUHvl0I207IXDoQiw/X9RwHrIQpWf3jPYvG8aZoryiLMQ12erIC8QewxM33n/wwHDEtelB7PDuRAX9A48utKaAZxvZCB0DUvf96g2AJofed7PNrPpjnVo+v+EM55zXVu/lEDtgFeagWSOuAQe8mlX9Vc8usHg1s7dCoAGfS5M43qnPEj44RbcFUr9E0yKMy1eDIYnrRZHTdKxpfYcxB8gDLuKH+vdtY5bP/U8Wry31LUNc6V5gML8IyWO0rMirNc2zkagPuXs58uXiDeDzIT3zyKNhlIlHsmKwl2vA0kjNRVPMBVxJBXWk3AlTjTn/id3Fn/52M2T+sP5M4TDp+rTB9uZNo7Fq0zNPLxuSb4lq97eTarZ7j8kXtuVJDgyP5OrSHmTy/V3BSxv8WXB0Wv9bf5R4qnw5+JcvgSe61/NvWu52THM2rYJY/j5ibl0ziBlXO4NTGW7+8AiAQezVeffrJPCIykVwfQezD8k/rH6BYjGRiu8l3UdZt82cvA8rpeVLc1mcBaR4PsUseZkwhJecuMp3LpG7oh8CH+NKnp5rtQpJXiUC2DSWQWS13j8HMAy00aUvOdVHX4Vjvz6Z7NAr2izPW4a+YaZNYU/uuYf/ZiZUr3i4OZ4JxvHM4Zk/HJaQhuMEGBQB1F8grTi5BwgngDrsURpT4Td4RuvLSqcMTWJsoRowkHmmsTAqnWHCjBklUqr12kfmly0sKBwOoe52ZtlWbFWKG4Yy4dsTuY5forYJjlt6OiFpEGGsc/Es0m2QrGQA1lCZX/LbsMnJno7WtdlOBe/s3H6SxuDuUqEtEcVKykd1JfNooVv8hNSQ30hz5e8hICM3/cRKUkoosV5kNo2fIHJKkkPshRu9wUXK/QijYvhZg8JeoVd664kgqAghIkAIGw3/KQLYTUIE0EtuNa2EuUB4/uqiQw6Uvtl4JLeqfcYzol1Ld8cwddpIblTJVl5OTohWIU1t+EXsZGrq8fAWQhwbG+sVbNkeF1fUFaptat0oDyPcj4zETEydVFfee8F2KjyAomOqbMoPVgv00BH+4iMXZLB3/oL+LTQ4zFKUzzQbQscm9ftGRhcDGMGDU12uWV2uDZdRiU8sKbDo7rGRvSWABAZRh8k+WVCkPehbDRC+1A9pfCMtqLG5hxdJ7bVnTlPiJtKScSZuw8VExl79ZuNGbg0/c4yZpdW7JfS82drLTTO8K91HFPM27/4LA711oQnMd7me4hB6JeOjqHc/TehgoboPRV7vBMIsi+eIs3PdcDwKJIl2r+CHuSKOPGJ0qRM/OzL1fJEBWMFy8pTWpdY39Gyw7/W6Fr/M+7/asP3Kliu55HSH/KHx4iJy7vbLe1T6vWvhdM71cP335gawQBOanIuY7ang8QO+pxNgg3tbyz+ym46+y3I9TG1HmShRS60wnAjr5wpLrlE0qYgvsf+TWMsA4ga5IvT3PlcMuyfoPg+YaFaZSteS9e7ggwhW4SoDg2hLS6gx4UsjLg+dqVaZRVJAzudbGUqn6JTO6PyevJKaectLfMOpkHd9tLJK7n2BtlorNaBt9xx8lqfT0mcA77M1jw9t1st3jJngLpaz0eYYtcneIdJiccAvsvm/xPXNbjiHb9q3hZ5NMOTVdr9KqxkF7nyRv6zntklmvx7XpbfEjt76DYbXP7X42c94ij6Y9TbU1O67ugDdFGLuPqn+F3cl4RFzQZl/mnNu19zm7e+k8DjPO6cdAGPWSw48xz+WmKmYKsMS3k0aXD6KVlcgcDxNxpMx+HL2dARQxduCm9H304ptkowQVak1eFN5ihfFhhY6IGBSZXhV6MLNyoY/ZY8KCMd8/05BFWEh33M5R4W19u50UNqYjXihoRHFy2AIZ0kodK+gMQw+RruRwk8kCptaUkpHTzQKADtoUPIDpm6ImNDBs8qWvXKXrA3Zv79FMUv32LMy9T2sjR1+3KNISWnkoDKn8QSDtLkw6a/X2gAXzlAyp9cBU7wTtvNIx/vk39Zo6XVCZ2a+y4EKqDLiqzsbOU4ZPOrybRCBKwWXT8o1N2+Qj3eWAomjay5iFzEagRPvmLCiKPOE4JWn2H4v44HQg/ndRS2lL5oLfcKOGshrV1HABbzim/1InUR2gS9c8Bf4yKDg65dIxrMIhuV958dO1BMsvhSRuK5QHS1TC+mDnuY2wOCLrjs3zwG+Toeup061H9kDKtpB3IuaLpVqDWKewZAD3ayzgKCmFrAzgjt05iDnFkWrRQ4E4HoyFeeFWT95ZUJVrVSjjbXM2UM0XdnXa+sANHtMspKhrPCuZWlXbQ69TcpueOR00l0sAiSKF0CRpViuwOt0byk02JInEGPP/fofTMlc1AFQSszy1TlRKiuta0CaRc+Uzpz6xOCwFEMIKEkR9FUtkLBPr0bYmxsiw4Lv6F4h5FPqMU9xDKRLQG6rcK5nkSsUsW1JnaLfn2tM6LSp1J2Zav2haVSD01I366Ft1dInKVUmL0a3TgKocLh2FhGgbJJfv/2CBmLjcuQN9JsrZT3ZpqA4A+WIumsreS2JhmaG/Q6cTtFco7KBgltMaLcxzFx5EK93wBdrWujyl6nX0YI70pMmvbeMmvfHd76ZyfEjuCZBlHGkhDCKpDw3zICNMGmLe9KJWcseJawx05st/aWDlC9O8XJDZbiOJBE4qbs3Bc/Vtpw8mlbe2T5skyOCEi2ccwc0UwiVgQJw/XRlcjbMm6X7Sd9XKeiMriD9sPRXQcSCHWgTnOg15834r0DT3zqCXOIb8IGSgjTCSdh6OYQyAshAy8uFlBGUznrlu5PDHQXYPxK8LaHUiE0m2mpnVRqWzNbO+KmlBbU1dtxYNqBIz+wNk3xeiaiSrlZxErlWjTr8h+BmR1kqZ62hs16O5LJlFbZF3sz+ugq1qIrICrR4wRbVpfsG6qVwlbF2VtHPGw5Qb2etZlFLrg7fRnLMNvNfI0rftwPLoWcah3DRNS1Dax0HPdpIIlBKXaLb8Haz3ED07EMw4BdkquoIW+dYRz+TRn1p7I/EzuYfPzqU8XJTBQ+R1ZyAFUAwHxSBAQjjoPeR9gvzzPLPJ/Dj8/xliahTNeV1bA4qHVm1Xc0z+LGVZsxiDDGXYl/9OfwJMIY9nVGkBWc9toky0YD5gX+9ebrzQpr4rOjF60NU5j+o4VSdUZespxt++jl/A6EnpLcMPmYSkROgo1nD1Hx4/EogZf7x/Iyjcf9TXVRkXO0ajtgYZZ2RNhYBF7/HI6pVTS6tXVSrw+qes1450kXNdUt+8nTLvM7kUy+gHKBvnd9rPblsYW2g7Y0OZsRRTrVFulR1NOtExFG+gJtV07owqHoS+dVGKWvmdkM6MFtQwj/qHsOoW35tCMKTmlmnJj5Ymo3/sVhVG7Gdwlkvk94BPOIskRA1Rk8hwxycvQVzSYJWlVW/HCbJnTBDe51XV4cORLNH94bZgPj+yz+jd2m13ZKIhgzn1Nn7geSIez0mdweuLs2aajgh+vhdw05+3O+c5zZtV0H9fBWPwvpa6AI82bTu2j53SAlspW1OU0FGYlQxIMIoi7iVnjgNXz54buBWsog7eT1yl4r1HXPqLphRcvEguVU/Ie2IqbdtmhPy1quiiblIprVl+Zx7ZMeTFNKvtQn1+xcGXe1KFxZ6T+KGrq3+Q9tnXE9Rmrw3IanlyyA6y0rQ4JiVMkQ5nWChX4kB8sl7K/zD802WvxJhXtLHYsB92bp4HzSUXz+zvMBboZgRAfevl0ulqcqd0roUcHOsAJiCX2QDmimdump1734iu3KGV3A/vj56mrWz4D9xaJYca09O362ysXHViPPMPCNUr9WiKOmeZ29f+OdkQLvzbgQr2+qxpZOj8R6l8X4IByNv0Um8sgTEm2w5HyCFZk47AXlk4JpfRbsb96XOP/2GA5/eRDjkyaaMMqnAK/WV+QJmyeFse45yCKwbGx5ZGGI2RStyBIjJKQQ+kpX+So7O6ErF9AEoiaNjZ8GOEXqQoGcmFX/0f+Zc/2L35NYlJ1yHETv8b8JPbBarAEBxIv7pZBYQVoH0k8IADPRvP4AI4h9+6ZfeFzYTdQ1Lu0Cr6OQ14DYK3XrgXZIG+2nLgO/LqVDd/zRvfPHVAWQwnRXJLeB1xKR8qXVtpNu2i/VNgdxHYJ2nDSe5STfwRGOEyY2MBJt99Q8rR3khCQ5ewBN+hHJO/1tlx5Nir7UfRK9TZpdVj+rK4nR6eF9KYs/sJ75GwePSsE9E1qC0j2M+MUxhqKTqRm1mSSk3Cpih0hbTZBOlYDPi7k4vPUee1cCDvzBTzKenawf4K/bPZSJEVBKjnpOpw6V4tLO4b0y07SoReQI4/sk54/I5HlmML9dWyLLWhs9hbfkOV86hBJBwv//GroK3oTltQyLF8T5Ss/9cfdDpjD937oGqj1MCWGf7XoSZ7wIM7B5pCVDYBIqp4jlI9suI0zovZ+9zConAPoIlfi4Ucq0BN7jqXMOPUU3np0RLLF8x1eVu7gm8BZHWeg5mk1+pr4gSAeZElOSR1FW5A/JhoAbZ0gotreLixsxL+kUzQV04Yw6PXeRJ8kTHNU9I0ewVD07m6JJsX1ruVoMBCBiqWp6LDADzurcPvVoRrSvdPo3e+jLtVD7P6r5uvJLL2XjE+FfNe/JW0vHf6lNP1tti3+PCD2iyjZBIRkKZivXrmxVsYMCGxzL/5E8gsZ/vc+gnUeeyDxV2EYzHJ+1K88jnktBigtXg3Lg1QpCN09/0fMbxux+fONNTJ4zsTFJPKip07IJ6ymQF+qkSQcd7eaJ4L0HSId/K41GaYfWYQf3w2digs/BOPXeQW6NeGMHeNh3j44XoAMI8gcUS7z8ZeUSikWTUzjZoV7eeCbgM/CWIteYhkTwFH/8Yk1TmBzfmphTMcLY2kQLl16OFZrZLoBwPmbgsxK2ffJjJW7ItTRbncDjZvuOuV2qfhgESbrGzsbFyDK0MKiDtwgKu/63Ji0ZszRwQ4iEObqHlhHH1QXE9LjevPROXEOO4MYV5Wf10+J7EqDMoO/q1StJUe0nqx79YMUV05AUcBLxRUMbRmhV0wrd3FEOBqb+N8dpxDXdYaEO5bKjSY377MFxanOiGtngRQxBwPIc2RmUiuuDd/9O3mufYZtcuYWncC81BxStUzBNlc4R+EnVAVHx4JhewMVtXu9wTi+b7C3g8yU9/4SbdMPfWT16WeVFg898cu3b7z2Vaao7m5Mc9Q14ndDQWYldvBjwbz6bG5E/rafshn4CdrndvVqAic5N3jQ3/HWcUph6MluIfVeCfSY42ctMZ6Apx5FXM2y2csosdMj0SQ6C5ZYeZMSBOO0U6smcTzFwqLV1mgMWTXW6h9oVVXeBEEgesc4HgSKzVPFM7bqmqJTkNXZ85/9dR33e4dzzl4wU7G56RgrjTjJ1jfwk8alDZJOkHSoBp+Vmy4ImijYEU0CHQ265eHeHs4IpzMj/oKgGMMG1qnVOxaxHPUOvuELOfRRUvuPfz8U/XMoi/tYu2vG+oDqH88pMzDwMSaiNatom/Ecx1LwD8IRsUXQ7d60YdAugFMjvYARQPb0+j1qKsKB+kL4zUBxuD9uQS/uB3iuTmu0LJQNBVzaEej4kvbJjjFexC3ZshgM5Zsz9m1mD1/Ogzdi7Hq0VSzis4pjbmgUZX9AFlnL6Q4vdajGoS49bzPMv2C/m6BGLthBC0yVKPWhjGkUIvLu5jS8+6mHlN7SyY7xq8Wq9sT4Oei9S7iXrb59b0OM26XTSFTmNOn0+sVnQ0IsJCIdPcI0qIdiagR781PmgjYZ04b/Rio0tglOJpQNUVOjiu1j0b8fj2Sy8wXruNuhoAMOu0KQls55necgXqAX9vBXJHpY92QGTs99eRXezr4qDRa2ahjctXDN0uU6L4LiKRcd9sOQqiMYSuNtN8fD6StutACPYJf/ddhz9fpYZ8x3cKwVZ4TWWBavPnkdvjk3b8GvGnFYzLnNuJyIy5gpNpBGW7+6qcdr6NP8Uts+XxLPjF/FU/xkmjM2XgZZvpF9fdweQtNttx41RiaB0WY7aMwoiZiOMHxwkSXAkheq+tBMvwKCQOOnr4dVActSVyuhFj7RypbD+EIPjj3rc/zysRtpSQcI0oZvVFUmZunGp/2dGC6uL2ZiuLmqWE6vF7CTrwdGg1OXANty5qgKhrB+BqZoxsww09y8TKONPd8nfa0mxzRGZNwriKn7aSnicVTaerTGOr7LnxwUS3WEeUz4k/UHguLCNA6svATW7vYrnMPpy/JYt+eHs1W+uxWaMv/Ao5Hgy9eWui4ll96eXrRcw76/IWojqkiadCWV16uHaIvlj8jZqvb1Xh433WU4OuHD5UzLTfhkrk7smtsBR287I9VUTvX5WDd2aiqLpLkD7TgvfONqlgadVxpx0TanCz8Uab2DpbAPNnt1QAvLeRUu6Ood0Rcn47tj7LXp9GMaMcQQpjd6vsNhYZTYZ8VMWockDr2O4WpyG75FA9eSWmq5LKlwDnUsKws1h7woEeWZ/yj3NYCqCaYRs5QicWLKYC0y/++SfI/Vpi8RfvNv45Ph/DIxL4XKGfVLqdvN1e9nXH2Ib5x6U1O/o7wLhQq5t2X7kGooPAJMCMvEclfrN4TFnGOsxIx81hx9aJ5mxH5hxQ+YBBtcOOWeim+7LV1jyEevjcmVI1n0ueyCRjgdUe2dvMA7cVfs9VeK1ndFddzFhYEda6RX7jMNg+aNp2RYaON4xIHvClKkKMc4jMIuZBcC81NS/6kylDkoXGprxjzW0IpUJBRhjX5M4fFUzDyMxKqTusz8DTnM40zp2IufKv2Dacmzc4aFLKuRzPJFCILp0asLYikKVFMz36pYz0whOZ9n7j+r+76iK/z/I8V0n72Qavv17dfLnvFroFw/g53XEE279510K7NnjodKuROQrsJrP7kqOEKDm2VCS5gSBlBsKRgb9JKvIBpfqMEChNC28H9MLN19i2boBJ06lts2dvS26DJuADMUvwone+a3zQvL5C+ziKJlkaiawDcOrfRhF1z0t+5ORGDKLgJjyojCdxSH4wLEpmDIJOe6kui6Fv6DraS8bB9U4KGKj2ZTGzM4dCkyrh+oudDtM7VbO83ezeG+MyCPBw3sAhA5nyhcPDleCDxk1OVykooV2XY+g5F7gluY5cukNhy8VYulad3ehdP87KKNqY+VWRZmm9nUFuyqnpKK6QPqp6gsqD7man5SWyPbl0RXDewZxFW1BE8urUajc2UfLtMpvzcvB2o8JguDwzSa16oFqF1jVLJVcvpHim8JHQUx8Ki/hBBuPq7QdRW/U9dPWzoGSqC5yZmqP1oosPTPpeu6jyMv8Huj9ZgBEJiHw4mhuMy5UzHjvY0wnOk7T9VH0Pf5cB5HGLa7tq3jOzTYXf95LD5/fV42cy3fF1/633+gWa/ylp+NIAUMr4VDhs9UurcngDXnau1HNVBBW4Kdm6UpnS89jfeRNoucPLxwJFUkTUmLQ6+XLshYumQ7JW1BbYChtkIOwoEhXfNni+0UN/P3SEWPmoqJ3Cq1fLful+bIuXDnlU5wu4gmwTSewaWnG/25Z/mhG0RzN0dneDgIfL53PK8nOFrlNU/Ah863XOeL2fG1Cd7MkUMlbHnIEbY+IFp9GScjRhb0NtK3Wdmd5cDRDGPcup7FSqqxfii0zfe4XKjixxqvT0tAjCvm3o1dO8zzM8vQ7q/DksEopjqSWoEoj8gHpz8lugsA1hw2ch7TlZgfmArXzAaBhP1vbTFPqjVbRo21b27gn/XYrywuZBd0JSHnwEX4cOevWIpCDA4jLkyI3JqEqFKCBhHJuZA5vythn2hxX0JZjHidZ4c1IWQJ6qLB3ipzEG5ozpUuc13lW3tx5oRWSGIE84p8wsuFV2PmVoyfMiiXJVsojJOyA5rC3Dvlf1oO3b1gactckESprv94efNsPL8TclQ6cq0elbZpx7y2/i7YubAmESRnpCAF8q/Yad28DB0hSHZn0IjVgYNVJGp9jZZzrHY547PFvPcS/6sRYq2b3aGDudmcIOcHo1ToWetDaFbokvs9Xs0sbM6u2dDo5bwxnC1CT1box7WeUcZt2kFdjkKpCyf9fNf+RlX6+MM6/z8AuCKcxtRj7wzJRdt/fZz3ZvKdG3wE65ZMccIv7K551uN2/38VJkC5H28+QD5Ftr7ZK2IJLthkUlTr9D98pN9SYytob+oflJZ1ixlLVKVwP26uLI44jv6oZaobpecY4C+scnlXvJWS0vytUtAaZYXxFs3C974RVlWjxot9Kmmsxu0MVwyDyo7/4YChSqPZtLtwnbg4ljy22s+v6EDu6+Ccz4YeH0dQXEt231niP10uMgjIWgMBKUfOaV2LUQrRf6MFdfYlpRMKDrSK0/CSWHNeTh8/mJCia6Z54KCvv/oUJuagFx926QGnmEQGgusuuqsyo2Ya0LI8VdFsQxOD788CHHKZvUeb95dI6PPHzPZoVwyCYnao7tcSaCP4VmVzdnsiXQq6i6QPpboG/xyUGuu6eaD+DzoOucfpVNBrtTOzBBl1UfoLxcXDDvc3m4FjUjSWK4mW7+nxzPL2ozrc14IAz0BQRSuQzGix07Ns3/5ZNEjjsYWtDkPk1VbU6tiNVKn3rQddaGg64Wytsa3i90BcszLQPhvJoChEx+TdHpKjDdr0Zt6q6d4l4zfAI25Qz630FQPsChyfunkDnwZg/P4xYbOhJnyyL+DSH0yQ1UgWltyHuM9pQNL4VpBOOSk0Wgg7D0ddpB4zHJtnGyQstfSiRKq3dSMTyGA71uq/IzdYfMR8sjlhYlMme5Z9z1uXrFH9M9tU8ZNdPJE/xu5WQPXWzPS2OZjtNPeku7QkOdbuMt/LeILSlj6e1bvLQ+pl9dlqmNxLgy6eyj0C71PVxG7R98kxovtAQ0FCWnmQCFcJN/zABiCDlXyYIjU/tDF/7GGX/xw9pC3vhFEeeJCciWGy3xN+6PJT/arszTXMfg+/II9tDCuPYuS+lE+/br2dmLQMz51wIgHzXTp7ON4fTTSBhe8sppSvDGU/0YsEdKj9F74g0rLx5ic5lPl6qiwPdB7kGJ1A8A1GoylH6pq5W5ovqDzo297ZA6sRyJvGSYif+8nA5PO/FysjsXQDCz5dlEh16H2bZxxFzb+RD+WGioRdefMTLrIgMji2hTQjn2JMMuegis21+IHr/tk1HickC8T9AdbR+GLSr7O0HGq2+yNcFI1cFsjeFAAiJTgg806kDQ2x1+WhBOHzZALLlzb5eTWkr+xNHdT10bW4Jju2sACxsZ7dC9s3Cn0nZ68eIMmIh2AYVFpOtGQwn2p2Kc/o3S7bab0mxmirSAN9A/qf8h4iR9uhj+yhwbS+/BoWmdiwVteB+Tci3w6XbQvHwujNI+l6mgQpvoaFhBVT9x1ZxwsJa3gpDR7R5Lx/HV0wMDS0roLrVEnt67QSihsfNtvZJg1JSBv9xRC373Vtc2+Phvc+TS1j9v2w0moZn243AbOVwji0e3W8+5C45aJkfoimZlJ06YDz6uLBrWtmR+/gSywkLH3c67ed1GWnGPs/SE/7m977KevIqmcgfc6pmInSKcr7QOvIaxdrO+cuwstBMAXPaQT/lPWJ/X8uSaFKQlFKp/gN4uTX/bBQvXjpAdPSi/MQmnrNg2CJ3vDe4yEVF8cXykQI737jxNVuQy6CgL6a+1CJVRc6UGiyzaJtUssq6klhfKWEJoXi/Zi+bP951HwuMXN3AlxDzzHgxxWRF4OA+tppkB7HouVa8n5/NsPESnsWOAm9NKqDcdBGP0CSI1ZNdpB84bSSxsV/JFoGoH0sisPWFeV+NsBK3oYkZIEW+Ud/VdXMSleMVj/bd8n022v4wZjqQnJatjwzOrGiyB4zM1d6ebDrekixUQY2Xm4lgt7F2YcWecCUSXcbUSdZwIhp9Ns4cqVVvUVX5qB8eVQWTZrpJVIZezIhL7VhM9SbdmdF/kqYrrd59Pb8mm0tnddLUS+ufAljZ1sdzq30L7LE6WWeMcTk/hUGxi/cUCXDdaywoYKJoN2Q9O7C55NHuCRdXj38X77rxkFxhZCU5Hi9cem69hWQfeiy9KgTZIsiEjVBCQ3Lq3pKQTZtgXCfZMAQlTfa7uG1fVYI3oydd9YYZo9LJTiLU0JIZfEFiF9mXPhKQyK9hKGILrxFAAT0D0GHw7NTW2Dv8m04V4JdffbZSY5no/X4pnMBoC/BvQBQWtty0VosWEinlC1ouJvPmLQ9OSWfmIAFlN2NDfrdlQg8AogjpTyuJx1OZuQgkyO8+7f8M0b7pokr/KHmLf7LnRw+b/ekP6D1+Wh6U7U389RD3yYXwJafIWy6nttsMebCXPB7Mq/fUQd7MLtfTybSDfDCG2ys2ZRZzxdMrGriV0cMzITuiS+7Hk4bK4LFBjCgm9UzeALmLJD3zf1A2Xwuq/1T0kR8svWjVqWNi41yVrjj0kR2GSlmHOAnIYSw9xbZ6kWqM1NgbHl2p9GNZGBwQDMm4Zl1yMppwX+BORbX2GDlicgtTdpwXWJFh183MawCUcLq0YGWiF/b0NdvKN7EmXd+Pp1XLA6K122hKRCTPLLUbuSEJHA7W4x9XCrKApkRB+DoIRwQtK06LMGDTPPVAGiR7YGmxr3C/01cnejJCa+uSIxdCbptlpd/IaGngazfzmfg79/dWEb6/p0nYEdwLD2TAXBFb/p42YpvfU8HtbVkc3ur3AkAb31vLww5/Pqtiy86piW1ab5HkIwO4oiHNvRridZrWx/bEFJ3YrLnGgY28DEa/ctA3VN0wRe2AjayRYhMyhy2tq/Ei/CJ+I7yzmTfXG1GVjTjA8RI7JAtyk6O0Xoanj+GAfqnLEz8bwWbTfD6YZJOf4V6euO66+xrVsHs3jbteLKqMPGDM6mjmAwPNAQJRixgATA8XMo8opssulKEzyIb3vK7GNk8oBnnQa0bE76FQpcQRH6gyhn1e3sLQx8AyXVS2haWBr906zipiiOt8rzdHG0d61nsogcR0D7MDkgqchCILZy6nRatHHTIhKZdKNAh3c1GEtepIg61zRpQxZVvyT0GHoTIgW48KDgyCNKJgD0+TPTlJrsiGxB1XtlVGCtyzBLuDrawjEqHK0U8QjOgoJDPMlMhyowwUoC2oXWQCSXdDbnQjiaMAW3VF1bVEz06XGqjG7Hjv6xC+bae18c43CFK0rBU/O624cV2RNY2hrXGVseUnz66BunMNAabZQRvk5qGy+0jA7j93XGLUALBvyq+0QMC+X4MhWrjTCdGdYYC7KZdoUa8KW5954dV1zoG/GjZ6Weu3V/TzqwF9zopBqwstX4ovJuvUWe07eDduZdhQU/WmjEOiFzg+gYTsyKh6qefHTo/kxrOBa9au7pM0kAVJ3E5lQheZONZQ6j9yAhYF25h9yU/MQFb2jpeXdTS0pGHo/Zy9zC7KFTyHbXtPa+mPdQO47zWjE7+3fVMbKDAIvrzfXyygQ9x/IJyWP3oDRNCN9vS4r4WnD1RQTRHaNDP1unpwvWPajXhZXwZuL9c0ZBwJYLjGNLd409VTt18EIEVyfZ9l3pJQbUV4yX1HzOiyd8EAMYyz8uTck19vM1hu+JjP/h5Uq1wAwsunLuYMHpSznMQXeGhyJkWLx41+QHCFgiD+FY9k6X6791baecL11HS2y83WtxFYQapARq03clggKWhc57vtd/rICU2gK5ogL3waKhmsNn4QC+8lcEJBIR19cVU2+ZlOf2we1LFCOZuqX2mODLhQUKLaqGO9wTkHSGb7FbxwjIi3Iem9d7LxbgF0Mzn6ge6I1H3qAOzIr/RZvsUvbgvgR3/BrNEfLlvVGwlCPVN1ccts+yFD8g6K/1Vwryq8nDS/29Ubzpa9zdCYaQjpxhELw5LE04Sdo0zv0UyxNuLHZNTrloaLjsgCcQG5+kQVgowUl5f3mO1radPWUNQro5+mRfeyG3YabkG8iz5AZoyfd2hAtQKsyGTdMqMvyh6Qwow3JbMSnSdHHENoyqeyha/GLoNZ1VkW4J2Fp93+/SUAS5QhNs3Cc2Pr1w0ihVOkzdh1E8l0IS/uqvr1gkKSNLEP4K4m53tHFA816tSzCBlSe67VpQMzcnLTZQYxkTxtJcj6fLxG9DaN/6zrLRYXHc5M3cU4w4ggKovTrIbwlBa+JtzgMBGss469W4sgPQJwDnQ+1bNIZBhlXoQhObbPxyXIxuXk+hQfdbPg8dS0nKmPmDRORoyTr3IcGbh8bnnSoQs7FE5KDAGmm2VUUQTPP1jwSMy+8zWXJY7kYo9bzhtShjKMyCxL6mMPX2u23PBCk53Kboj9GGrjNIWqjKRznx5DrEdP17vIbCBKL4U2ysQbwZnPTewiCA/RqLPa5NrWBnl+cDvoa+/xLkvmJXDjERCljU540kkHsoVoOCcehLP+DsbhhU7oJtca1tnC13Adu5fB/OY9vq91rI6MoC1cIjPaRehqT1ddWjyr+rWKT3GETNws4Mvl+vS1hEiNgRH76I4uM08IqyJSQhcdsglbhw8cVtSzfLWy2A5WuCmvf4ZbIbNxEw4oposYq8sHXfDk71TVlR29sqen1X4/n+9AYl9fX6emVEYuUJRs6Vjmo27poshC9nEvmmXmWUIQCAtM6JuqOsiCVnfp3IJlepANormdyqrqhlZMG2hAX6FUlgXjQ6+CaSzkqwxIAgp3aNv59qE/ML5H0VaXGGQsBTzN9cRWCzJZ2SYxCzygjGuXPeq3n7Vu6ePqpVnSSMoWgovrl3t3fz0azapsrH5H0hdadY4kEGHiYuq3DrUvIjdV3mQVc5y3fddod6QWVqxR+oGliaaHslmuKe4gLarlJZeUbgjDwIkoZXGCbDiVTZ62M/+m0txMi/3OPVL66QuQAamRPF3qi2cXgqoIHRnx092MfO7jDDneYmAe864IFRu4u41iwTVL+eeTRwzANJo/cFgR3waKDMIkSfxoLXYUSOAqxyIVDyzZihL50hs4VGV0B3PcCraOJYqvHfVnSgQGdqQ3PjPpDIDSfIU8tVhlgDluhnlRuMyUL+Ya+hDdRJ+DcogzquhFKA/W2MFw9B+dJo0IBoNCkW1lxO8dHNnlcFO8OKuauccXKSqzIAG4YhYldevs4sLeROE8Sy7enj18rag/+SXqXIz/k09v4V0GpAptIcuIAZPoaVCmxYhmnvF7Nu4Qr617iXTWK39EkZdcez1fa4m5TmDKIOx0MSIQhdhv6USLWBekCt0Si0WTA4O+eYrpIE9uB70QjW2fvR8Qliy+djQfsRZ1bCEz4+c/1uVAj5RyKkmxlrYogHyhUter3hBRlwNirhvD1ZuYllm1R+dUr+rpdxstqD7QpVdyybFTcEXDAczL9r4BCAyzkmWEOR+ARGEbGpXkhEujAZJGguUSQLXXGlKSZZfKksbLlqsuYufL7aZjUQ5x6606dit0C65cOGBw7KFXVmULKWGXQjVlunDzgCdbpS87poK9Hxpa65PolY0EcYwb3vu++d1Q6pOo10Tbv7MCsiLBOTvGa4a97nVWkrX8rEg4ylDP3tUg7o3lga/Bjrt6wg15ynogZmjjSZEKrdkNaZBz9roWj/dqAEjxTP7Kg4xzj8rIgT0uX68UpjpQQC+mns/9YYjV4eQ17/3+CGZGZiNE0xnPGCW3nyKSgCXd+op6A+LwTM9YIk6ADAYkbSV6l1Y8TcYP/EN62mH78BttlRqD5T6ARwv/dJaskC763m3+zbWqnaMcX8HNU2yLej0CFVeYJ/i2P+JcveVE92ByfKRi9W3Jfx54R5dVfVtLgZVjKj3U2+YmMEcpd1Os38birK5SGaTt8xpttOfo/KXjOcKplWiidO9SWvg/Mxgsy1neudkS7yOEFn1rcUKLbZJ5n3+4aNn3jFSehhXpCLR/S37w4+7LxccbpHLALeenFhbfyyIFb34SvlvT/+KX1v3eW1pFdWsUOxaNi6im56kvTs3Kupr+2OEW7Fi6K6GqG3WfHsf3CR+orm8uZ5S0raBy3q8KvumboyqyKsvTRZwq6RxtMb4y1XWj7iu0QorakaYpmyaH049irxWpbDscJTUrcrHf55NXlNY9R7FWR3f3z+0QsavhUGnXjoOVZE51UlpVdOUtrXRNV+LS1SL7QnwutUOVyWMtVF5t+e3Lwd03OGLZ8qyvHkF/KuavVeG7ijU7o+I94coJJBp0ux6aVf1luegrsxlc7/q9Gwg9k9sgbis8P1sNmdJUYrEZfNVLr1D+j67lYsHTzrdH9P7C10oPS1SmBkgFRNac9BSH86SAktWOp04+nNV1xqFzo51KvJXEFjKAspoYzv3e6ZH0FdzceWoFCwC1dP+z43B8n32oC3CdjzIqX75cmtfjyfFTjPHrmIP+aRRe99Xob23SzjHgP+jj8+/3/dQU/4I74VyrDl6VUiXI1Esj1K0QMncLU8aXY3P/eW+gbsF9puepDiQdgC1QcwptgSCWdiTjwK/DR1gYWxZvl/5cqF8gjnE/kaSTpMiBflK68SRd6HRM2o6v0aofBZmFXfHPeu1IQSNU/sBX+Qe76iZTbOzczfmJbVGAhKE3fMcsT4tqUCMTuSfSy71Sz91/msM/860alRXa3D4/Fra+I9NS/3SAVq4Br3cE6vOsLDp0SH03fzUpR0SFwc87IaEEFcqRO5ZYvnCekQ6nHrnScZAYPjSiZkCpBk/lK3KDGJsGGlsHFjsMUuy+2SXShKsaXlVU3SLTOMNDDpjH1bO0nzDMy/rfzZlI7b6mXxNflJZc9A+tk6DetwclB/fnvtZsYpjDHuVisMQf+hyRiFHcyItc4Rh+X8v2ekwnnYNj9oDqYigzidRFUkekriZ1ifCTCQmLGevSE5LJWKaa1BNIPYHU95YPXeLUnBFNCPEqI5EhKn8nkO4u7/klXsTDnnO/q1z0nG5/DcF8gYqZFLe3+Fb73UXJCC8WUUF/WXdIaFDIFuve4P3MsfKuMqA/qKu+UH398b55370fxZ8y716spuQIOPc/oRPR+nlsdTgwedTGXQ4S8bs6ii3x/82UritsKeEtL6EVdQONkzGkZ8fqZeAfVEXqkNQRqRNSTyB1BakTUh8waIrdPoPBU1DlD6KKffnzh7pr8R+j45O/8eOXF3JoQxOlA7jZPjwby/Ff+jGWmdAv6QowmqIEOqw3puB3+NegWgN3KkrCHChVHWkw8UDgCF5OuQVu/pN2yDMUGaECCzkeUK7/b2N9KqDBB5QyRn1BBG87AQmey5VRV6aoHCWku1q1viy4b9hZDUFDLU2ICshUktit/jqqHkE7HsFYldLCJsThBSGPrOLDpy3RLWHDdZ3m84EVoeVkOKAllHHcRDZdqhS5iFKWEHjuU3qzD7bxH2gAS+oq9GYhZ3aoFIis4KY7EjzhwqjMKDl8TDiXZvDtRz57Ds6y+RLM3+LszkGOqhdQtWl/JZDowNOQcnlAtfCTrCjsEJHwtraYU3gpYjvEnM6KgS/oKzZTWlKewui5Jk2J33/ZrP2S6H6LnS/z3RWWvtZVBIkzCpuNmJljePhSHgvMe7l3yrSqiHIecZnSaCjRFv/1d8BqNU3FEPWmRQ77bgqVfVJqSpEkn9u0y7CdujTADFFbHaJ1aTu07ASlOjqEh15LH+4L2pcLUzKvaumUVYyF5Dzgy1jJT38ONy4cqP2KLJWPQpjwsF5kueBDJhLGY1bklcpIZmuSUICxRU7Y62wmhTPhcLShRBo/zPrnshSz75/TygbLkcQgP8yahOz44Zr2t4HWSvcfPelUqWT9y8jj8YAVyztw7FQ1KMeMOydxm0GxowvILhyBgrBKBCSXCMf2BCl2B9AHS001DV0+iKZpHR5IS55IJBNYnDNSxkSufWV0qETKgv3p2uDDp8sgkUrEuX/6P5fg5AG7AlIco6riotySZWC9rodasimcR3LOWijRrAvDWSyri6BRz3R4EKUebV0ybiSkz8mjMKBqbh7bFTROCzIglT6QTve04kx95TQDVFKIj8NC6CLVwAng+ylZfA4RLAKop/kJEOJL0cmgyD2FkXg6mdDyExM3RfkFUVuAW6ewwXYOpr9AlHO9vqEJtr/pC0lYInc9W2mNeHiiZKDLYBT2dIz5hQHjt384GXXUJf5eT5ud3afv31ioOyfJUzbXKNu6rNTinDyn2XJXKBFNJ8FgJkNPfibAH1lMk7Hq5nLIs063fZz7EB9etwvPw1zHNi48yJvO+BmCQBmfOZ8CMX0OCdXKAp3zvmVlC/KCxiBxNUY+aq3N2uncuJ7v2VQbROFVNu36N7TvO0zrz5RoyowFPNBFQLUS0JlunMW4aYpUj7/oTCRe45H9RXZ7F4MeLljPYASyTLPzwk/5ZrwMwmQbsKsprqjXujuN/lkuaWPM3ph7ds/uW+u9/YCGR7hq4oZbsEwaaUOTQZh3gfyek0Efk7HYV7+jPmAEsQpq9fHXumqvUYnB7jKUYi/BdXfwjcW6+qbnQl01xVu6S+6Ki1uyihzTALo8rOw2S0nKPKY9dv2Z9+m6xspG52PYU18xz2SsZxT98RA/i9ALVdbRmFZ2ZZkYJ6mTv9Kn0OxbzQfAnLQWQ2a2F93qaTRROqievtBtJg1m0shpC+dtmcYRMZWVS3pugX/3iHTtjV2k9KnI6BoE+OFSR+YPFmX2bA2o3YmpAxDC73xlTdSIDkXMT78WdATuxHMuxKc85ZbZ2tpiT2VaX7WQlhzfE3PQm40j15g8rhVLAVhmlfn0j/zn+B/PlrqB2sm5qG9Pf01fSP0K+0KATv5jEo9hfiftX/qMa/Fhzl95yx+J9t0kZ8E+yV9S0t2yxCtqP0YfEKr9I4/29CwT78P+Dej2cvI76aZqSmtvQeLoDZSGuB1DyPQHFJqDFaYu74f0tE/U9YRar0CnayDWJRDpFYRN16cxAKdZPlDtm7hQfM/Njf2NAb5V/uncLtKzfbt8y/O4xO03WRrTUm4YgaGdXmFg2xta2s1j0jiMW5Lxm6MdEFgnoNs/sqwdaMAagtqetbmu4jYhJNuzDBJCNTl6YUd2y8bh44Gj+a+c5/KUwJEfmd2ycfgj87NUvrvSbqke27xsmCT/ctvdU8V0iUtSZEzMbLkfTNcOp/c//WDTCqwzJ36waQVmQN0PNq3AOuHhB5smwFvGZWQXwM8e+liHlJGEJw1JZ3hqdOb30sy4sY9GN0wPeivtZ8dKs8fdFZxD+idlB/KD6TJDZyVZ8YNNJlgzbvxgkwlmjN8PNplgnbDxg00mWGNs/GCTCda8ID/Y5KGohc9z292EfgIyBd6CMm/cNUiSMQ2Zh8sYKw5qAxnGhINZfizDpcESxq9D5uEzvSBQJiNk3+HERI1yaBvIoI867ii9zxjnKYdW9ux0LkI75AvWC05r/NvVETr50UQ65GwMQlEx7pJyqwctus3Ftm1djfjuoTwsh89r/333sC4hfVBNa0el+jemlWLq33UUfN+c2lT9Ra7VpPyEeRd/NX5PF/B3bZDrOr4fYO0s/08EZ+UacnkCMJD7oX0I16GTB3X9DVLQhuJmjeZcOZP83C0fAu6kS+VOl8uTBzVHvQ52Pi4F0H8eN9vvLpCXeIHSED8OufNp+3Iu9W3kCgIwL8Tq3bnxcIkEB18/D5R3eQPQx9LzOZwPfh8zZH+XcpCH+sWfgt5X8GUP0kUHXCGYfN09H0LuLlzqKu5Dzz/AhPTxDEhdhRT+gQYXlNySeMg/WOC1jCdV0nH2jfwcMR506rLFZ5axwaVEgg9IXQA2Iyqzk6OiqoEok0zF+8btydyCdpINM+Ty8h5bwTzzcUWUt7CX4A5tFns5qphz3Z3qMlPxbimPTxGuGlsj1vE7gUfNW2TttrY8Y12RmWd0nFTtU9mAPXqpRYyItMH2OV9xMbkF9nXg+V4rUuZx5MBg8sMBZWC5V8owjr3Y7nmAz6JqjjhcZF2aN0h5GSd8iCT7jjZO0ctOE7mZTTfNfOKIyMcaWCRhQ+S7YJmxDZldsMjYhsw2JLgQGzL7+Ao/bcisgm172Fu5BK9bGPzAbEYpj7sXvXZfNXg9ub5AniVzjPsj0UgZo2yI/DJS6SuQDZk7kINmQ+YOTMSAiTOw1NmHyO9AdqENmTuQ22ZD5gaM5tbgCLZHNlxilDd42bMSOcZGI9jeWweMkIfKmJl7sXPeH2TmHHen1IrDHpjNXM3XS5Rg5MwHySFPK0IEVsWuyI95iodO8Zgf6dBHOnPbY06VeoHH58rQ0itVZxRShZlWeTb4xQU5blXtT+Q/cxjQSR16JhUuC8NewmVfOBJWYakUsJcssL5jpYBNBjAbJSJInAHbFR8dsof7XlcSEY4kw8qeaJPVIzmHvNdqKOXIlFIha9JWCthLkwiRjx4HmxZg9bJKAZsmQLmbONjkAgP2NH61n5gwEcQr/NnBjz/EVL7nSl/syEdK46WR8nh5pDJiGUmHVORai3QGrEtq07tk1DRIUmMflUahUWXXpe/LjQvX0oJ07ztNuLrmXqXvflTpkVlVz8M3WKWeVo5qHQQVnmTU9ZBRIcQECMruKVHjKllfD3rfE48/hoOlqvdqfgwr+ORmsS1EgkAmGqy2M+EnP39JRaKRsKzqvgZlO42/e9qj0iFGc4DwErTny01eAC/zfKWpo8aPps/XmoUlr9RvjxgelnWBsWlYSvvFhN2iT2/7YpxSADAljEH678AwYvVzHhuvvp2qxOCYbNpuu/NlNOKbvW+cUqlu2qsIBzIfoK9ZIP74KEXkrtXqwlCDCfEuaHdX1MTUHD02d+MmdnP+eiE5k/NPFzJn5vzzheyZPf9yIdc8WsCSg1emcTqljoM9+Uh9N7gLsbmQ2IgHabCh7nd09F1s/dZ5F7/T1UQSKQg37ajdXTvyiHdDNW3ROddICRg2ipmDXnI/eQPZ6cfOMxGrt4SEkYRXErx/nzfg5NF/dhzbAWP7u6b8RBj4OFA33P23MQ0RHyDEEO39C++6YsoLsLodbGSTRg85aM+4CwsuaHug0QnRHSDOxjiH4W4qZeR67yPjRCV5hEA5xPpzgSVXYxlJyanFkQpC8Byf0uluYVrLoaa6bq7F3GKYMFSW7bTISOGNgoUot1rZBpgg2qWcFnmPVlBjuuXaF50KayAV6//xHHS92J8Wpxp6Ru37ojtIHJLFbY/lOhCZPvz7L+r0FMF2OHtBewO33zXua6rznynxzyH52IsbrX7nMSJumDRCI12s6O5VH5crr3WkuISfrEAWr3Y+KOtzvLa+XZ6/TW5e5SJxOiU0UcRBfluhCUXiHU2/8F9Cj7O6vul1P46tRI3/0/mSzcHeK/tBpeattiU8sc0OU/uDDUqV0CnK72GczsBzbNrtVLV5SXvFthZf6QJMmvcfSttMkjsQKZyUDTa5IQWPssHGCa2vZ3G7vbjR9c1j3qZClOGUF5HPwf0Sj5wdKMUNssEkhxKgFCXIBptDgeTaZ4PNjPCxGFLKE62lUKhDBKiazDhMCVO/TARAXBJBLgMRRkfw/tMByzUbmXWE7z8ckPoCpCZY+kljNMNlFtsHcsjrm1WWKnj/Plf3CO358zLPX2pCgWIc8b1Ub/1FtiTmd3IZm8ly0HHSDBxc6eIQBEeMFc+KSVpxSdjUTUvzP0xhebFTj7JupINUdYWczS2DK8si1kJq2B6bBCNkKDURyxGtYv0V6LJg7l2RroflSnYdqWgPmy87ALZwg1ukIS2xERM1J2kloJEC5QheZwHFFmK/9sTXhCTTpDB+KxMW3P6EEizYxKT4kJFt62L+RnaoHRzOPk0TbYdxFeQkWZ/5V5OM+niU8MFRvq2VjRIN7Fufx1k+REqRTkgp/so64zlrw3iF4sIiwu/td/5tg3m7MP1BfKi74spCrm5ONDJdeUiScxYbGm8s1J57TH/N/Zk72QMNkI1n0gM5H458yLfM30r/XoNBKhtIhRwKNRZKJ7Qgn/uR83/BNDWv8Tf8T9l8qC0Q+VDSYEyf/zN+ezP6RRB9UM7xt4oimg6C+UA8pHT+/nAWuvcQ9XAQa4LUBdEF0QVRDE0phigD+UaIfmbT6rnvpU9+/LeN8v3K6fnvn1W+0Uz/j8bSVD5jrR9vXw/H+nukf+k3n1KqouBLYDV7SfctPOuvbH+mf5ISX/KuGFVoOHa7OCQHqReTIyeSS5PYNA1yq6TUJAreTDCieXjCniuuadPntmRE0WMx5drEAVDExbo+2SUqyFneyIYcrQIThFoMTlpWtz+L+waQXY3UBEFzcU5Q3ceCeR9E68wfIBqSVRQubEcXdam/wWIlygVfoAk3CwF3CyglTdc3i0Fs/kss0Lm6KqmjuSw3deFcVskzqXyOYcDavN9q8C9QGcPbzbw5dzY4Ndm6PY7o3fMin1dBboOCY3GAfJh19oRzWdzicOZd2O3HXweSNMb8EjMLauNPQEaj1PgJO1kdUOUIjf6qP8QjJR5qyOfy8XLIqxlupXZS8XGre7KgvpTyIa3of/Sbr8HFl+QWAP+fyuKaZ/xbUODz5GXxBYmVFky2ZwUW/yH3uBldNZDI98msvNBPEkMfr1/YMMLhCI0GGmzZ4LhnWYf893ywIkbufZ+6XO9HQYWR51RuE3+51UOrVMBGCnCsRVrwQQQIaGysh9+Km32ebQorFHeyDt06FxX2ytmouO9p1teq3N2ZlvxVZYR1vhqC4Xq65no9jvMErn318qJWXi0=", "base64")).toString();
if (command === "status" || command === "wait") {
  const handoffs = command === "wait" ? await waitForHandoffs(dir) : [];
  const { text, failed } = await runStatus(dir);
  for (const { name, text: message } of handoffs) {
    console.log(`${name}: handed over by the user${message ? `: ${message}` : ""}`);
  }
  console.log(text);
  process.exitCode = command === "status" && failed ? 1 : 0;
} else if (command === "export") {
  const out = resolve3(values.out);
  if (out.endsWith(".svg")) {
    const svg = await exportSvg(dir, values.diagram, values.compare);
    await mkdir4(dirname(out), { recursive: true });
    await writeFile3(out, svg);
    console.log(`Exported SVG to ${out}`);
  } else {
    const { html, names } = await exportPage(page(), dir);
    if (names.length === 0) {
      console.error(`No diagrams in ${dir}, nothing exported.`);
      process.exitCode = 1;
    } else {
      await mkdir4(dirname(out), { recursive: true });
      await writeFile3(out, html);
      console.log(`Exported ${names.join(", ")} to ${out}`);
    }
  }
} else {
  const service = createDiagramsService(dir, values["allow-host"]);
  const html = page();
  createServer((request, response) => {
    const url = request.url ?? "/";
    if (url.startsWith("/__events"))
      return service.events(request, response);
    if (url.startsWith("/__diagrams")) {
      return void service.api(request, response, url.slice("/__diagrams".length)).catch(() => {
        response.statusCode = 500;
        response.end();
      });
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(html);
  }).listen(Number(values.port), values.host, () => {
    console.log(`Diagram canvas on http://${values.host}:${values.port}/ for ${service.root}`);
  });
}
