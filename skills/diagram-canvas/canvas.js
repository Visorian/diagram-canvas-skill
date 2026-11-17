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
function table(columnWidths, rowHeights, spans, channels, extra = {}) {
  const rowCount = rowHeights.length;
  const starting = (axis, gap) => spans.filter((span) => span[axis][0] === gap);
  const ending = (axis, gap) => spans.filter((span) => span[axis][1] === gap - 1);
  const stacked = (borders, axis, count) => Math.max(0, ...Array.from({ length: count }, (_, index) => borders.filter((span) => covers(span[across(axis)], index)).length));
  const depth = (span, borders) => 1 + Math.max(0, ...borders.filter((border) => border !== span && contains(span, border)).map((border) => depth(border, borders)));
  const vertical = [];
  const columnX = [];
  let x = 0;
  for (let gap = 0;gap <= columnWidths.length; gap++) {
    const channel = channels.vertical + (extra.vertical?.[gap] ?? 0);
    x += stacked(ending("columns", gap), "columns", rowCount) * groupPadding;
    vertical.push({ at: x + channel / 2, room: channel - 2 * trackClearance });
    x += channel + stacked(starting("columns", gap), "columns", rowCount) * groupPadding;
    if (gap < columnWidths.length) {
      columnX.push(x);
      x += columnWidths[gap];
    }
  }
  const horizontal = [];
  const rowY = [];
  let y = 0;
  for (let gap = 0;gap <= rowCount; gap++) {
    const channel = (gap === 0 ? 0 : gap === rowCount ? channels.bottom : channels.horizontal) + (extra.horizontal?.[gap] ?? 0);
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
function flowGrid(diagram, extra = {}) {
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
  const grid = table(columns.map(() => columnWidth), Array.from({ length: rowCount }, () => nodeSize.height), spans, { vertical: 48, horizontal: layerSeparation, bottom: 32 }, extra);
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
    groups: outermostFirst(spans, grid.boxes),
    channels: { vertical: grid.vertical, horizontal: grid.horizontal }
  };
}
var blockWidth = 3;
function architectureGrid(diagram, gap = 48, extra = {}) {
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
  const grid = table(Array.from({ length: columnCount }, () => nodeSize.width), Array.from({ length: rowCount }, () => nodeSize.height), spans, { vertical: gap, horizontal: 64, bottom: 32 }, extra);
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
    groups: outermostFirst(spans, grid.boxes),
    channels: { vertical: grid.vertical, horizontal: grid.horizontal }
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
// src/diagram/scene.ts
var labelHeight2 = 20;
var labelLimit = 28;
var radius = 8;
var aboveGap = 3;
var besideGap = 8;
var nodeClearance = 4;
var lineClearance2 = 6;
var labelClearance = 4;
var step2 = 24;
var calloutReach = aboveGap + labelHeight2 / 2 + 4 * step2;
var maxGrowth = 3;
var sequenceLift = 16;
function shortLabel(label, limit = labelLimit) {
  const characters = Array.from(label);
  return characters.length <= limit ? label : `${characters.slice(0, limit - 1).join("").trimEnd()}…`;
}
var round = (value) => Number(value.toFixed(2));
function roundedPath(points) {
  return points.map(([x, y], index) => {
    const previous = points[index - 1];
    const next = points[index + 1];
    if (!previous || !next)
      return `${index === 0 ? "M" : "L"}${round(x)},${round(y)}`;
    const r = Math.min(radius, Math.hypot(x - previous[0], y - previous[1]) / 2, Math.hypot(next[0] - x, next[1] - y) / 2);
    const before = [x - Math.sign(x - previous[0]) * r, y - Math.sign(y - previous[1]) * r];
    const after = [x + Math.sign(next[0] - x) * r, y + Math.sign(next[1] - y) * r];
    return `L${before.map(round).join(",")} Q${round(x)},${round(y)} ${after.map(round).join(",")}`;
  }).join(" ");
}
function compareVersions(base, current) {
  const comparison = compare(base, current);
  if (comparison.changes.size === 0)
    return;
  const reserved = new Map(base.diagram.edges.flatMap((edge) => {
    const id = edgeId(edge);
    return comparison.changes.get(id) === "changed" ? [[id, edge.label]] : [];
  }));
  return { ...comparison, reserved };
}
var intersects2 = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
var widened = (box, by) => ({
  x: box.x - by,
  y: box.y - by,
  width: box.width + 2 * by,
  height: box.height + 2 * by
});
var spanOf = ([[x1, y1], [x2, y2]]) => ({
  x: Math.min(x1, x2),
  y: Math.min(y1, y2),
  width: Math.abs(x2 - x1),
  height: Math.abs(y2 - y1)
});
var lengthOf = ([[x1, y1], [x2, y2]]) => Math.abs(x2 - x1) + Math.abs(y2 - y1);
function arrowOf(route, size) {
  const [[x1, y1], [x2, y2]] = route.at(-1);
  const [dx, dy] = [Math.sign(x2 - x1), Math.sign(y2 - y1)];
  return {
    x: Math.min(x2, x2 - dx * size) - (dx === 0 ? size / 2 : 0),
    y: Math.min(y2, y2 - dy * size) - (dy === 0 ? size / 2 : 0),
    width: size,
    height: size
  };
}
function leaderOf({ at: [x], routeY, box }) {
  const bottom = box.y + box.height;
  if (routeY > bottom)
    return { x, y: bottom, width: 0, height: routeY - bottom };
  if (routeY < box.y)
    return { x, y: routeY, width: 0, height: box.y - routeY };
  return;
}
var fineStep = 4;
function stops(low, high, size) {
  const middle = (low + high) / 2;
  const fits = high - low > size;
  const from = fits ? low + size / 2 : low + fineStep;
  const to = fits ? high - size / 2 : high - fineStep;
  if (to <= from)
    return [middle];
  const count = Math.min(fits ? 8 : 16, Math.ceil((to - from) / (fits ? step2 : fineStep)));
  return [
    middle,
    ...Array.from({ length: count + 1 }, (_, index) => from + (to - from) * index / count)
  ].toSorted((a, b) => Math.abs(a - middle) - Math.abs(b - middle));
}
function ownPieces(segment, others) {
  const axis = segment[0][1] === segment[1][1] ? 0 : 1;
  const extent = ([a, b]) => a[axis] < b[axis] ? [a[axis], b[axis]] : [b[axis], a[axis]];
  const covered = others.filter(([a, b]) => a[1 - axis] === segment[0][1 - axis] && b[1 - axis] === a[1 - axis]).map(extent).toSorted((a, b) => a[0] - b[0]);
  const [low, high] = extent(segment);
  const pieces = [];
  let from = low;
  for (const [start, end] of covered) {
    if (start > from)
      pieces.push([from, Math.min(start, high)]);
    from = Math.max(from, end);
  }
  if (from < high)
    pieces.push([from, high]);
  return pieces.filter(([start, end]) => end > start);
}
function candidates(route, others, width, obstacles, below) {
  const segments = route.toSorted((a, b) => lengthOf(b) - lengthOf(a));
  const horizontal = segments.filter(([[x1, y1], [x2, y2]]) => y1 === y2 && x1 !== x2);
  const vertical = segments.filter(([[x1, y1], [x2, y2]]) => x1 === x2 && y1 !== y2);
  const place = (anchor, x, y, routeY) => ({
    at: [x, y],
    routeY,
    box: { x: x - width / 2, y: y - labelHeight2 / 2, width, height: labelHeight2 },
    anchor
  });
  const nearest = aboveGap + labelHeight2 / 2;
  const distances = (line, direction) => [
    ...[1, 2, 3, 4].map((count) => nearest + count * step2),
    ...obstacles.map((box) => direction < 0 ? line - (box.y - nodeClearance - labelHeight2 / 2) : box.y + box.height + nodeClearance + labelHeight2 / 2 - line)
  ].filter((distance) => distance > nearest && distance <= calloutReach).toSorted((a, b) => a - b);
  const across = (direction, callouts) => horizontal.flatMap((anchor) => {
    const line = anchor[0][1];
    const xs = ownPieces(anchor, others).flatMap(([low, high]) => stops(low, high, width));
    return (callouts ? distances(line, direction) : [nearest]).flatMap((distance) => xs.map((x) => ({
      distance,
      placement: place(anchor, x, line + direction * distance, line)
    })));
  }).toSorted((a, b) => a.distance - b.distance).map(({ placement }) => placement);
  const beside = vertical.flatMap((anchor) => {
    const line = anchor[0][0];
    const ys = ownPieces(anchor, others).flatMap(([low, high]) => stops(low, high, labelHeight2));
    return ys.flatMap((y) => [1, -1].map((side) => place(anchor, line + side * (besideGap + width / 2), y, y)));
  });
  const preferred = [...across(-1, false), ...beside, ...across(-1, true)];
  const [x, y] = route[0]?.[0] ?? [0, 0];
  return {
    preferred: preferred.length > 0 ? preferred : [
      place(route[0] ?? [
        [x, y],
        [x, y]
      ], x, y, y)
    ],
    fallback: below ? [...across(1, false), ...across(1, true)] : []
  };
}
var extentOf = ({ at, room }) => [
  at - room / 2 - trackClearance,
  at + room / 2 + trackClearance
];
function roomFor([[x1, y1], [x2, y2]], width, { vertical, horizontal }) {
  const y = (y1 + y2) / 2;
  const channel = Math.max(0, horizontal.findLastIndex((at) => extentOf(at)[0] <= y));
  const inChannel = horizontal.some((at) => {
    const [top, bottom] = extentOf(at);
    return top <= y && y <= bottom;
  });
  if (x1 !== x2 && inChannel)
    return { channel };
  const gap = vertical.map((at, index) => ({
    index,
    extent: extentOf(at),
    distance: Math.abs(at.at - (x1 + x2) / 2)
  })).slice(1, -1).toSorted((a, b) => a.distance - b.distance)[0];
  return gap && gap.extent[1] - gap.extent[0] < width + 2 * nodeClearance ? { channel, gap: gap.index } : { channel };
}
var lift = (values = {}) => Object.fromEntries(Object.entries(values).map(([id, value]) => [id, value + sequenceLift]));
function lifted(auto) {
  return {
    ...auto,
    connections: Object.fromEntries(Object.entries(auto.connections).map(([id, connection]) => [
      id,
      {
        ...connection,
        points: connection.points.map(([x, y]) => [x, y + sequenceLift]),
        label: [connection.label[0], connection.label[1] + sequenceLift]
      }
    ])),
    groups: auto.groups.map(({ id, box }) => ({
      id,
      box: { ...box, height: box.height + sequenceLift }
    })),
    steps: lift(auto.steps),
    timelines: lift(auto.timelines)
  };
}
function placeAll(diagram, auto, settings, below) {
  const sequence = auto.steps !== undefined;
  const nodeBoxes = diagram.nodes.flatMap((node) => {
    const position = auto.positions[node.id];
    return position ? [{ x: position[0], y: position[1], ...nodeSize }] : [];
  });
  const headers = auto.groups.map(({ box }) => ({ ...box, height: groupHeader }));
  const boxOf = (id) => {
    const position = auto.positions[id];
    return position ? { x: position[0], y: position[1], ...nodeSize } : auto.groups.find((group) => group.id === id)?.box;
  };
  const routed = diagram.edges.flatMap((edge) => {
    const source = boxOf(edge.source);
    const target = boxOf(edge.target);
    if (!source || !target)
      return [];
    const id = edgeId(edge);
    const sx = source.x + source.width / 2;
    const sy = source.y + source.height;
    const tx = target.x + target.width / 2;
    const ty = target.y + target.height - nodeSize.height;
    const points = auto.connections[id]?.points ?? [
      [sx, sy],
      [sx, (sy + ty) / 2],
      [tx, (sy + ty) / 2],
      [tx, ty]
    ];
    return [{ id, edge, points }];
  });
  const segmented = routed.map(({ points }) => points.slice(1).map((to, index) => [points[index], to]));
  const lines = segmented.flat();
  const blocked = [
    ...nodeBoxes.map((box) => widened(box, nodeClearance)),
    ...headers,
    ...segmented.filter((route) => route.length > 0).map((route) => arrowOf(route, settings.arrowSize))
  ];
  const clear = (placement) => {
    const leader = leaderOf(placement);
    return (leader ? [placement.box, leader] : [placement.box]).every((part) => !blocked.some((box) => intersects2(part, box)) && !lines.some((line) => line !== placement.anchor && intersects2(part, widened(spanOf(line), lineClearance2))));
  };
  const crowded = new Map;
  const edges = routed.map(({ id, edge, points }, index) => {
    if (!edge.label)
      return { id, edge, points };
    const text = shortLabel(edge.label, settings.limit);
    const reserved = settings.reserved.get(id);
    const width = Math.max(settings.measure(text), reserved === undefined ? 0 : settings.measure(shortLabel(reserved, settings.limit)));
    if (sequence) {
      const [x, y] = auto.connections[id]?.label ?? points[0];
      const at = edge.source === edge.target ? [Math.max(...points.map(([px]) => px)) + 14 + width / 2, y] : [x, y - sequenceLift];
      return { id, edge, points, label: { text, at, width, routeY: at[1] } };
    }
    const route = segmented[index];
    const { preferred, fallback } = candidates(route, lines.filter((line) => !route.includes(line)), width, [...nodeBoxes, ...headers], below === true || below.has(id));
    let placement = preferred.find(clear) ?? fallback.find(clear);
    if (!placement) {
      placement = preferred[0];
      crowded.set(id, auto.channels && roomFor(placement.anchor, width, auto.channels));
    }
    const leader = leaderOf(placement);
    for (const part of leader ? [placement.box, leader] : [placement.box])
      blocked.push(widened(part, labelClearance));
    return { id, edge, points, label: { text, at: placement.at, width, routeY: placement.routeY } };
  });
  return { edges, crowded };
}
function scene(diagram, layout, options = {}) {
  const settings = {
    measure: options.labelWidth ?? labelWidth,
    limit: options.labelLimit ?? labelLimit,
    reserved: options.reserved ?? new Map,
    arrowSize: options.arrowSize ?? 10
  };
  const extra = { vertical: [], horizontal: [] };
  const below = new Set;
  for (;; ) {
    const laid = layout(extra);
    const auto = laid.steps ? lifted(laid) : laid;
    const { edges, crowded } = placeAll(diagram, auto, settings, below);
    const widening = new Set;
    const growing = new Set;
    for (const [id, room] of crowded) {
      if (!room)
        continue;
      const { channel, gap } = room;
      if (gap !== undefined) {
        widening.add(gap);
        continue;
      }
      if (channel === 0)
        below.add(id);
      const index = Math.max(channel, 1);
      if ((extra.horizontal[index] ?? 0) < maxGrowth * step2)
        growing.add(index);
    }
    if (widening.size === 0 && growing.size === 0) {
      return {
        layout: auto,
        edges: crowded.size === 0 ? edges : placeAll(diagram, auto, settings, true).edges
      };
    }
    for (const index of widening)
      extra.vertical[index] = (extra.vertical[index] ?? 0) + step2;
    for (const index of growing)
      extra.horizontal[index] = (extra.horizontal[index] ?? 0) + step2;
  }
}
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
var nodeClearance2 = 24;
function autoLayout(diagram, extra = {}) {
  if (diagram.layout === "architecture")
    return architectureGrid(diagram, 48, extra);
  if (diagram.layout === "sequence")
    return sequenceGrid(diagram);
  return diagram.nodes.some((node) => node.group !== undefined) ? flowGrid(diagram, extra) : layeredLayout(diagram);
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
    const beside = (x, toward) => x + Math.sign(toward - x || 1) * (nodeSize.width / 2 + nodeClearance2);
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
  const comparison = baseDiagram && compareVersions({ diagram: baseDiagram, layout: {} }, { diagram: currentDiagram, layout: {} });
  const diagram = comparison ? comparison.union : currentDiagram;
  const changes = comparison ? comparison.changes : new Map;
  const gap = Math.max(48, ...[...diagram.edges.map((edge) => edge.label), ...comparison?.reserved.values() ?? []].map((label) => labelWidth(shortLabel(label)) + 32));
  const laid = scene(diagram, (extra) => comparison && diagram.layout === "architecture" ? architectureGrid(diagram, gap, extra) : autoLayout(diagram, extra), { reserved: comparison?.reserved });
  const auto = laid.layout;
  if (!diagram.nodes.length && !auto.groups.length)
    throw new Error("Cannot export an empty diagram.");
  const sequence = diagram.layout === "sequence";
  const nodeBoxes = diagram.nodes.map((node) => {
    const [x, y] = auto.positions[node.id];
    return { x, y, ...nodeSize };
  });
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
  const activeEdges = laid.edges.filter(({ id }) => changes.get(id) !== "removed");
  const edges = laid.edges.map((drawn, index) => {
    const { id, edge, points, label } = drawn;
    const change = changes.get(id);
    if (label) {
      const {
        text,
        at: [x, y],
        routeY
      } = label;
      const width = number(label.width);
      const box = { x: x - width / 2, y: y - labelHeight2 / 2, width, height: labelHeight2 };
      boxes.push(box);
      const loop = sequence && edge.source === edge.target;
      labels.push(`<g>${title(id, edge.label)}${routeY === y ? "" : `<path d="M${number(x)},${number(routeY)} V${number(y)}" stroke="#334155"/>`}<rect data-label="${escape(id)}" x="${number(box.x)}" y="${number(box.y)}" width="${width}" height="${labelHeight2}" rx="4" fill="${sequence ? "none" : "#020617"}"/><text x="${number(loop ? box.x + 6 : x)}" y="${number(y + 4)}" class="edge-label${loop ? " loop-label" : ""}${change ? ` ${change}` : ""}">${escape(text)}</text></g>`);
    }
    for (const [x, y] of points)
      boxes.push({ x, y, width: 0, height: 0 });
    const animated = (edge.animated === true || diagram.layout === "sequence") && change !== "removed";
    const color = change ? colors[change] : comparison || sequence ? "#64748b" : animated ? "#529aff" : "#64748b";
    const path = roundedPath(points);
    if (sequence) {
      const row = auto.steps?.[id] ?? points[0][1];
      const gutterX = Math.min(...nodeBoxes.map((box) => box.x)) - 22;
      labels.push(`<text data-step="${escape(id)}" x="${gutterX}" y="${row + 4}" class="step-number" fill="${change ? colors[change] : "#64748b"}">${index + 1}</text>`);
      boxes.push({ x: gutterX - 14, y: row - 10, width: 24, height: 20 });
    }
    const flow = animated ? diagram.layout === "sequence" ? sequenceTrail(path, points, comparison ? color : "#93c5fd", activeEdges.indexOf(drawn), activeEdges.length) : dottedFlow(path, color) : "";
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
  const name = comparison && base ? `${current.name} compared with ${base.name}` : current.name;
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
var page = () => brotliDecompressSync(Buffer.from("W3dzdoLppmudBzk3BAggrD439RpfIps7jkydY0N30ioiOOHlHWqO3aMBgK7SbUhQmOH1c6pZQFVVTU8qY2ha/5YCCIAqqp/bzglVODHOc54GKkwMyRHzZM6lKrR1LF2hZOU92hb5hB2ZNip0NIHOUj05YKeio8JFhZvk0Vw7mIsbXlCoMvcCI3Zg+8O5KHzYsUIgkwLKtUy5kem8CZTrENoRX9i9Yjwe2hWCjje3+yFNpCLgJO7TAjmMKpMuaJVMMzUIb/Ir7uOnBpR5Y8WLJJz4+77ITbdKRnsERoWxN6ynsOOe4/EM504s/VTi8GV7uM+uItgxmCOIYQ/E6BIV/aORyen9dcmnTcWgyi10C5fziCiFKwkzVuZM+LDLhvmpCds+tDgYhtMp47+rrMIazUTIq8NWiZxMLBZqdW5KieRBYk/GsYasrIpMykyXCQEsxq3blyjQhCCh+miLOsQpnnIRFqFv8ZaH8LL5KMaPc/WrN1d9fWuCD2lnAYne4ypPGGzONvTBrfG60qVnO0HOMlkpGqNwgyis3D59W31fv0xLy7qaquxxm672Xsy7jyiiAi7S2QlOZDshaPF+6eQ7XZf/2Ldsyy/9aFpCQktMSOFg5LFsC8aSo9EYHPzPN+f/9+erapnTq+Y6WCHdzPOoy8YbAnRZgxuZoAR1kTOyEpZc4P9T/X+tWkqyMW9fLvIeggDIB+gPmsYhwaZCyDxF1xj+/z/T9OeZjESvMsJDbJJS0t+rp+em6WX8Ai3BKcYqskLB7eMZzCbftBXKUNjm5Pn8UBaV12iu/4rS2cuiocEcaIkCyqp1PzCX42MO99aWpnWF3bWfp0eJk1Aecfaz8H4tprNfgJArEEhUdWca8cSJJjtHepj+X/tZv9rGxJODk9YGNN8Zk0FF/2AANYZ0c0u4aPkptLh+6bz94q2Ws/pm7//Xb3Pf5mCaPitd7+ICZ1lW48BhJCrmqUy6JJWJx5jL99Wcfv0ZUxezDCkdwDg3HuUQ5vn2ow/WFSFyJeFCLTSLpWqdYCv19b+P0lWCmj5uY38ZqPYkwTrjY+nySGOZ9STARVL7JSx7X+3/f3++pGDBUx0VlZN730W3B4ntczbYxA4SZdcCIWRocyxzI4sCScX2mgww+D41rSiem+3/8J0TbDNgEDJEocraGW1Ze0j2XJwLf74u+/rVpntO0r4uyVcraRXP2rSQiZ1lMGFZOCCjpSL6MIyUipNzW69bkTQPUjvmbvQ8oCCrS+ebs09Gtxcg6sUWkAKk2C+2Gh1e2f5pprWiY6pWVu3iKt7jBNbdXwZQmU55Xplz5mqF2EtApuRVbMvIrjtmwYQ+IFdUKZM64v9GwfUO3fKff97fWKvfEhjZ5MwmxuE19RZ8NfU9XYmcwg+SHZvq2Lexbt8F6iEkKhzLsNX5wEIzDlifOi+NggmsY2RgalqmaUXpvcIUu7qFVThmcZLgQmLuIagzBSzNe/wRcENmKwzRoQEprdv9MhwdQPf/95VpVctvZm5wkCJTEdRUNatmZVaPy16VucMRoobMpJLKzNO7cVjD7vBu+B/p9m0gzMzNFe4OoIghkIEpihEM8t33v3v8/81BmhlAyt0RUjsQlA4iKOUBgsrsEJW1IBkkW1MNw7jZhpRZ87hY1WbJnlWZPa9y2afvf66EllVfFRAZcWDV/zPzIVkKHQUKgT0Ayq6q7LmVV3eur7aKSVbYGsF+315f6bf74T4hLIC76b20Tph5tDuj69I6TQPkze7MrNTdKkrMAkgIDiTBcGUTOb0ceMDnVTVXEJAPdGnSpZVp5KM3ekM23wZtXlMFAsKJIK0jmdqGPas/ebxCpVKp9HT2FGbTeLFs5DQKYQxK3TeKViDNzrOkkDPEA1VcmGskUW0IBmnrsjf2hg/OPffydf4m4/9ZqVtbq3f1eAw+wN8fe6uH/V3tdmavBuQTQsAKisjuj1p9zxnt4/xrARVCCDkgpXbv3Mtc/3/YRdd6/S+ZtDYpJIDo34aZzbbJvk07E2PMZxBC6MG7d/BfQ808b6q+pOtwK3UbcGcm2zD9b90mbTc9MvMNGGMucwhJYPKWUSp1bmM7TZrmLmYYHvELkAT23h4ys+pw3m5j/xuljFAsFePHWPp9m5ieaXcjDIcIaBSPNyDZxt73om3fHWh92ySEEAJa19qf4jJ85tP5ps59nHeWUgr/EFJaIHBWMrV3YudL2swbJCGESkPYe8dlGdPa7T7v75ExQ2iFRAtaDGeJv2iU0FUg7ZBL18zfW1UDyVbhwP5ZHkU0tiTY911sSNNOmHmIyex4K3F9Gax0+6Svr8A+BUPWPTkWG8TvUYFyrdlinGUnIjhV/pBdTb7sM6JFQ6dzefceYPOB/atKdg1n/3mZm8PPKmEXVTEnxS36UW1IFZX9ktrIM0SH761yPupNh5xYn13wF5Dgc3BR0114I8KJ3DajFvfbWbQIky79Sb5mT6RPIt6rbXxXds+gdLbWbOPV6L/9wYCUuM1Wf0OVmzFso+uOCGjQTKnbzYj9Fyy7euScJ1FwwHzUlgmscgmQ2+/GZFO2uQt4MBdUK9kH14F9Fjn30wHEprXhEhZhJr1xX09ZSXqdhi5puOVKOhybAe0XTf2OFc1grkDrk5r8nIHst+iyEwN1YqDtXaF6B7jS1aWGtw59CsQ26h3ViaCtdYEDT663RIo2o3VcYLFU6iUwtZk3ds8mx8rzzZDC/qXI1t1aZ6CYScYfWoDpbc/KhoIhy3z1N11Evr0Hcr2mCwXm66JRARFGPIAp1DdsOjHaqnOECZLv5NlrzaNMpULxKzWY/kR1Zp25AfK/LqJ6iiovygAJeOLywkBS7+dADlkEf+f/cpQqzlXbFiC1VHlWptvXdKSbqxhv+e9P4+t/HyIa4LwO/l3gMv4NVdxJxP6hgfTGvqubOnvRek1Aodk15o1slYPmfvKOAspQ3WRI+VhbClD6bc7JCCuZThfZ2Ood9ZyurvcnXyRu9PV/rqkFAkYs1J6EKW2fO9yo2cR1+PmgkT0/NdC+2pUOm5HX2c+mDGdcQbRnW+tLtufX8TL8cy672ox04Dlb7Z301F+y2pbqekUElPKcnz9tuTXgLEvvvDooPCgO3kTj4AHGB7GMcdHhT0DRbySagJOm4a9L5av9F/tG/GowwW3v+u1/21MCOvjT8EiX0mo4liNlvbAt5wa6dQRWbPYbgeMF8/wad2pc/nfn+6LF65A+jPUPo4csFgy2Nme+6UhHKWIu/sspzmJz/ACKk25IPmpGzcg5snngnobASB6eha7+gyswgWRu1mFBf15iu+Qr1900e87WIo3hFwH4nYvwjodrNNBgsn5+45vbK8SLDk9fTj28//yGUzkp+au+0Bc75tKWxNVCIErTCMTx66i31/uuXK8qouvzPxF3Xf11izCAx8o7zbcFDcadLZRLmgYz8ZCIpKb55hLalN9ZrNA/TN1cGo39zm2SvwP44u3Ip+SIFlRNaUscYpH7+MHBgUFVvpxVNjnjYNxXy9tAT6NMy7IjIzu+wihUZWZnhkwmnxn2WK7c35L68LRLqi/G3dZQSmo4XBSfUmXDnmyly1ywATLsC+/Htu1iUP59oe3SX4Kh+mIdDeQQ09dO8ZB6nJIpB+Hhj5349R82KVIhsCsxGzY4g/1RfKbNskDa4A6p32mjAC6MIY4+82jTQUjE/lfYcsIXTmvCnsSl3YvQ/Tk7IxgVdFR98hRYM1LUdXh7I4IRVmFbBjXbSwnziKnwiMlI2taphZnA2n0tcUcd+K4QfLif/6Gm/6fp6lSPBCPAVpWb1fTD5lbu3KM/qt5/7/S0Of/y3JBW9+RBetsHxQcbbPTunj7s1soKe2X4zO6Scl7MtHhkwB3fBuqub7H70OnqXAUo9fUUDRctRvWjveczPUV5UTkv9FIouX16FSA3wN+DH3L5jmIoMlYJYGcoY6WwPG16t0+7y5qFYerD9N8ee63zdZ6HSkXhs99qfXN3BQxo5Rb6LsBxRzs0xBApMnQtROOCl/qZ71AQmGBNBS8/U1lq/FHHLkkvgHVzgpqRwVDBohv+FRoJecWdUo7SNYQ/vHIL5p26AD1HcKbIffLpR/X3rav4mcjbQzVRmpFcxFxw08DPKkaLrtiOo8258lKv4Fpaawa0ofYBE//sp+gQjqJI6uXzteq2csW82XdBdSqBR8rOoHkG5M02uJSgOOGEjxLfZII0MCfzEPbbV0AX9NpMafK0g0hdBNV/taQ4Pqx8k3DHq4c1NtwL/SK6e6ABwbzJ1k27ooMPr98mSaNOKZ1vuO7CvHa2GRk5u6Yx4SArZYtHwIuF8F3jv+2kbRjz2LcriTBdQStepQIfG55ww/XB9h38wM2XDbBctCuvsh/+L7MPxbUq/7DbOdg3f+8ElY3OinCNgOG/bhhp6nAdxqjhqxGoQTRMG/gTkjPnEjGQgpul8rRC2a7ljHAfbgwojzZmMvU99JBwCKnWedgi+BLhCeRMnDrDyMyurBfhh7ueAbpI5Z0ywVSaHaocCFuXOU3qdwoFJMthJfDSBNUeonw4Y8fWta5SndEIZIGSVcnbRZMvXscK/2Y0OaSuPe1NHXjd3/T4zSWTpiIYAGKoX4J2KzFSXaVcRa5rxxLalLp9AkPaC2SWBLS5YwRYaVOktBUDgP6pqfjYgbc9K0S8yz2nQp0xup75M1z1p7cS2NCtgXen79GDH0gb8ZUU6N5P1PwDS++194A9sRrIXVo0FgJTyNhfBZil7fK2o1KvrTtD9qjNsjtoJEkk1/JdDRZq3uU3z2abS9i+4J07l5XihyVFU1y88n0nooU5JYcnrtRuMOSwW7NZ8ZdKmZ2HiTB6GTxEJmS0YNHNlgfzbu7cxyFqacmyN9xfCVX7LZvLM8CPwCN5ik0Q6cgpLlDw0vINm28MWP+Hrk7rFYkYm05skj9zW/uJDtjbyqIbisYmaoOV/7G5bBbD5i5H/4U0OVgbZUJRBkuMP4FR0bu7vI1NEQL0OznW0D/uJwb8xLft9TzBLwN6tWvr7wB5hNgq2K5aXK1dJrUfd8P4s3Xn5d0FfNWt7h9F4eG9LR6j1LsEm7vGCvqy6FET68k4F/525mK91W8HAQhGtIxH0eKr5L+4xKqGScdZOECPXomvXNd2+zUyN95zO7cDOmH7OqpJkN1C8LTwRJWzvf4teA8OId73n52ERer20RDx4eYKbNysD9dx9bawIbYalxwPLnca4GG2BKtpw5eLHUT2blG5CgHfo5R6VUKZPbvMbdl1SV30Jn04BzxEvMs36r9B0nKLl4zxNbLzPzGCLFp6m5cX7ffBa6bk+vn0foFwvGRY8nIuT3YO1p0wsfXZItmc8TT9/ISXMY4ONNzW0/q5Pv+dZUXxmQwTMnzFoqst+jQ7FlyrG6Z+5Zuhszzh1gw7xNyJO6d8+akvKhbW/TuSh781PMcDlFZdTltN8w0cHRrCenuudI0nZbQVXieMWjkJQNZdb2NQ2ha/+FSEJtnwet7v/4KGkHNe4BrKuO6xfo71hK1IpenrXxkBn2CL0JhzNm+TNAN4tBOgS8/pGQvNkM+IGZw8pjpmnPqnsST0TS/VcZEq1HqRLFRwkSQA6zGWa8dIQo2ZUH1QGP3jlXr+IS76MUwqRJpOYqHKYIAIbWZ0bJg4Mb1cmp0AnrHDAqkWp/YLp/yNpglSYyTI1R1VpJPyCM/u7Me6Km7FbZGx9CK/hDyvksHapKZlhkrkXbIUHpk25/cCvJc+th6SifLCuCtq3/pUh28AVFTa6e/S+RgbnOpKwSpr1k2peHbvxRerfPv+mxiR4Z/UWP9LgtMogH5FPWExaIoCTkZmWaCE45Egn5cgJvMolhyJerXBjH1S0iGBLVJ998oJyADZLowdh5M1g/9KoTQLUycUxbSDImGAEvtNwVG3EtadJoM5dFcWK1FU/PbJXrYYvID4NgI1AhH5+s1Z8ei4x8hHC1Y0FmkXxrjN71vQypRZq3psbKv6J957RglT7/O1WvWBMCUK3fESLxMKXr75V9Qv0eRV6E9pw5BbNksGheX8spceZPFDVJVsGtHQH5P4NGaU8R8ZcudNEVwoh9pLKZlDxTmMWcRsRP/oaMgbz2Cg4Iu9CwBn5csH9va2kzT+WgZUAPR8F5qYvw8Sj4HztNUlCCmLTwaTMmxWS3WwDd5sv0hksySqKhkSiTXpDajJ2ROWoxZu1LrEevbcRIAsDbJQLrWLZuuZozwcXybpGXImpzdeuWNNjUURTj0VhPNFrv/fANlBNHDGDa6HKaJOZReGdkUHetPqrsFM5C6KXh/Oy/bOOiGe/De0T7x7nLlJXoIfum2sCxbFwTYdObj5N5zj7uZnXcVVUqooDvubG9gr/Qcpg0IFTL0IpN70WACoaFdwAoS63OAj3hojBfa9dzWUuD0wMfAqN9+CjWCYDi9fpqx4smyx0ru3Vxx3APdp7wrH84W0QwB2NSM5sPQ1UllJTzwN8vn7hDq8B1W8T3EBlGPMuos+ESCzm6ptFRxuygQKgltWxIAgi8NO9ElFYsaWcbfZkQGCNRkwP4SxDFtRH2c/04RhS+IJXVF4ezHh88i8gB93Jks6jlKIgjXApLfAYZsfKoOW79QRSfkH+sQoamOCDvGjAB16M1gysbtp26mjs3TzANwvuE8UyX1IUNLGExqZg/rk9lbHir2IoD5R5On+226HNwbAVy8xaQaInFpiu3b70h2y7/U+cqzKydtR+y1jfeWz9L14IqOEmFy0/YpDC6j4uQN07b+4OIQegdGHPcUqJ+EnjB8FoJrL1wKoBwVQs++5805xX6irSD83zFbpvnJEr9Fo6CAKruoK2MczNeNK9Xvv6TX9Wj82RWygSLqJd+9ns7XN0XFWBUCF9bANl/UcauNGlAx1x2sVS8GkfzRnA9XfD6GF2yrj4OCgBd4QCs3apoAhif8jhkjoIGDILICz8sjnjiJjMmBSjfIHEkKh0OtjhJIkxmGAEbP79yUapSeiivrFFEukuFB+fA8IAP9u41PwHijUT2dC/QQQmXO8XSQFGBTRNud4qG9ySfPMJWyocFk1OiimR4llVf6NC+gAYDFOMtXhAGJQpL/iDhT5oHjjEvQWfgsVOS7lvEumbZsS5qAU4EbOyDa0n9Q18olNm/h9s+tn9scCYf4GGMhSIZuqpskyXhpG4c1CRSIO2CEGDmr3QrnBrjEMMYdrzAufIRBQQYCQq3vnwBRFM6kAfZ6ydg+K9/HouO6fWDzcHlzfJuGCfPoTa5nGS6xUmRumq23WoMwl6D2a3llJRpljo+zE+nQsLpc4EF0X++W6jjYtddAH9DRMUAoHfJEh5+wSukMb8ioutLP5wIUsKD4+qtP+Q6aK+yxbuIY4EqwqPKLFIYmCsdBtgjaqGOkjSRHNlxEUR5vA3OAdMLo1CL9Sti2QMIyD2sLJrAteMoB8iJL/fbxYW0alc8DhOERX1ogdtEeSWE+u/WXPEGjfUCbnOCrkPxbZUrGE5YInBusQXZSAUIW+IqLITyXxlShhckK5ZS+SU9KqWepujlbhmpKfuXKf9t/E1NQFogWYtaOAW2KRoPbXTNDZn0V+HjoxB/pRahS1n7CyEwERqFARWJgMp4cfgZovBJoZu32fEpxo2943t1x/ZWbU4WaHRLIH9dwtnykF9p5VzFhFDoXLqqdqRjh7DevXYQpj1C4WpluWNmmowGhk5vf8FsxbSQmv2bSjzwzbH1MSTeedjFOGNUT8sFf58LeZTHZTzzZ2Rnti2IkIw/bCROiDiylGbWPQvlslptcT71BGEtR3WIyAgWyWnDxEabJif8o3Wavpxawwq1mPDGEZemWWo4oc13bYd0RaUFTAxMFkvJXP7fbm5onarh56QUBBCLUfRC2CTDL3khP6H4msYgEQC1NUuAG7YJ4KCTRzWmUmsOVtJc2kOfcfKMu5XD34i+p1F/txNap5ETNn4QC5+cruV3kpMEf2BUH1k+E82x4v3FAWHz4mBBSWEIjEFOoJpo5uFITHxT5J4+Yd/6tXNX2zG90XX9OLH8inaBO5FtCSWG+9Lwefj3a/gcdGeoj//m5+GTmygSV1nEm6dlckIL+u4X+GNe5L0iqF/eq7f230f89Jo551bnjJT89eCibXrqZuNvzIdwW2uNxZM1X77aT8GjID4MeQwbujTVAYMSM6u7jLIL/7teBC6ce6zl11eN0n8fECA5ngD69nuv2l4GK1L0IQUKqnuM2Nyu7okfvvA0MkRyhPwe4kqw3YfYeqLxL3n0eUc5+m6NAnUPS3I2R0+AlA30eObBQyIvX72lt9FSJ171oGvO0KMx6hEithdDL2kjeYoOC6jdsuJh6qHr9zkFWPwOUsAQYMN+hwMWzWRvB0WfrxX/tb23V5w7Y2QRfSTDm8WL0FUJ+1+y+azZqbWksJcppeklEKjM1KHey2O5dbXhPP0n0s8nfe98to4vY64+oWG7aQj3KGEAKYXNB9wuTEziSzuiRWvRy1MWKui5Bz3jPHLrm8+KsZOrZlIc7Fj2lBF4JINf22NBLf7DJ/X923aPaTc8J3QN2x0/r/9MKCYLHAOx3ozU/EWqa/wQJ9B9Z66bJtutC8WBSJNyWfNgYLAK57lT8Moxhl5+wZv9PXPZt6ntnDynAxhHMUMF8XWpb2g8I2YC+1edvvhapYO7ozauxpQDLDT8kAY7ZG3neP68vDAlJC0t6/8ctqToq9bHcwSLIeWAKKbbLVDjFFCvdNZ+p0qdXJI1yjmXDCbhvGx9+EDbVmpZlOb/iTn2Z4hQ8OtwgZx0wdTY+aelJja/wTWb7fyAUd+nZKlzGJOmGPWikRgUFbRZ5mmBeODLC8BZFarCaa6gZWxZeE5lk5qoXN5JEy6dbQVGHicNjfxJkQvqVbrY8dUviKJkVOebaPTByH38x8qYbrMJnnijsOOBIba6y5a6i2OzXJsehl+YXV1WNADUXjApEQbWS/K2d5O2BDndnAGbjGQ5KMze0EnoEolmeJhKMjRFZ6MrJD9OY5d+kwJH3JRri0A1ncZ75LRYzu6SSKqXsnkPGQesrTymNgh4OouDTWoBKiG5dSU2topKZ6MK2gb2umVyPbkLpyYCSd6tbKS7Jsj4HUUwbbexOi1KuKkUeMC6ZRT8GjbuxMYo7vEyQHpqDOoFwGo6ICuWEeiLPMl74KinbXopb/MkVhz7g6p4VlXFxWDZqEAe3Od+hcEUAUcblywsKT8WP380FlcDLpv5JVvqglH9ossc+P2FyM26ARAWmHaMxd81jqofCiYJfXQ53UWHwHmZG5Ta6VreOwLOmN1KpXxU3SKq8rh9b36dMeI7rPhPVFxwF8mICzLBLi1/gZ4uS4SP8ThRm+nYL5vPOiXzJOr/iT+qqtXEsE//p8OS3AzLDa+WvnaBFixdqU9Wbe7YqbM2yfKVl64xWvxfmEEQXA0zFYsRfTL2ZQZNGRwhNcjP3FmVEOi/Ev7LmH+ua0i3yMcAAWeWEvpgINeI3oZcfJQGE+Qs6VEILQldvbs11NPSh08qinEtXKIsdLxRQKlkFjSDYtXGAR/CnvFpTWpeygx4F9WsuL+DX2W+v39Rm6UpgdVmaKWoKQQFI5yzgDHT4bCBdReHjnRbr699Ghsx7uEKM0jD8+ZiHYW8foJS5NZnievHRija2K16Y5w2p1+4rj4v59B+oFt+abFJEX3iOxT+OcAZuET9mAfzvOv8K/b0v5YZVgtSjKiug+7ntWdtQ96iPPAv6CbqMk+KiBi0abjBWZf5Tve7tVEeSIgmOKmM6Yg/ACM5R7l9VJcE3iaTiYQMJLWH9J8xcWCJpJXI8gPCiP1Ql3Otr5ABShj9ZIAywFboLEfVHWwWnH8EWC36ogn4NuJ7KYQLJC2CSmZOSkeVUWI/BqA7eM8pVDlpgsmq4SSfM25uB0enYPHa2XD7wvoRWGPGl0pub4hWWTTQtfAd54LI37rXaAMRZyPnY/GClR9ubsQC27YFCdL1oR9zOQ0YcWZt/3aBnMSn/ds+1PLklmtsz9zJbBs5Ffer6mUGdp2nIPxQxMWUlbepcQhYUMEDURPcmBM3/u99PaSsLdmjxEkgVGhZdIL7DcZFRCQvN/XSWQdo0VX/QLjewy0jNGZ8IAF6AYqQK9AvxZeiYkEND/TLSDLVpybRHWI49OAY/hdBx0V5sPF61T+eaGAe4Dq0DuU5Ck4ydkrLPtRKPs7qUHOBnitXDidJDLAQOWREEHQQ7q2oGFGUY6ImOwMTDrdhc/Jw113/byb1gXRVrM0buBTkiKbyt9G/Wiu6y9J5JXmp2UFckA0UBw0hkGZVntLiK22U21spXWqBk0XJwvFbrYWMiBtHmw5NnlmvUsI2OC3A/i/e5RwNUzz6CwRA5ruw+rw1Z4/Jc+pOhQymKh5eCVvY4mqa2MYdPlyrdu+wOFJ4yj01bh2JUaZElJDp7t9wRkPo7Hm+SpMRnjF46iU/BVLiqKtqPQVhGTUJNEddpn4yc8L3jzSp84TuePU0/pwQA95CVQZQTl5uoAqWonSG3HgdGfbG15n52T1oXb6foa5BfznJKxCy4c5eK/OyTILOeK+ty+dqgbn38lLNlslFst5wq8Qi/XiiUOz9vn9RXK8FrSFiXYK9DGQZu0mbEu5/EkQBRJcEhMMQ9skb3k+BY4QmbCMcEGylzhQNlPWTJ70bYH75L7VLdUPKOVQ9k3H5UP62IBAYjLKAt/UAhtK/jQBGlgPlMqODwzLahrkaJazFnHH/iI6DYT9JSY7kXUt84BTlR3tWyxlzgOUyhWyZdSsbfH9KqRWhMxvFzcCtUvMtxYQ2i30iDF4eYaji8SjB76Mf5fTmWo67LfnYPx81KeYfb0dRt32C/uMeMejaL9bY5SzGSHlzts4MBXdVlCndk7VzxjD+9sFkJMKhoLnFs/SgdVKe+URO/FFw/NpTqkx6H62LU/IX0/hyJ1H/4Cze67SF+sccil76qNYFczAS/8mHWixZiWEZ5TDPjEw9keTZ7XZuJPnbmKAlPoY9+kQr1q4imaeZDitZKjGeZS1SMzqY5Jsw0Gs4fDUNhLOdyOx4vLyHd/n1DtWpP67c3E1pFHLMLXPeBO8GjVcs8ev/pUBjQtSxAyj0bM6nGWOXb5BYaey2GLjc2GcJ7kx2+h830CXiLtfScxKLSe4I6lzoCXopQozsxpmw+1HI1j+8sbY0yK2H0xmyEB8JGZBm02kMVAyTboGM2CYl2YoMmS+Ur2KvrMg8wMMcu8KHk0R409iYMNPaAj5MHzvzkJJVeF4W+TBexTY8F8UDF1f7quF3YsK5msOuJsKLff7rIeiUMrzF7wdyvLkfzWSA8X5sM78wye8p+a2cC/KUqHUMuLuhpR8ONAvYVCliEFv1WfVxNjvU02EsV/gImx/um7vUIvzJadMkNzSBrZ+Sm1qPEkSptFBxbMxUWJ3//3CpAAPRMsctebuA12kaNyUw324lmxrthZotijVqlIFT4BMqWLPK4OTsXl+Xzwvr3nkQJWWIpW7snQe6/LFBiXvKgvy5CQw1uMPWu0g/BZeD3ASOHsLmuxVI24g8al+wVXEFU+dZyGZzH5G/2591gRBMs+9c5QSkKbnistTURHvrWbZ1lpKLrRDxVSPRtwI4aRXgvkKP5NOeCqd7wzY0aFb2GcTLHJpqj7lJdB1/XOPaXNIDSvvO+OhjEhpnBHBhEvg631j9zUoJ66Xpzjc6VSqImVDZ0Fdk3xLatqsarIiTTiedPxC1DcAi4SGtkglYPjtSWqkpfvm1GqbBkhN4kj1EvpgRR+3qdQkGQsUaOLu6w+zijUdbHmpznohwjEoB+n3xXF6QgNktpwylmlaEdaC+PBYFUZQdzR3bJFHsvh8StMp2GsfNeSvLWiuI1fAMKBWcrtWuhBQdBGb+EQm+4LUTvIjLH0fFj2M76PqBRzVAl3vWiqniUT5vDsys5lKm0+zadOYsxtkAtH49uUuinGc1gQrS+79l4w4Ih/YBvnX9lqtmraop7isceMOr0H6+j9lfDypCUsmRMnrANqvxapKeDRQct+6Kgom0GXF2kIsrkVPUatv60PdqEEzyjDBL+pootdVjb/ESd7noqbpuqNNVSYaRQ7D9pJJq1QWlMDeJm2bUdgMxEEZ0TuXsghz2pw3xXcT40EtKieamxaCVIdAhrZHGn6sGK001qb0LwuJETY66GmZl4f47cQ0b679vaNldCjGfeZD/ytehrFXqTvNuHnsApE+t7VjkbJtc8AoaJ8Ewo6ZCoUvz9tlMgo/303uLB56f/WvY/JSHLt1b/V7+6nVxiaa6KdrfZxNDNjg5BvD6+xmXKp2Q/aWWoGnKDd+S0gM4JDncmRm7MsfWDVESWaurUrHxVECbudyqgDOD+JtIDs4eRfLXKklNCt8sVdNSP6McJjVBqIxbo5w+Ey5DHLZh4l2CnEDcbPvBFGH908vNdhyfBSf/EmvLxJ/j7uKpW9s2vfr3uUifm3Us/6UhHEdYLfE9QwP8ECCMvF8pZF/TflrK+/CUne0sfNzVWzkadLefv2Jw4exW+mqrhptXBhjlrejKpUu3C01WpsezGqyfaN4vnXqCrpT5zNnP5MqqnC5VXcmq+VQ9bep7/WxYB/eMILAxZmBWolrMHAFMIQkmkzGOW7bnE6DMiH7370Wzunh+SPIqO+mwwGgWFmgiLqeHe+GXbe30NBCUBWnkVvCSgHQo+5B0MLOvnmjD6f62SUNxV1aB0MMwe6E4D6zQGfr5VO29xXMwdId4GvODdxk95whiyJMeivE5y+1HRGUUBbYzPyHkvYnFexov/uy5OMo0GXVqIaY9UWN4bW9LU2Q26z/u0vYhpdkvK9kJlbNlN3WYIGJR54hzf/Tshx8a9HUrvN2NhYdWkbr9WJhQoFXYBYBF/CTBVhVTz/2FsgJZdbbY8FKzlGl+II0NRwC+fxvYboDa1NLx+7xKT00PcSYlx9wz52G8fUkQqNrXoyCssgi58Y+ahVHPPaGWzFgMxpOJbkVBSnInK7EuItKwkmbuugqAEjBD2hj6T8h6BsM3SYMrucvbc1DkGZRfAVR8D9OcCjVXk33qRAOkN7GnqvYzr0HbdslSI6+wdqpYQpsfrshl02ItN//xS7ybVKpSZ3nVBKoeW5il9BQux6fwI4F3b1IaCGlYEBQSiJKAAElXN0X/Th03ObW6ClxmewHYT4uCAHEOJCKS21h+58SKMEZsP3+iPI0CNTIxHBrCB+qkCHK3X+dpppSHgr2LciYN/hrcIA6GXWGUbjwK5wqHxJu7H8/0Mq8GM34HtRfCQo8quCQTxJhZrNSGcV9clrAceof94YrIzVPjhPO2fpruScXxvblk8NrTLXl64fBaGSdq1uWNRxqeVtaFMJ3b9dQgIsjdBpIPU/0v0e8Adw34WuMTFNB4RzMwK87M6+WToBDYeINua+cDxWkLDtRQU2+qbfVK4LX219B1OYvA0JKq/GbcliTX5QztyUW2ZBPMac2QPDdcJpjGBECXEizCiyo8NDxZW81Au/Bf/igMwPBiLtfkRhRR71xLMU7X1eZO35q5FMqS6IkQ0y/BU/XuE7pLMMR7rUl28rhFPNFou9+pmwdVFo0Dvav/YivP3Ww2dfkkkTieaC1FOCqG696yicY4SE/c5kcNGHO3PC55nVhbDyaD6/8ATGjEnhgrRdBBu2BWanBqURqR5bGPDwhsz8C67/Hv7w3l+fogbtLLzl08QeWcJwKE/wCUQgo4D7gdjjv47b4nHs73VM/9nfxlt9P1Tm9mFqlnqRrpS4VTvB44heg05Md8Fou84Mo4xx5Zim9dO/aHr5xXgCDqMjIcF7IYsQ/PXabpwmhLPnuISgLMmZ0BRAUEiifO6+9UO00wzhqs+xLJ6z5GuCGPVJ8CmMIz6xJjn9NsXn5mup6wmSbReYEWlLRKnU9Jkl6ArPTBgiIBrm3w/fCzMqWL+DQCFRW9t2++mU8JTL8VTQsr+b5NzJNfnuYM1n+Epe+Mp4eLhIsFR0ZvWy4SA6QQLHA6RtXXAlTqQBFef28JNIhVdb7fnBeEXi7GQ4qg5aBzz1QUP9+M11xYZIZmRAsv97AWsrh1Phr53HnI5LbcL+vW9xHIU9qrVOJ42MkvXIOapTGq6fGy996syE6w17L+X3PVbklgEWvugFPn2FKBK2VrAKXR6/sWqJJGrYqHveg1Jt783X672jRBBo1093FLHfrFQAA5R4jZeVEcm+3dUXyTJlvz1qrGavCeIVTAiiCJash6UhckrPy6pey1h68eZ8GOjITC7m6VlHGeRje5aNMbXFzMTT5smqf6q7PEjZhKtVFVh6+32usEuHthvovaJprpNn86g13resmxhLTFrAqTWxL4aKGuLNb78RayZRbm363RbrFyvCO3tVJPV1B2A4F63TeGWrftCNuIwt8EVMfZkQbGeopdpZaUq0VzTCBWvxM5ExJGgwiA+mEloTkL0Z53fdXkgrIvnWWktSxXUOxfQqn11MoMR7MnsckDj2YpnwetGNqeT8iH6bMzckouQxWR3w1t9i+6P3VTRdWvdklQKmG1N4MayQEk6HVU5pQrSpO1fSD5t4WiaINstl+vHkHB/tPsHLyNAjYBWKYEiy7LvtxxKIE4gyk2Gbp/ZpNdrz7oKHhRIo8Y4SleZgj5Do3KgpuGFv/b6W62AmXpkw3r6zdvPYmfy32hWwu9aEBnQPAs1uvJTbCrS/7ijd4Q/dd7OuxMSFvizHhlfNlws7AdgY0MMirw+oHYFEj1U/8dM4rFbL6ek02Hv3YRucsUmGNRqeuIvIe+ab434XtwMURlCeYaIyenLVUMUAI4P8iby2CTp9JUeXFe8rOJcMYhoPzkW0aPtSWRg8QvHFHGVbLITzeFm2hNHpbjVqWBA9FWpvJWQYyfsoAXQQQEnKOBhHC4UXSjG7HyvH9EmPxu3i+Uc6CQiDQzRCyOs/92s2d/uzXAcZUprlV6KnvkVF+/i4XzccNrKgEcJQ5K7+W0p44+KoJfYCFtTkxw5bhRqwPKetDTYMrPL4o8T/lrW2K9ZsQafCQmGkWzYrNjRJobQ5oe0bGYKu6xSu/yYrBGTQQC/GZvKzwRq62GlYv1mzFp27zVum8W7srCHm9gqbCkX/gKEtG5vR52BSexLA6/61/lbR0fHnyCGxneDfedOMdDOsu40u1Vt2SHPAfpUIQdL7bvgF+ca6G7spWsKws64h8jXMzdes+5QQkqICX/O0To8mlLkeTwoH1MKP0SohKrbPjkGRy6WOE+piEXkdPFUugNPp7EzRNLsqexeoPTKnwMvpdTtB4c2zQlstGV2NUerquawes4KMBTU3nIhMgCFWfvX/FkVC0nwVVS3bOPV0v2otOEqRg+hbDLCG+iFOuWmxWSHsnBAvk+AoDnOaE1aQCfkS817+W5IJYHhXkHpeYYul/xcZg9SDvHbCtoZfD70rzU+t9QzH0tvSJ9E2NTmhPVQN98YuJITmgiCc//Hb7SgOySvIbAwqox3Ldi4ZB8UgwtFmTbCYggzt3KWjkiU9xGB+nL1T4NijsqNpD/KSpiUK8pJD24VQom9W2zpZp98U9O8lBHiEOsP1mSaaYGLWsUM+YLwtZDM11apxBIbsHk9LaGfPU2G27rg6I8ZJAyL0YrQNyCzvg3F/+ODuTsRleP0En4epQRiBw3RqoYby2IkNRE+psZDEJh6yWrMxIWhMwDcEVDrYVJVwmV5QuydNWdGV9BMlZwb0VcNw3gDT/hacV78p+NUzapJ/MEenXbXX0gqmeP0C/Ja2uL00/0D6WVqc532rp5berT3bgWULut1oI0YPr/rr5F/FNw3Ceyh4c7MgABqUQSU5FoA3dhBB5uMtytpewsMhVlagvj3/TMFDxJaCMpXgQ5nhc3rTWY5y7qk6BlBTfxsVhlFUDKbOb88bRC30xyaMQgMvu0MYtoYIXAtC4sNO+9i5K3ClgxkLAKA2dke7DBrz7m0CeyzQyTSOgsVknB9tEn8844b5LA1Cl852lBL6b6hXT0Qd0jAeYr2mSEYxgTEJi45UqEFs31WpQXiWIGq6xPG0iMTkoqy1fQyi9Bynqtb34/Zipt67rlbiITFbfpD6MC3AA98zySjCtjlJ1om3om4JqYStOBXtG5U3EzbIQMMnt5rWOe2NN/VABhhvzghTD5gcRo/iTGq1lFdDT0lNxSzJ94mkM6pBfKTzY6FG6mno7pp4DiwCpA8C+4W1rRXuB+Mo2jg8tN16/J2Imqe924db+8BiBkGqQXpfWhfhUNwOUkeJJFFA8Csvjle1KaQaP3ipx+N4Vhs0wMP3fYV/sxQMhYwx2vZ7837nQm4Glqm4SdoZhEEbzZPg5BFwDL+6bfVe73/Vws3SH41Q6n76LNvOp5YxRumGYL11v8Jlyzr92uZa6rUMMuqT67EZHiTKnWfeUKg8+MrBJNm0GpxejhEvnmr3m9VxTDxau940UAjdM1ILPHzC0Vj/AkVGagJboQHyoq5/JPmYEDP1CRAzDcomd4p+oqb7BPckMln5ZPuXPxai2fIdHwWmnhfM2StH8YeEhAAYFlE6ogz+vRylBHWwhJrKcXl+sj4WPTjETexuuf5tmDM1NsBe7cmKOEzFaXo/5Jyr+uNU/1/PqeeZWWp5YG4L6UydmY7NGBD0UZwqw2rdql0xzqap/sTi3hwtfsp9ogAWsC/dyCgObz07oD6Sh8ZSJQ3bk1pqPEpIkeiZvFoF/BSlSjgnArTRpts+XpbXa9ilFhe5lGv4jlv6qBXEn2godmNsAOqR9Ey8l6nIV/ksPs8bPL8Mv9IoLpid2CG3PUT4ysQhPjYIIYPM3tXhMA+VO9A6HDbOCntH3Dynpf4qvw8d0AamPgPWZpPjTvFuQOtyaET41SY+MeTWyrQBeMDg9rS9H3XZezYiQOtxCLgI4Bd+XIAaBFUkSrqkOL4SvtCEhYHKX2FmSPE0rEwkqazN7nUWo0aokUkZFpMDp95ule7ANgv6jRTdI1W/cYJKzxO9f+STcpRhUDYGF3RVt/WzBXZgpjVmRk1z7UkvYX+SMps8EtEtukAn6AqZAEAuIocK9JSH5Jh26MsXMTI54+Q81QKLPLmI1Diwo2zNfo7KLE9Q+Al+CX6rfuVCTeT8uWCP8WUhPfEA/Y2ykGzx2MFI8U85As6xVo0/5QsSq3ar6g/9Db0Slgwgk5ZKjz0T9X29AEeUJP1U6rBPht6jBxFTFf8y4rBrx64gJpneI18oZFr2W99NEgzNo4UWp39TFnq3g0GB32SjtmyPiOhaM7LhXHHrptZOTPBjkrALXvxNifxSB+i9ikLYNB1+tvhhBdIC5qL6QUYMWLaF+4UFfSjBBQ/WKFtaE8lmaA6KAFpJ3BYRlIEOyVgrsMz+OVBDlughHh+9OiKn5Nrrgi/fG+oY8F0yfNJ7fAqFr3I453M2WdkcLN6aDK7PzwORtaOaR0Kr5MbvZBzDJFOa6Wzhu54fTi5cODchxs+CbjhCG3E5J9ctHs40t53rpU2lRLCYvUtVxzhrC/7rGxb4aUsI3LiPOlq2q4YzVP9l73zoyK9bi6emOEQq30M7E0mjqHioXbVL19uBcdCnjuJm0QiDzNGCKpDqyiz6g6FRHgytOI4JDqpS8nlYsEHCoBsb4l5XCtbR2rpfkfrByBDpNdwxkEoGfDgvC4LByh2B0cJc2lbTHAXZPy2hQqvlBRbhPT+03bXcrujsmc5pWyxUJd6AHPenQtjYYteDgTpp8zYZpgXCl4k8rvLNEh0sBLJ6eaGWcG55dAPPcz3Hmfqx7UnVdJuKnOEdhwrmBO0nagkzEzVyfMpNahCaQVaVJT2mjkWIRPlm3DmiVNdfIXO/pZTGyfTihGLdXffCyeoR7VaQAZF2i2Zi3DqhvdMpAeVyF3p2a22IvwmoIfGTeXtn9jt0Swn1qxm9/SGdOACmMyvqBOVtP1MvDCoVN/Vav4ttF73EZySMCzpSo11AsCUuhM31tHFCN+30iL9bDJs4KhDHMuvWe0bIYX8IIV5XfbJhf7DGLEBiOyW1eAXQMxST4BwyxYcBAxAio9TqU2snoRtdDdIJPJf0lML5S9Q1c2NPoOhGULGbyWndIU+SztoNDvcLgrF2icxeNm4xmfVl2Ktjqb0Jwg+qZ2UC5pWmQXtOGOOSK7J832L8JpBoulK05X+lwrODmJnsvF1TWIKjnMjf4BvOK1uwRVJsyKsiJ1qTFc3IhHbkQnPyQjdkSWdkQadkTVOypRcyJ+fPSxvSILLhCMLCYvMDtChGibQeT4Q37uOcUZufFVX4FP9NbfufxXg6l26xqCI2rW1df7Goj3DP9QtZfHHavR2cRsq4R7WyK/4CVi9WY7vJJwOMT6vRef5045ywW8Vren6h340VDcZ/rQDNggFSUKON/z8/9Po26kbd65F2k/qHhJJuoDK6p3k/Ijvqk1xSoMfoQLVgPy/cEFbZt+yDUKqjJDz6cUEnRj8THaSIDxrOfx6uLFI44qFWaPVCE86nKEvK9ws1OrAJKgpgaLCsJsENdkh1wwjIADzBhlGd1LPqhXCRnSx64dM2WRpYXgZWNwUaDWx0Bz01FaduFEtEYXnQsP1b8bZenpp9L+Z/3SiXtBfb1SUOKBkdjeAsdnX7/dgndNu01Oa3SLrLTPyEQXa6Z3BmGl42VyqDwD0D7bU2FGfexcooqN+xuxQKyHtxORApPjIVLp61B3UPxvL3SQccy4ApVaFtS/4k2zWAtqLo3wNQZA5KgWcSGEzSuuqUGrjq1rVqV855wJDEuabt9VJyofb5BAo2Ep0TRT3Zyu8o7mWvo2HcLI6l9OoF4R/mC/P4QBFsZdAvOAzQFb4zUbfgK0C1tSv4FIu/KgKxBDlqwp8UASKMXazfWo7iUFD9Kfv4CHUOgWwGLZjHTL/c0YUwtMF1uffr5T5bLVi/V7sEF2PfbxsPCk3vm21uhEWHQqIM7p1vMTgM6V5Z7cz6BTB4ERlC7WX7ul6LzjzG2MHwJbTSLK7pii4ZHfRhxo0tkF49RfjR35wGkajK/uAcJDGY1OuquTW80NEDnQw7Qe/o2eHbo4+3uj3tFFfzqhcnEZpIr4MR/n5Yqbca7JIitX/mfVnWgDUGsQUerXHgzgv9HMiYAgG7vF3h2xNXtBXxO7577MAyVn4T3XaATN6phRN5eoS/65UuZ/tn7TFK3VVYILpnQNncYdpePuq2Qxfh0M4sHw3gbW4egjruXQSD3C80PTs3cQPnyQX0Zui831GS0pC25cCxC8rC+6JCEKaUqiPPTwTemTMaXGaCKAE7XzFQG5Dvs4DDKEp/ht7PWhu/bOKLQZUVz66UGSydIX5Xf0EBciPaSpwJMtBeY1c8vTSt9FQHLPhh6COHJoKPrwZoO+JmAk1WttAFLOqGl861YxWiWnMPsqOLLoSRompdtjfZvSliVZgF0kWVQ9AZjFb24KR6gKOlfFyQcpYIHSUk+LiI2GHXtYwgZLd60TtC90IzMPXL8SjcCIbEfdI2A69FopDP3bYbbcHxf0Cv9L39OXyfuY5sBBupPRRYi2R508Q936BobQL8TCRJzRn3OQrvxKxTiF+aRagiS4pWpXNuJDck05c7+tqvcgpjQxby9bRbL3buHYuEEnFr52esM0WEsYF5O4fA1OmZw30gYyQJGv/F+lC2EU2I46ARVvPtEzecvm/kiY5l407PKGPxO2Q+EeEw9mhnDs+B9zdpZXRWyBoq2WqPRlbABRSEZ5fRInyAkDxfCdKsXmhHGAonr7xFoBeKDDsaJXSOcCRC1m6HJduQHTWKSC5zPvNjXnbLftR2EZhyF8U1wyRZaNS/IGHaEaXOHeu0urXEJOeEMyGkp8Poq/6a/RHdWunS1eFJ+uhJ7TgjeRE5wGR695lam9FuqKmmAQo0heZsDsNPcexUAZQHSAGUWsAiu73AOW8T7lyKbb3SW0FkNjyUuslp1W5mXlnfM/OubAhFKuPgfGTtZPtt0KRyw9CZM7k6sB63LVhicmRc5fSmItEAc7i1zwTU4fH81M7CWl1QIe5cbWJV7qUNtC2SpPlneBFPMGhuwsT92qtvkK4HWCNi7x7ItkIkx2oS3soU6fpwkmlVUzghf9trh1Fp+cE/JQnQ3B0uoQZl5WIegJJMA+4MYDy2S/hp0KDfBvUvhgW7bXpJhmVH19BSY4dhAuV3eTAmxNAnj2C18wPiPa4SLZF/AAGG8fVVb+5b3qaoqXGMNmE1A7PL1pb3u9Go7IBSey4d5Q5R74U00UVoDyerEhxwNNpUJ7xTNlfw4pULqz1J/Pciy3jFFkkchXpdBJY9NO4k6MAOJcMYBRhRyHRSbKmgioYjh7Dos+uBsUI3bZY6FWlz7yjjTnEUyxKQNPN4EZociAOwkf8HZMAjC+ZT2lXJSS0qA0MiktKzXyVGCyNUP971j2kJ+QAdHwMgiHmBaoYpa7L/jjfDvNOmySqxd9QGxnKuspywUmyddABOf92dwPMKn/3J0CqlZAlSLdI5Z34QknlTj3VqWxpu4xRVamy9IzFJMUMpV7Au+LzNA1yD20LvHjRd3hVOpKeOU9yxJ3c3I2GiUTE+DssJ4VI7kxY0c2cVNUn75qoXMHPyxjt07LtiqBhWTN7m398VH8I0Yeh0Keisp/xrZ8GSDVvWEL1C74dCO6AArbfXvC14y5BkkDI27Aoe4NYYWmgQ7t3CvCwcAZbxFn6QsZfIe3f4cwPx3SdsZMp2mOs9KLxsm7A51U2tjIw3R7ZA/OaxXuYD1v2N9OTYpASWD5yu/fu11VfHlgCR60EwZ0/7JCJpELBIbptPnjBH/C8l3x/606VgxqN0bM/iuYclONLNICDTOq/NyyufYAkvmfOrYhYhCPLmm9DAbtak6vvuGRej1AZ87/SDhcOISiOTdt9y+3ppbnTdsW5l/F3QfcLS+fLzTY0Fj3Q403ls/FuJwPhoPS1j1KmUYzCcpOZDlbugIlI2XQRKrXqgtxZJAxfAiGfYc1eNXgQvuZHBv8jExItSmlrT4zVJ6D/W8xIG9ajKSzEIZ/1W6jcLlEKPGKj4kjyVJ+UfjVD4GSnTymxaIfIzrEjj5mNHpNLi4cu/OloykmF4+OhzB3xIZX11lg5RKT/TgsBusqpMVXTua1G2qqt4SGo5SGVupLxILOrGw0s5yrEMo9XgWinTudGqZqAz0ZGz+zcakfCxQshI6MqxLOSraCSiAld6GN6yoyD9a2NUdQwoCaGn2nGw3j7sgbSHxIg0Y5TqTbqyHEA9eYJbdBWJ0AxWHltsbI00m+BbeKs6LgRcJQYtuOUWYAmZn9D2W7z3hMaQQKN/UDE7Igm/q9Dx4TvWEL5KoDiIIlfO3XgDDnltp86ce4tt3mumaUZRQaVPgPominTl5Wves3dSTPgV3CEi0KvqNoe5h4SGcbgL2hNOeDSdHBLRe7t48lDWG4wg8tPOdqIHZNRRy5FJnvKh4E5E3W8EfXdyAyxE5O8yWHUEJNGRyh49QgY9EHTjh9obP8YZCFBmYxJixPCzgISoaFsWzd2Lv7zrMoDbRQq0iA/m3ZzYGPU6IKuUT/xGj6daDcSw00AMSrLLRu7HHy4shEUcXk4z3BGI/HAxnzyhMGgqvJxPuFEEmC/JYQjT4esz5WpjRqCC+ZOxENvmEbB0FKducO7kWZrWRHEOalGaRY8ovV3gHkw0dtRR0DSAX0/JW+aamh8D5oh9nPmgdTg5d8GD4Tbh82omqyp5XyxMJ8pF3LWjFiLUmul6zmvvWAQ7ia/2ktEm4lAqO8Qorn0E5wMVKVyw1FiNr5a2jEK/TS7uaoICBdSGbkgY5dzVtKZRy5Bf8KnmdT2UuDqu1eNHSHGkI5+HTxGJHPOf8WBikpFvxcBlK+1PJCVtBnHQC5FDZQmdWxY5X2sELKppyT1eJH8YjJEAN9c2s51Bxb1LxRfxjLTIBP2SA17RHDoMyVujjerND4JfdL+ptBlPn1vPXc4xMpDQ1goE6QATrrvHsRyY5VCh5wC3q4wVFHsqXhcIjiXQXeOWNtewo+dLScL+ZM6U8WbL+GKk6RzERd8DgDQwUH7hPEPUxqcG51fVv7si4F97seJmWAGxB/B9yfSUODxtcNStU/NJpVCn8jxMPe8stTvQhDGvtsHXzOpZ80p5LsgTXtRNorg8acDZDB6/lodnR2QgOf58oTq+95THeEWx0FPjOXUze1XFySegOwSm3B2GmQAIVjPFptgXAH2lHMvYGr4ITRniklQUDrgdrGPlmFAHqF3oLHBoi5XaDM0o4HnCVLekGv4gntM5KSFb0xjWWyDSC3HB1vxpL692l6p95IPEhLngXjLRsx2hwb9wHkdeywFYkEJSgfj7QWpYWoajp5eOo/YQ0ADPkCtPmWf/60Mh2Nj8oH31Rk/jAOfhU7wcOl1c9vvTNmPXo8jm2ea+uHwpFod87zUM8EwTNBqWbQ1cTdu6TMjp9WZ8KC0dpBDLs4c7GqaIboLW3Pwt4DOOmyE9SUBYMumJjnjlpmOZoeZQaGEVDG43bOY3EvkUochzAc0DP+DoGbP0G8CLxzx06EDSXVOQnaUs1zyaoXDPR7awbg8wkmGOg/BJMCbjThbFor8XG8A/Mcv0lJxohtLIgBMooDwuuwolSHWedomwut1mCWHGojowBT/AVB4YpMRU0LDTlyK0MDD8TeOEPGuSsXlS2Tisehft78AMCnwjRlhMA7UO1TE+E4gQQZIqjwO4+8wQ9WU71s8ugefEXsAy1yE498LThzYW87Bxs1q/oZ/RrP/KKC4zVd+LM2Px4xU2+21x5rYiJ0BzQB5DRF6P8LWQaXn7czjOIHv48t9zUle4EGAzNIeU8agcl8Dbk3c7tMIThyn/d7p0pWCIYa9f0ug4coza8Zp/6U5hs5axV/DNrtlvVfNnUZ+rqqRME10DOasGeUbZAysYiDkp2yU8XRIxhBA6t0temRrWm4ucMqL8aqlmsF4ZwV9Vi2Zx33MRAHABEFh4YtQLDCwPMK66c/s13rzYEpcc49p3PgP+OP9kveMCI3xGVaZABA90TvahzPOBLDSD31NncjlS487VhMbmlT0bhEma3cWpqC93WTMQMHqbM+fe+Qq6vbf7PMPb5v3X6jhZs908va8rieg643AITPQRsfNtGtpXKpPpl4G2k2/6uPu4r490J92yVlCz2enpZ2CW4f86mzDrrfgM75sVDZFtcv2O+K3sEORAEIVuxoM5rm10AFXULlGWIumXkyr1kSrM+ziaZX54ZyaShl6V2Cl6W4dTKP5B96ziAA1bZoXBPGyTR8vvzdDa7I7SdV9JRHbuEyuvpGCwi/mbp36ozCAB5LNMX+9pJuW8x0NI16OybmrS0jZw/lS7Ee7XqxgJiL8RFA9i0oOEq09MYKvy0sEL2IqDYflOPS5ZUuccpNHrZL4l/XMbbXxeqHbBym8DChTGzRcfdlFzDr0vHAHrk1dDJ8MpXK5/ZHg2dhBf4pG0j7ShgFZyjT8X8FHBObUSqEy9s/9NrPUrJPsVu7xNAmPhTAqWFNhi0+hnav4cCG6qWCxdD2tRYwsmuuet8OS/xwQ2CbssGxtQp6d9ZQ1vadRWa0vfKkRQ1H5MUredbW2AxnbItNaayT6CY0dCq+EFiRNK/bZLPD3aoPWkWw2mNXcwWohzy72GwQYNIz0EHvYIAukvf7HfILv8SAIYLZSx8N9brdM/BAssxJl0m03xm0VN5dczGlZWQ8dHa9CaLUJs+yOFwCL1aoKhrnxjWehghtbq4iLqVZG1A0uF6O9MS/FpzHW7KnDVDmTsjKO1ChAJVijwW9fHYAzbJwKL4R2HrUp1eJDZNK05lUjlY15h8GOokl+Y4yvaqST/IaBtKh5v3eyGxhUucIjXamflLqwifQn0KpIauCiyZ+yqqPRe+YIM8TA5YDMzRcWhPYV/qJY4BBWJ/d+0hN0M5cCK0VKrvCxkqkTekjSi3MxZfh8zPN1BQXl6N4VYpeTQ9pIYPOMXlQZuLGHxKM4W0T9qNgMbr4UlTSsqMJPZ0foSWw912DoYzar+bs/QMf4FvGwnetxind5bOwV72F8gNQIA5L0urxBEOITj3KV/aD9Ylt34MZfjdd+66L/WsmFNJYx/cK8/Ckc4ZbY7r91qC0K41+KDX3gvTOOYxp54rmHETd7osr6RP5kLes5lG9K6guMjohUUiXUd04xEYBDTgWYKEERdsH9Oq92WznxZqJAtNxoGnZ73gnXoQiqO6iFWJYIvz6+vk5Tl9VG9rJd0c96YwcSrNYypStq6auX/jUFlC2dbEfxURusbcRQVOsQBBFn8zkuwcEDTjpxzr0fQex3WnYm5bMFDx23AWIMYR4c4ofXEoA/stK/YqjRarr+4QKk/ugV6ijB34KI0xlAQkH3moAB/RKSdIAlwrU3ltDQcE34QTr9HVu9U1xZwxxTrPzBg5ap733L0b4wXEkYRxOXjbZYyDAz30SbvtwHj6u1cQ70LHdXZAr92rYsKPp8Nv7RC1KjP5UDRmhMgbUuL8gat3GinUiwTP1S0a0D6p8c+PU4BuyGRqF2I1pv3DAR6Jg05thEYzXpGc8AWhoF+wnrzRp3ejPyY3BDEtiO5X7bBQBlViV30RFMKRmK1CsPnY5Q2QOiv80WmYSNwYCGRmldwnN2vpDp6yEYW0hIXwTLLqiSd8AvD/rD7mLDXEqFgepdGcbpyKAHgxxik9WpQoAJedBiCq1iL8eDmsoc8CXJERBThVeF42uezkSRBy3wWAWRmTRg4lAfBMj6TujDwdhySemDOMQeat+jlsLTgwqnLB4jU2S9J5Hm17OBskA0yQXWksD0I8M5OuQ2lUzQNrUo3mK3SopusPddVJzs9LKDs+oOD75lYVydyjLYF/SCz7hMY7lts2Je9bQAvJI2h1l6IWTBOYpL6+5I6X4dRNgQOLALc9+gQrcFaar22UGGuvF/Qt7WwzXwYgUYOvIF7CUMj6bp1UjVOCKLYlG/DUQ8TMNCUQ43+WxrDITvHBqpq2SoDn5FlOkUDty+pgYlSqAi/s3dpQZ7QsxcYJtNMJTzijhplbkczUbSM4a5rLZ9ETCqVPL0eb7b02KKdAvt0wFPYd7B0Ey1sWLitnDWTblkzlDpcEGtF3ygtzHXXjfpTTCSd75RM69BQz9muW0+N88n87czA+WKm7M2mYlDYtdREz5riDUO8ManKlw+R/nEdIblbXPih/OWeMdS/RJeMvvJ3kNFBmsrAC6eYcTJK+L4fmr9T7ZFFRVJVH+BZbg344v8XvhRBsb2lyx4tNoWojx6atEZ1EUgm+55Uzj1Jpj1Rfj05supJculJMjiWdFN+zIjMoJhiBdf29LL8JWYMtqfAd+G7ogOGmRdn3qBLmDRt7vLDQyWKUAwy4WpHZpWwEA2s01zQk1EQiGtcVGoir3DuVcY4NDPQ2u9pHvN2mEJFgye/fIGiQVOhe2C3Zytt1RgSa2wmGpGb9BJZyGokW9/UE88mM3EyGah889yRAZIIIMX11C/C8P3bgBok/4F2BAUtgvukyYI9AKiQ94qan+yOwiPpUDvC0rbUGANx6b24Hr+o1IC0UuNTmFS7vDY/BTnr8m1iU85IUIrdK+lmTz7zY8Sbi+DymLDSC/ep2KI3XcOsFCsX+fVTh/GjT1TpcIdzXvRaeevX+NvfuquGFBx7MIHByGQ+SPwBjWG8PfrvswgcKALxdhcJcCLeiT8lrn6mFqw4bATLcqGCNciPI/VC4QjkVdWGmgRTU/SHCwJZzlF2UZr2mgNlaq0eKVwU4p5b7jwteoLUqEaPtxPb4zgG1etHPnGt3oYcYltaQ2bXq/1KVpeoQd8Pd7TCC9zbIGtE1dxnnNAicPhLIudFq08ClotPOkzdVTJuUEbpHHbpua/Llnp4Ykgjb6RG1ze1rNGPsZQRkoUe726MSmTviY4sDmljKVklJA48ziosZ+JxtSTFZo/rZjJ9RpOukyhTVmjq4/xv6W9Fil/pLw+z/f4Dg9eb/Xy57FAJv/7wxAoM3Xv7pfDiBmaCgkun7wjZ0cZxMOps2G3qcvmAnGo0kZSdx+3KQPnJq4yIfRyOtUMnsayJIdhgifHmfNZ3u/A9x8c9KhOY1c4dPDbnnGbCzg1e572UckmgwQQ3fFnHiWnDymCl4wn+ebsvw9whILNvlxGvVoLbiTdkJCuU/HKbbsnNRm6fcfL27SU1d3nR3syc6FH1uu7L5KBe+QFeontzsHr5vxAzcmLzq/4Si+rKh9gaObus9vflxuxn1exnfnBUtx+rLKhogNrfn9lZWJhTkYr7Bk9RMVCyGJrmyjkob7/7GI1QVYyy/wLBeXl412GPfBrRvzUg/+xGlaMqT3Z/MSHjqvEjrlXogHgSCkiXGGV6w4aEzl1W4YhfL+OilqNmv3WWS7+Nd1vLPQWzvSOirbXB8ea/rlzU7gqmrOCXXStQ3OK1WzmixQ7On70Ma5h84ljgFH7S9tJarrNtpPLy4MY0GLk2tOu+6b3PMNvupevaoM/6ttfhLnvR08BAZC/9W6VhfS6v09+X6iy0lXf71Ubxoo3hHNQM7RVHTqC3UGm94qJLeXUp90oHKW2F65bybNWxUze76vvZmdkd3URdKB0y8fdzdjBr+G4qqNlfNub/H8OgZLFgrLBXL2zyxfn972dcFg3DH+2dp59cd12Hu5o6fL5qDyCG2Wxqbt76nYqXvgDDCiMCVSrzcUkVk3BO0gc4hO4cSlnpLaO67s5BSPIQmm9IZBbRHGq930xfOoy7sP8mSSdhmVChgPFVvx5J+i/OuakHBHobP3r8HnsvYlghaia4wO96mlZi+mIolgAXJrNbuu6vI1zFSEIB2/ug1wXow6mwS0EF3A9E1kbkvqVw3Bs0DWxqhHFHSCYijlq34IflWI5Xf9KD+mlhpRD1hshSUbCTVx3pq8VyOgtV+kUmowJeURSuiRb6aBv2hzYRr2PaJI6T2+48Lnrk6UAqCqapizVabTj5rzx/g3WZGFA7Rbb343mqB4skzfTTYK75/DB4kFkblDPffpeKGFjWhmoVbQyJwhSsEiAfxBz8Tc6R/7oY/K3zkRd1lLZektaaFRmteSIUQg0o8sNBcAuc8mD3ddXI4OHyUDlRr22jhuLDGOdqBtVzrRVmEgsyYmTuQ0TnMqLl42hsVVi/u2MpTld3UxhSJ6Msm4hS/KBlUkOrG/s/bI2F33dJpccKYTv4mEksk17qAhYLTm+4Q0V0X1Ec+Y1S+GlGxh8K6WtDqhVRe8bJof3wIYwDj/HjM113Bc7YAS4orY/A0/RWwpIDaDo87kCAPuk0dYxcR++mOBHPb6/Wgyrv+2U8Md45AAYH4KBOzVNM6Y4t/KQTT2KKgtM+BU/frWN3nzrYZghW4eLYfDZLYyaE700aWfjBq/TCK5h3uNyKrYLKioRMC394GwYbZVGrTQS2salgycX5kv+9+dyAr5uO94OUP9OkLnFYtSlg33BeQs6txilGgi7il5wPROARQeK09AmgRTJchAKwfTV2CCMcKESmWES8JMa22IPtrAMImVuI7RxtOjjdhkYkg03x9QCTYPYCgBXhv0cESTwhvK8gfdHY5NrgMmsmwoQ2KEy23daDLXJfey9L62hu02VmHZcEx62Qu2MmQgdsT/ZQtW/Sc2nZalR75MPcKcCFROePaHB/EWKHC/cOo3u3u/dVO5WtqOR8CJsvniD9YHnSB4/f2JEfflCYqfs6x7NP2oCWC/0vYwhq8cFm15ric9CSmqs21F6lwfb3rRLiUgalYKcOVrE0gxRqV1iW47Z1mLiJV++2wZqOM1C9iaTQSRW8ELcLvZrgVP3q3s0HXRasdGwnUx9Eiu1R/g2IwOX2dIhsKPMeeDBtdqnr3YgS1xg6+bZGRzrR34wTthEuAkxDtM8DtiSJsjPh79ppKnFbrwu0HTza2KreHbczIFWEeMicda3FzMlmLqiGLwmPZPpImEX42NibdbFxaX61Bzyd+c7vqm1b9+DGdqfHeqkXBU5irWHo8irkqd3IODPKYpqBGBmYI9iFbbFimP8+l/ZexaX0WHx/rp6VCfg4BajLPdyXSkdCloFlZ0YJSLZC8Sqntgeb9lIkSgtSU1BG1Vs75SyKitqal7qOQGywWoEAGBsuY977EOTEh4RrzrDdfF8R/3UphbldngTkoYDULDAoAV1E2IeFcybldDNL7gFv5rjojEQuHf78vr3NE17l6NqNp5CBQ/yoeullQrAViucgw6ZjKioxcQs1C7WKvE3IJfPXaBPPl9N2UPDnQMMcsfFlBVDrDawn+1Hgue2++h+iwrFdN5WsCDpkO0NpqNqZ8b/8i+sAbJ3SZM68R5ZxO69YmcE98nkxErb1ZJDQN5x+7pCqCp5Xow4twma8QFgF13GZuMGfllaqvHpDPA7neboMERvC9JDCxuGWZr8dRRVBKfdcyRAS7rgQW3ehBbHAUjWGle0U72gvMiDChGAJiqNxFQpFybVwzsoc9MryEX5Ynx9MxV4Ms8tPMmnap0xQU6x2CQLWNKBBeYaSDB9lCMIF0ENapv7MtRiWVQZLWQ2T/QDoAkjHU1LwtIrEk/xeYJi8EV/HHNzd7fVN8xdJYpNqtlQ5nUyEAFgU5jgxI6yCPiygrOJLe9LzzaZt6h2Mnah2LIrUDl3OQHmQrZl0gRXEcLCZgrQVg/F5CsHSrMF2EIS2IvqRG1sFswixoz1mvutCIqvuDY89s7gPxzGVXR/M/15188H5c9WYxtdn+/121eGzm5/ee3m7espEas+ip+XfdF/mtLZJzEcwV0/V4XQFf4hBt9e5eL2+5JJ0BmcpUW9riwd5c7MWq0/7pkUN4mzpRPDgME0k+qFW56HbjluI5Jt80+lln2iUeCJ96tCHgUKPJvlxXDtB6YvGxRFgbMnlTib024nxluJBHdfy5Hr1XjLXq4nIW8aDhXrkGNONBbaRbkF3BRiQsYi9cZCbSfKxVEE6+Qnr8J7lGY2LuUC8VLYVLdCZjs4w7yzbZajd+pJ3A88vR1WALkVt8KWXz/fvT91yUWoBX4txUTIVe6xkGcsSQ+lSnh5SlYJQAUaiL5a1Ilp2M6yXhb6cUIu1sVgDdAf+GDB3w4SX6S0YEgCNrwyv/rt0ZVItsUxiWzpfaK+2tJ8QcLKT/KGvzWaJgVpDQvrFYhI8EKdtuoJNtb3+1dWOxXeHREmcbP1oxZIS10qe2oy/C8UkPE6IdFDohmqbDp150hd9hR6FQAaBnB54NbrSTlg/5CjYVrWZXL/dWM9IUJ/WqrS1D6oOvUoK/VOE0E/lLOU5jud9kXbphTCsAnN2nUsJeg95K5CYPGbBmfT4XAz7zo2MJmf6z+SBWdJk91lO8FTS3mxLOmh+WZ+onOiKGu8AhqIl2Y8rhOKiO/sj1IBy3JTDY0PvXG93vcf7NgzNdCcYLvWtBYFJ84Wz4xO7xrcawq2qpOhzWeLh4haKMtealO0C4LhXBemuVFNv9fxyPGtY/7Yfp7qdzkl9ORhVs3AK6IXxzbpVvMKw8AYIdL4dJ0zLsUDYHyu8jVBE4l90n2BLteuxVq9ktyW417Bt/lMo49+R2x2GYHYggkAnw4lG22iXW7zoTj8gIJHrhmNWYQQgVxQ1cSsd4n0QBFMEE3KAFgfuo7LFTb+L/G43f9ohLhoO0G5x0hBhFvnThg42xcYu49gWduK/i3TDbpE3l02p8SA4gIhDX4wbori7XwVeFFZM0JHXFKLOqw1yFSVZIK9FXbLhr43AdjJ4MMutZHBZ4bXGszjOGj89OI0nQoz9Q8hoCFkILHGuYcgQlBcC3xc53S07m840fPJ/Az/1m/z7eLZHivxSek2OzCA7COjdcQlJDVubzusEmO9gI7B8PzZd0G1auZeMTVQSZ7dlp7JveTOmVT/Z63CURIU4TA6kho0T2/MAzed33QRDqQF02X7rtT+fftLnyN8VNJVQ48WPGYmkOKXRRg+pzjFPvVrgWlX0ObfY/Pc5cqikYPTGimdyE9xhxZOLrRlGwzUzt2TjQ9GZOgjfysGrbIt/WMeUaznbUfzQXiAVIrdyUQZ2tCs/ZjIyzVV4+odvsmdQlTZ0vvjiIrKuy61UahqMdNrNyDoF81PbZnvNtlQVV85wwS6SlBhrJ+lxjiQxRTeoI4ksYDZkZESC3ipWiL2Fck0B15voS2QjDzIVKyP17VD5jxomRn5msuPmlwDjqKSLge12rmd/WNV8nj2ipNKx1pg3K9sC8czKAiZPFBvUTJZsZe3pcYYJ+WiVgivY5dt10Foon+ztCqb6qj94gkL0r0Zse8iNwIzsatr91NhvX68XU7yGKLzTFlvZ4kDPYmRNVXhDVG9G9FDc2ESxtTQWNeoQ1dtd1OeF5qgqssOSwvTBq8kJcTXxgVoMwGyH+zZDVcChIm4UAS9QYMKFq30cN7qqR33wKObjpEvzjNwejHaaVtORPI/GeCaZF0+W/hOdP6FWNMP6FlI0+tE5CIbe7dM+LySoHQLEC2GnLWlPAG95sSG3PU2ELuionM9VMPWWLqBgU2fZQnUGTLhIBbTxoq7MVVk7oaX97epYjjXz3sKNzbyeC/PDQfrGwaen55mOG8wcQ9OPC0A9H/fpy/F3+tAo/11oV64XAdowwdvgMEZyl3JzQ7nXsqn+XGR0U26JO00Es7QZdMk9XW7WY3dNauYC5kIzTHDaN2Xyx4hj/4ooF48ZZ3ilnaVvGNUPLPCB0FhhIiF1MfPvaqQjJGZeGijIAIdpOnjjiULaJk5LfEHqPv6lGUVadybSCmmqBj2QNl3aZDtU6lH42oeo26WHmIQAU+exD5HQzl2Db96B3K392jeUhUoKWanl1TYpyIs82E2r/U2fj8Xeo1Zc2dE6weNwKx5yqlWV0UNr+p3j7IT4UmhaghMbogfkOzQNN0SGQCdRIsx/5Lw6xuGxbgLyPVFPFLc20i8hwNNx+gtGCWHGXnLg6Vd5yJoT+NGdX0Pip9358x6tnZZe5pfs4ke3mW/8e6L79tfSbYRfYUqwYF2+4Je/ufezKnZi1jZmF48bG4oouMnYbw6+YAxlJwKwe9f8vIlXVDkXG57h5oO2pxQGZVtKJX561k1tlJqtFzd9X7QTUbAjjIoN1zq4A0SuqPMzlJEGoqzddTkkw+Z66qvo++008vAbCJDNOBzIcp7XKlw7CUNQAlfSbAqfzK/SFuKd6u5dLB7DiAaoUl1itYNXCONgGFr0fBs5h3IId0SAb0/UR4USLKlJ0n0TnkTS3CKIZ14FAuRvSPOEb9/9sQ4DhJi/XI/kDurZ6FILY4IS9ZOEcabJdaGAmr850K4DCwxLMSDCdcZbMBILBN1NW8IBLplvekehCqUDq+ux7EVzapGUvFpX21EPIb+RbZMlLFh363bBkDZ1sJ1so/TY95g+1g9hMGllASk/spkMsLBVlmtVksR7Ey+NUvPDMBXXkYVRQcTKRM6m8k+CpmcQR+1C1biXKVwvNsTmswxJu2JyW8wSGhMdV/EOVa9x2QCG5PxOLMTpnfmAXjANfoGzdWXVpHE+hDZuxa2mUp/QRWccHqFbZkdJCy97LI4L3ZFxGDELtUHqbhLDkMwxQRSZU09PXVQ5cKz3hE4xGkFYhMRAr3G3Io3a3YucDVWVkqHz030PW9EDoUdE1gEQrxQAHpZptas2aKuDw8H1Y+D3Fn+OQTJyqhYbvjpJoxx4HVtctYUqibqMPwNdIoC9fNDL9aNgecUlAHbYjafMzxwA+jvK9eOvPS6wiRqWTFhTrJ3wSK2k/kdhAKGz9B5PbrZiOMm/Zvcn6syU2pUYpEJyw70I3dwCrbWru6cjMgZg5XKeAUl2lwuTgPsHcWns99Zea0nX5d8X34bw2fHj+KKeu8AVN7E/TX7biUD3w3HMhdpf6I1TAtB/YNxu9ZuXCvfq0C0IstePutAHwYtDvOn524TcoS+y1DxSgD893sgUWdJzzPs9l7/Drhnwn21S7s2vemDnDWw8Jw1/ePHTZ+Chr2SV9PCMrYKpgr5THibDiyzV3ixtH1aXpB+nc6em/pAyvSiRfSS2PCiQSeEVwGHIXrt/sEd72s8y8zrKlAMyhalPjK6U07Xf9vJKuQmBMLnPbJ2N12o5DLn0r4Y3SVdctOQ0od+UgCBizOL0NAWYoZcVYU8AYq9nRlj/SYA7FUCwJ7KYFBFKRw1AG1B0KnW4GYKBZkQj1Jf0fBLTv7JTERSdiiANPK3wAcVUeClSg3TcVixzyf3sTq3OF8ZGmxJFAyow6tJZVAuzl/Y1EY9PAIFxmm9v7QDGJhZHrks8tqAUXBzaNBVXzA0Z4wnmxWZXIFzpUkcGOcyIkqzE7Esj+XNpFGjs3HD/uTeePtmiXx9eD42VRkvgAj/8iZ+DsVqIVu+lvYAEwCBi7rmmjLHGRmyWS/Q3D2BVqvPFfksK1PFjLTn5OaFiSZT6UBm9A8OszLS7YXg8ZWNzHUHIHLymK8PboHsdMUluNuXmU+P2NJqi/pEXRgdbtd0XogRE3jdWhGL0FAR0iWr6KKR7CZ73gy4bIxHl1NPNz3Gh+oHt3vtKImv5flcflCKL1QnAtZoe6fQ9sL8LXQ3jaTYFW4gAznoltpBkZeKO4zjHepHHAVO9+FFFM8xc81scyDCGJA6sCo100Gda4hpWiCE1HWX5tOiId0bq2Ukd1ACxFGLNSKEvLYkQs0VI35aR3d9WPb5eeaOnplHVcVm5skEwNYdsGHB8ngHvoluy8Gz5/u2d5jh+SH9U/5f94vv+lxntaLY6lKTHFRvZxhS5dxk7eZlRSqrCLbCf1mfdwV1OhInz9p2LLR6UbIrAOU6tYt5hfnZ5dGu1XwJldqglGY2RiWkMjQ0YPTER1QdfxV6EIsuEWBEQKexuxnRD5tS5E29m7zGXdH4+e+bKKnE2cZbvYkRwMwygpy2THf1Lq+NnaxIJJG+13/cDDzS7rV/h0+BC0nGWFmmAwHSIs5Iv44SHeRpzgaSUfCbkKfB78gHeJsgBTk2RZvrxxPjhaf9rS+GKv4b28qvIjiWoUE9Ei+bGXS3LjA5F8gfNSu62onBa7/i2q8iCbO7oifLeSs/Tnku8K4+POs7QxC/Dq6RwsLQC+T/u5Rtl0eDmpvf271/tv3Hzo8mR/SR/R/b/tthwFl+lPlvOTonP1s8nNL6XWAixw6JlZrGSvA6eGPWjCV9r0UGFMCqK0OKH9EO8QHqIpn0q2LPMm8bY+MVfjROtbMWDXob7Tx7YnZGC4QKxEjjQY6179Pq82tIIC3Deh5qwmC6iU+gYTYg0eOovSV7XWKLd8eWVchnyYRv8g2YSxxmn5hcpCOlEhDqFr7QKIygpK82QbWMkP+6/i5GIPhfS52f7zFpUndSFDBTtyuWJqJtIQQCO5jptbF/HJjWHbQAKs2j/S4jAXWrD0Jgan1jplcJ2BKx/4V7wWSN9liIWVbaQBW0hSGs2iePp0bquxiqZA+7lcxZeaM2ptSp+ZQbi8PWg0+ZYPMer/bVZYdizDmNtq5GsSCV1/aZRYZlEZ9VM0u4zDC1JDbQXw7KFbg+fG4vKg75zqxgKsTREpx6zYZ8LS+2uQzs9VWNLpuiodUrrszE/65s7xFQday76yuGHcBNC5RZnh85eN4QL/gxDv1wgirKl2zShwzF8Qs1AieWGlwJl6ZWqe6ojFPdMSdt7kkFCxAT6fng9YqTH4D/RxZdt80NqDRo99lk3erCz/xQ82WUh/Bn51VX9QX9U+iwP1pSrBxGnngU5UoRwo+EmfF+45fW7QBac6eZBZYKHt+IuFNDjHcPGP5qJIwzpyfFwp8R4JKvMpPLWuM4X9Sgu7CJ7gq3nkDav1cgQzblLHPvu70eLOZTTRn0IhEE74XcdUsXthiJMG8FmiMK8Sq9mm723Hwt+svT60tFHnTjJu/fnWrU4BbiZViJ24Ew62R01SCaHVVdp5oDFYZ5FwPJ1YyrmbR2BgQPMSiFl2eweLcJUiNkCLlgmWAVaFyXvTy+he7jwd3pybbSh2MMsw044Qs+AULjZ44YCCSjPWWlF0Y2Lufk4s28d9oFtcj1BGRDWAd+3X/tIg0AZ0rLW7ER4LSJyE3Ln8NBb7qJeNakUx1f95ZVBaxTaO1alMgSNjcnlXdvcMH8Wkp+owBudYu5me0ZejCI/YsVhRp4MKaTQCIfue0Er6DVcMoxDEr02Jzjcu4lwm+qAr6/S/5FUXQ3YDXcphVEgXc3rUcm6dWsAIpxLqNDFTSuJySPglVGV9c0Bt89Bi4+o3qovv0B1pQpbeHG1OeokWLlToFiHATYBgTR4M+QUS6fZnXY6qRLAmIIPhNnquFkH9lLq9KZsgBpJlCErfJWX3hFFMFH0xK0JY7ZX2IhDckOh5LVtb3DF841aSF9Ee8MWrXrxOIGw96DMds0oRhrrt52asA3eorHeitWkvVjcD2cgFeZZkS5pLBAWdPLM69GjwG8TSi/qVslMsxV3tF8eJ6NmdcDQeKIovMNycwQyt9gt8Ynj/lnuew8ZbW2uEhb27cM3VqYQd70tJtyYX7+DaP242jYFedE8FjfgV0z/TP8Xp+3yryJO36liauNyfkNgrrt/x+i/FRjX26Y0Gxi8b9kMLBzVJ6a51gxsnQgrlwfLUSQk3CAQjjg3u3WOSc6Nki8MKgwgFnoZ8LmXiK83dYfaHhQIBu6p08sZHcDLFhQVwnKXqyMHoqWSobmkp7hGXhQAerGxZSYG84r+P84y5BbZkG/elooUUdu6GOzGxKJuI26PlaKxutvFlp5UsXeDNV+tiaYzCpaITiwIHmiowNEOzl1ZCIGZdrDM3AhFZOC3N8Nghnb1ZI69IS/YonrHkRebcfyWFOrIm5vYjqqwLLDAQtG7LsC3qrbxZqKcXQa42rXdX+V/zksP9scW1IOH0vrwEnhPs9i3UrIidEvQGH+JLfb/YpF52I+x/njZDrL5UQ5ZdPXaEs35oTK+nz5lqHXqk/+JL18YxTNMUhTnKINOs5s4fiqv++zNa4/Y93u3i+ssvsxH/xjKC87HUPXT1w2wHeoccO1Baa9gu2tQi3MvZeCW7u4Oc2RDPiy88TLBStWnBoDbcIGZuvM7nukYVsfHcO/D45b6xw00yZ9AhXvXx7nhuA00kKdDSJESLmGQtpkmv8a0Yqdn8r+lRzzrz2YXGsKtvPNkOI1+vQ+uvP98js2MU6kD+eI3l9IY1WRL5BEpmKGB1+6nWPctg02V4ca9uVQeJ6NO3Kcv5rlQaEtHn2qrmXbo8GMrJ9OoCnnNEtyONe4xpvrWtTe5pcd2q+Ou3XQjk0WFxtfvHX909GvXPubrnxgCrAb0IMJSlFGhE3n32ZgL3OK4Wkn/2D4czT8Rb7mASsPmj83veI4Ezj5sd2IQ8aiOJkY0odsF98QqLOEkWH/4igHZCacQaAgq3u5wsJ4D2LttE6vLmHX27U0l5/Zn2r7azLjtGoO3YX55UhUCIcmGCANpCJHYnObtyDRwVJdK1CXVsJd0a3wozOOsaahBtcQvaxhLHJ7THIj1RWHGtetrJLS3MVxljEiqQXcs9n3HBiUQHh8nOW9YwENJ8zPOutAcN2b4FYf3+aOtfkRVHZ06uF1AVzbv7c9hgMy7COhY17V/3ibn6tyz9/u2pQwWai9ZQ9GpA531qR2AmYM2TPTqb+6rs0VnqGwxPXNsWM48INVZ6XTqM7EigLXRmOXPiOYVq8x9i3Gsb+6e6x7nkDVQoMvbPaCRytMbZd5bERMszui/1V/Zmw0TLWfOq16epRZFn/24Y11gjIroIa+5OFETIagI0JKaSXSf2xjcFnVVJDvvdKsjI1i3Pf2hcBexDkk7xDAfWupIIgAULUbVxgN9CjUWHA95s51uLRBNBVFRjwmL9/ELb1sJnWorLBOK4z0WU/rukZSlJW0sdCLp9dmocQZU1ms9KPQ4ysjvatPBIyDtnQxKzbE4uyaIVWfboqI2O+xr2qUX1+2oPjfBO+KO7SSJ2f2X4jXPimTY2l/Ne5mHIgDOKRkEAm/b9XIcq/AbVUXYxf5NxjJNu/+uu+XWxhveIOrUS9PxhwAujnWr16oA2oKQRv0Si/k4F7nHTwr5EdgALJzS7ztCl5aCt4i2tpG4LdSJtTVpSHTxqi+4s9ooczCHA03shUp1Vu9ucgs1Iqodduus0Qu95nXaJLgLwFah3PLvbeSib9lu24FX21N+aZWXKZJRfB+tdQYRi7D2XdWdF3ID3j+0d7Pik80rXin2pUe98SxoePWc6oThU6Dw5X8DpCbSBeRu+c6QfDgqAANk29nahCLLs5hoQllKRCQN+wFo6X2zo7cwpphxR3rlkaAy2rYlkcFB3nouIDfZUlLMXNaE6yYhhxizU8sApBWyavCcz2vj1MX/XSXWpNbecgB14kfMlXZOtcutR+73CK+VvARrlFNhefqjSHRsHR11wq21U3yQu2zyKOsJeOptsdr8vLJo4bJQfZWDJfQsNuJm42itnpul3ROrvuotb5GU4JDmyFYib5c9HLrkawvzVlnuxYuqsEr+YN9aQ8Dc0DfKZf0ogLSZGD22dqeerG2+5YtiWts1zE05vuJ+Y/8I/NWoV5SgacJteOdE7Q8aeZTDwJ33kP6I25k5ehYpwE7T7ApuO3T5n/AmG4n5pZdYbs8R9VprUlNCbXwgQsAi1HLrcIiPYKVb+GL7dW/6jnN9WLMfPe2OsQ12PRMWXLI68hZJzrVptfFBfeZ3ngpoumyLg1HVmn177LILFGz/nEfnOo7W1dNEeRTu1lOkXqblkXlsskLIoHLECTxMD7bsEPSRLnf/3xXhdBf9rty+bbB03GXkKw2DcpK3sYIBNlr8CxF+TZVeZj1sAIo2uPyV7eETHQKWfxqhHKIsg04fEZQjqSwoJHuilRXEtyvSurMFKxDrg8Fa+MkW+F7wPda2p5TtQdqwYkwsZRFKWPvgYfeEoGYSQE8hqKs/IxS01LDlqL38pZNp9rk8X7k1PXk0FPoGRz3+eZXMtgXRaWZuS2WtEiNFzdJIBQ0TE9glXXZ1C95h+ADW8E3Nd96SMip+Pq2I+nhICvHneFE6PXamhylmxIQCOMTLdeVbZ/jSSDjn3oAtkppDupw5SGTDYPDVl+PcO5gizkuG3SxSF8URoFiHEEfXwPZXKOWYH1j0mjO7jrucFV5Id/ObF2WUNRQUkkMmn2RxfhSI/OGpa3X+VNrhAE1EcByXQy8xSsXhC3pTjzpcAkWCqMTaYDsoPKYWXOJXvA/uMkVRSBGDAN1OIJuYn37SozPGqvufd8OxxiGM/a9Jg15bBPEjTQaSJY+kx0A1z6i6Yih5g2w05RSiHIw8XAUMNjwcqPwBsYgn3n4FE8uAxbKR1SDIQXK+oLgKXW5h0KYLJqrqs5K81VghiBY0+P8+W3287nQINT7ta8+uOz+Ceh+tEpthgU2WDlpiRsIfkOB/lt7LJaa+q7zEyvxn8SG/tX+m3KHYU6yTCV81ZpHftDecSXrTPyAYWe8/XE/dWDvMV4y9AZAsBnTG4ViF1isMLpdHIb7q8H/5v+ltt8gTzXkgGRgYR43MqsYkenPE+w0/SukOMt4AtllJDz9IFXzApqjNG3D5l/fHrWlSkBqamzic1me3mjlckQpzbgqKu9WTxFdKlX/6tDsBaFip7OXv6s11FQMiaN8iU+gy16PSOzmSdSb9b7n9NG3ad8pZOaQjTSJZt8Piq0wSIdN/CrZBPUJwOraqLKe+j7aTKyoEdVeLzHZEghV54nCM+w30MF/oMqCNmBB6CyATjwvNPAv1qUW6DSfzTuy7dlLMR88fGXTjpymFJ2DhcEJ4cNRgQyUKe/AxoCvACMLOcPDyrZtL2cJsGroMMkvvQRj0zMN/S24iW6nvpL6NxkYK7HecBHUj8ua4xfQvVs1H7K7tKAtjJBNRtsfH4ksZWvp6OUpAXVSH1agIEXnjTO1/WMBpZDuH8+gQaH9qXFCGLgGtg2vzvyXFe3DWWAJoJBbFyRor42nADNlsAtxqgIePl5jqN9BxBdccxRBmUJkOyykg+aJJXSHW+2ggfmLbP2U6OO9TrqM0kcrun3kOV+/TP7eaXoX6L0iuHKOZf+DnBl+PLG3j798fzMgSTnGo/f72vf2oY/aNC0XPcZ69bcLb9WNY5i0k6VHWrcab38zQwjlv8nrML8MXWz6OcI2jWMOmDpybwrW0iRc8wBx2xPRH+6sr1+AMA/ehzfRbdskHBBJHvr19V26lNF6Xd8RnMDZdX1Dj4pDnZS0Om+A1zyTvPD26Vz7dnxmGpphdMiJmeCgLikX4YFjJquJJ/9PD+ip/NbK7folzWEpe6yb982WExVXOdfcX2A5qNFz2tCIFPlpmZTBN4927KzCXpEjzX09IkKlAshtzsgeQmCSSSw4ZFBXxmV7cdfRkrLMeq18yYRlEL+KHjJg2ncAVxIbqmxu/z6pIwD32qlAZ5zshoq/gLqOCwBTIUeT0XmBGGdK11M/dzoTzPabTltgcFgn2bVO8yrzNlNNDUzPDD74MQL0zbfr7wF1sJY+o7g0pBktmUKO/N9Q2RVuCcPhe4wKT+n2hngKzAcu+Jh79QFAEp2/bs/6c6uP3xbEVar0Zof+Mp/Qh0osZwVoi4s97Tc68fXkO6J75WrCz9TuYcHGq06FPXsu+XpXGHtwzk6r8qBYZdO0w76KdT7PqKOuhyXOWfm9XxpX+MzFl4p13+UYmCoQEgoAHok2beQ77R+ye6Ra1k4T2TsHe72IDjbOcHeTsQ0wl/O29PquN3eG6h+zw9/T8fwb1NEWcikuUIyWsQzZKl33K21acXAuMsHuHJUzFWLq1B1T1KwBgW/GNvVzN2mhdp8woOxc5Cn73bZ6hxPYIK0htb9fxW8qAN2b9o2aht7anulo5cBFXMd45Y912SvtVx3XNfu/GgSw6o9+be9xleiUFxf4ZIyWLPcd2D59FTIzeXE+3tvL7sFwynPko+CbSs3JuxxFL0csOq0LArROaovKSDRFMBk+I8QiYucF7RM7BGGxu03mW81YuupSaF/KQk3WDFqIjl4sey3TsdcRmkKRruNwN/y1T2PyIjWkDFs+blY1iGt0ONJQpIIeny9igBv6jUDzbwcc3dJDpjUZMOw9C2yEQzPnkKOh6Nsewowp6t+0L3AmxX0VNZwO7W5m8lNcvZIG/AOwU5wI8vdQaysuai1hvafJeTGu9MrsdwEqHa1yqJSrmJX6gmqvqjGSelNUerMihm9/kb8zB2RSPCuHhsuNst04USb5BlI7thL1NIuIkK10uzrp5q5WklYx77e+aTibNJ5wfZZ9gq7zpyEmiFiQL1Cdw5Inx2BMymOl++ceXqeWsloXHNPwxpatyWewHFo11uEtvw+FZGVXrn8hZQ2lVN3DUqZ53dbosD3lK21yyzOhIzl5WFhgpcw9EgAj+St0evuXvZvBIluujv98yNyYv7PyOoxpz1osPMC5byNb9/Ej2SAUb+YEe6WEbebqEI6DCG8Y2+2BuAhUaZbE1cPpCgHphq1CQygtEEw4KkHafDiQ3BKhwJcXMGYw967cr22ADdpwMhcNrpmQEwisASu8CTPAAb6u2UUDT5wLa9IhAcl3EU3mc0KpXbEzQDIUH7ywxYdRp1LZYAYn7KgvKVudFCBf1WCjZ5LqhbICXzs+cejDlZl93h+WsUqf9nCePcsvaxBn4KGayCGRBO1w1mLVZxSvyXfvf94LbH2Thy65KyZx8I3uEUlBOpSRc4w1I2s3CcKWj7VJUQw16juLr4cjUUcwrtO9XBvB/F0H7veH0xXqPggRnao8WolbXW/7P7tG5HYeuYfmPUUHj+UzCDz+riI14RY//3DFBQr9P6sLlVllNdVFdyZ8bIpRP9cy0zZfsB4okiq1qPx69VMc4HJKrkER361Z13xfxDbKXma24zYX0rsWLqS8Pq/M9PtHMNkI3aWOQUqcswDSAITTalwpC5IBfDRhFbzl/9Cu1b4HX+6vlVzZOlnyViJiXiRDJE5g61sQCejHjsfVmxqGj36wvMS2T0vIm4ZmDOWfA7ip25Tvai4QEbrq5yS8SKjNkW86a9EEaRrh0adHKasx8jNHeCJBSykGea6LA0z3gV7cQP1/Ds/eAsevhGU2zzdMji51U8O7OTs/rDodxa2POAXIgeuIsiPJAbWr4YwX/3lLLs4F+1wGVFdwgdgrjUrN76qSGYMV8KXHIcBJIWtne5Jid6NC1ALzdFyFvZBV725h8x3kf35zq1muVaLuDT/EpFU/eBk9bsoS8JRim5WoyL8q0osyyGxV8lFHJ0oxKlg7LEk9yphec7suBKCh/ndx64ayJ5TdGUx1xLxe64MzJjmtr06bmdvDBwimr6Ko+a1MasgL9PuIZ0jf1p+w0Y3Ea1xMLRT0RFx0j7hypLUJHt2QcyvEMHBgvgNlswD+LQsHdtJnn2V0QeYKcGpAYqQ+XuEPm4GVW5lxm6heyzTQcTonDmlZuNPsZUGsZvP1SPgxF+HzMLe61ek8jJqwzVlRMMwyas3XGjBzNZWejiJR4mAZzcqXfiPnyXXUXiRI0ky4PFX464rgWQENm2abZbIBgrLIiHBZCl+KSPCTQ7PNsqmpCtVFbLzWJLEc8Kn0rf+w1Lb9ebjEbUpqNAsv+bpvCfS3szt5vDNAOmr34GJI/w5loe2lIJEcx5zntCYLO71qenZQoG6lgh0WeE864HCxNpgdpUuhXVw+nltPMK0+K4u54NpLzfAtYPNWZ4VCQBX0MiAFDDrYz0OIQtDgixU209V5zUyBnp3fv6qugBeZnD11LWu/CScYxGc3uUskEc+aJH4W+lhm37fPkh05jaYK6bfSKqRPYdg4ovT338dDt+TdHfee4KfvtfhsBk8zm03/XfJbT9N8fpUQMdf99Lk9rOvZenOkstlt/l1c2zUuWRMjGEth9Ds4G5gfW4Y7Kc5MQlVwssmlnasuy0REEQqcum66njc7PdsiKb95CMvg8nWv1Ylr2PebpgdWQydVhrbDR4lJn67j0kiHld+IEVeVgLYd/mklprzDPaMgfQD7vAz1G+Fnt1/q3jW+w6SB72MTsGHXm8YrPqr0NNjFbz1abtTKTIbs7TJO71RvmktOqpvlb3XvN09/9Fn8f2nv+7t6yCNk+AXt8yXyFGUFWH8j93MeYAb1cFEcnpSpNa0/7Pyq3bis57xCvShmZW2M9trZmNn4sfzbNPgoiPwr3qEFd5/lLCQMj7ijc4Yyi0fo+B6MwORdWz7EfARjgAYVN5vQQOh2WOWFVj7xWkVda2Ph7yVMpauuzO6bvKum0+EBN8Lm7x/aonIqDhftnQcPS1f85I+3yrCceMunry+Hpc7JKuD9rlyVuoWWiGPZz8bf6tBmn+4sugGZZiohBOQxbQgcoLlTMYXWbw0FMEjbGSk98Q669icsdnAQ4j3jN7U7vQ3fvRFeVy3moOyM31mdFkHjakmqu73XqyxgHd267P35/VklUElQtuCB9yKXZnYpLnZlUR6BlEemoC/Z28/9DX4/hIQ2ysulOMjXQ9w68qI3NdYGnRuAiob7IwDDUDlDM48Bevw6ZDJ0YCXNutG5wvuGPN0cNO7EQUagIQv+J5/C6udmlnpzjvL9Nu+pmlwzKKYaq2bk8WGDxRduWdJxA2lclxkLnapoITxPOSF2o1s/X87l7HA+XDE3ce7PC+xF/ohDEoL+IXvtXd8GAcrc7qW7dLmlXz0SBymlt28vr94rQblogfGlHKWGB48JM0RP5i/V1fbZX167EXdr24c2A1ZhlAcTVzh5euRP3p6/aGd0Xo+tLaq4sxtVXT0AldOLdLp249s7XKaWNlWh/XZdflFiB3gqO9BdvDCUEO9orr7h29SASKtpTwGtS76VXZWjdoDetfDB8UkYc415fB9t6VB7ZLaMPJRK6eO/gLb6VPpWwD53o0RHyxD+YfthR8+APbIhbGuwWbDQNFhIfnR7E/JfROoh+Lr15FEi6oEWwv4z+S+StjMfB2mad1zDutz0+6C0oVR9BL3UvDeHfdyTwBTXY1ldWfUNt7dntjLRXTjcxUAhSCQfiOThiKiHynHm7QiQYoyDrzbaT/MrVTLgn5R1IoCO4QGfjbPipaKcAlDtutdpiADLB4V07icvvYMJS58MGVt3pYIRPZJ+4FmQZ3trXoqOXhq55wvxNbM6Alvfq2tnXgbK94QHbut1rMGl2d+8HY1zOiJ1mvz0TdfNLDlV1PyQmorikVFhHw7uH3MvlPziW4A2L2nrrfh3eXraq240tzC372KZr+TtcN+N60d2+1mk8Z+edgjE29R/aGKhtF9aIOVtK1QCErd9ZLXvtgxD1UvIJcjnKEVmufmcjF8D0iguvBrT3jFW6WW7LQ7wCBaQn8L8ExMmm0nsQ1+S79GLTc8+pv/Xjf/mmqfMv00nDrc3beqm14mZz72tUrpiFbSAhG4SGs1b2dODKPKVx4S543qSVMJyPx4WF64OjYY0X2cTMhIkUOUVgXjNC/VkF1NrrdXENKTblxKv/mPsjX6xcA4Vep5mE/XuaBLxE4RKN6W9Fpn8UWj64Pprb3bhJfeKA0rYCxrP885KbcxTJ/M7GWSvC52yYNCyPs1LbWJjbWREbHr+eFcQX1mclp5azsiQJfFYxSe9nVeJh82vWtvgsLfKo5br8/K6J3pxTi0Rm7bpTJ2KA56ezwvCwURFjqwXCSaZVW3/2JSCddNL5IRZDr3PMm+p31pwuEYNxiRhQmcMW0YI59WgcT0vmgVHbjf2Yu3gNMPHfjpIXg/w2kb8/p5uuYSLrfFO13KT5auz6Gw5CdKtDSHDrAa86FpT8pZHillKHukEZ7GMwguDLhkX9+TuZAcQXajhnVCjP4sl4IAepIh5PDlW8n6O0r6/BDELLKKy6ewaHYtHNfRI+rPiyKOAm0r6ey3HIm+SaWni7zb+Z399UaPm7LGYem2MWeGgzLfo7H5AzUTovelS5EvgQEi+w8uT9LRrgBof3x/RoKLNd/uzEIrK94+FeHwdkDTao4RiUemkknIjZiuJ7Ql45zygaxhvAw9h6i80Y5Uqq40QiK5Xxm/WpyK04srTdP/sOqsfkUcKSVXCFGC2fIwszl0kM02eea50AWUwMOgav+ppUXuL0DjvXUp/D1l+QfDC3qGsOnaHps9QSk2XJPW0WJCmHeftINpyXYFhAjbyhEDHN0jYTcGb31FZzFS4J2mLNDcYqAx3xqobjoiGhKAEf8KlQGVvv9mpkl1CvvblFdzqqX0IFVemKsFYl8jK/msnKe7w3K/uke+Qa0CNfkSzaPvT/vVdtSbIb5dCLMBNqwNL6F5tRnJUelku8mqtmxj6hExaxxrClHHfGMVa8LLzEtEWTZ5eYIKby2zio3CYq3opBi+bWuKHVGMzP/ak/2TAhNTSCvVmyiRLc9mKlxKES+EvKtJMuKLPsEzk4cWWd7RFz5htNULfDbhZliQDiBZJqHnToPj8jZ6B8VChKEkig3MV4aQ692F92Y8cE7pQN0oJ0A4AXXAiTjOhRyf6t2PiA/gX9GwHU6pp/rdONjRKQEfiQ67kpr4Oi3qd8JdYxwHvdGTv78OfsuM4YJ0GKZR90Xqt2N+pR0+wETgHSNgeBZM0YyhqLuHBgTmnLPtjvGyQ1qCvECm2COc3fp37tBiSYnF8hvr/ELOH2O+zrSSaHp9p6yWx6j659aNtaSikKfSCH6z6yNhjoTxI9tIvXf9S3/yTsEa+y9vx1RnNm+PpKn1/8u+Kv+vUV7QQ6ev1oSJ5X3l6u558lLRUUtrETPh6aGaP6eE7t8OWbt/qNf/6+UXx1+fd79HHTyjz5/mPGxsz/Js3/Nvgtu9P5ZCWfmXPh0zm8U3hSTaIs1TVbLiJWGRRajfWQNGZazcrUX4vW4WiRhuv0hn0qmqqntjc9eJ180M/I2NCf9TTMqqgRMketHvOSj427ywKhbWvy+O/N1Ikm6Z+2wwtXu2k/vtmpjW0UxAekzf8E4Nj1DpkdYFNnivbrv0FmfTZ9dytTWC28qhliOc9OHjMhT0zpcxZdJSy+3i/046ilKb9jpz53RCU41xRe4YqlzYeb3eG+0jlXYk9La+FcBqOEsiufrdnz1CuRrBbpsXkBqOSnNZb0c3ItOI9SyRS9bPyWaPeVFJvhhNqVQtUrDzu6oE3dCcOuDoDyF5WhoEHefXg6YYR1PJXQd4cM/MmuMNDVgBPTVfd6ql58db6EQEuMVgVrcfhlTIe6tqnDofKCjjrUcO4Gakp4xEA2YcGPlS715ipXgUGiankw5cL0v+WEqNaowQMb4pybun6rORGO6GBHjywnJ4MuNmXUusvQAT6wdn7skAkKz3dJIFYfEfA3BRhD3IM0cNdzD+f1GL7kELwqZiijDNeyA2uLKGrzd2ice6bOvXaNP36kFEDSJLjfqRSD4YSoIT3WSzcJ71rE1prvXD5zhW31DpzyGovPIzKI5tjYPdp6zKWf1sXp5qMOmJED7Lj30YpliQkw/MRrwjvIXJYNp3ea/lVGLAJcqkQiN8eKHo6n4g60dhdaXrh7pnZcT7gKu48vgZwNDXZbYNKWWPE58pkJAq5bjwRB0/07HSi/tnLO0SsQDcSuO/u8d6VOyrvdBf2Lq7ue/xQWXrqcZ7jafdnF5UsKTlxTMQZjyAWzRxpRw52Hg+S0cXI3KiQScpC3pUuUCgpzlhaNRN0EFetb3emhnkqFuCzrtieFCpQ4zWnK1wzC3DNaEicHo5JNygWLR89KE0l1iGwBihonG7xIkFPJixyshG8ghlioSUEzTM3zziEVh6NlX3ok61BkO8U4I5x/pl37GuE+HxMw7ohGpKQIPqUMkpP4JKhbyMwbO4eCDs3Yq6fC1CzdbJ36HPtg58jOXD2pZfBprpE2YpFjFtoVt6h6EMMgutaVXoXRM6lOXIiE3gMTk32VBFssdozY7LTR9WTMJ8xee5ZySw5dy3vOL/4bfKGntw+QcB6qMeC+KNUssoNtJcBAXgiXWnyC/FpNPmjKO7rHlvdFJ95+oj5n8WQ//MYW4v0bByvYhZXOBFDdEFXAz1NmF6xwBfQzxLtuKYUq0Pv8gqVlgx++u4zA++yaeQNc+tjnCYa/OdVHbp4xq/cOL3wca5TiodviaU2GoQ+MxF2RtAuxa4h6ZIGU9rJRv8SBUljG7j6ixUPBS4DeehnzSRNY1E6Ce83dTxzf53ZU4Uze2Qgp1adjg50XTs8ZvVud7FW33i5V3+dHkHYFNuc+NDtU0fB0t/ZNgTsTSKwZt3zRF9vbwwbOURvGG4RHzLorGFzsqwjwzKo8e2iLyOOOZ3aqlvCZNdQ8NrDYzbqtt1igqQADgGVgJXGv2fu+ZykIZnl33wrjFZx/89TlhZ4eBs3rRxBATs8TavvdHbxSd6ZcRQRPEYGHgKrT4koANm4eN8r6umCSJL8DTo3/wylPs6lXHFfMos3AV2h9sdpOevPrkfkXmES1eWIcah3BqBiyiC5U8VNLdzKFjZ7PNAtdbb/ikw9Q9bHC1t+rc72YdvZy+eFvuxtbMwRB21Oxwrh3v1ouJpeMkHB70V/6+7X1EuEgxmTjRKX7ADWjxQfqozDuHpxB0balAURmXJ3mdPmboRCv5kpWPRsEtd0t7phbSLx/9cCEi3/9hoKr1Yf+TjUEQQ/K3ede79Po9eZf4Srf/k1/C39JxhWA+L6hkF3W9T+V+7eLZsLoqX959vpfyj6Yc/+qPAr+9dZR6NzR9oynNSu9q2jjqX/ld4K+ipnUg3eI2AAE+4l8fc6p61450PSuYXl5pef8zDCAGFthucxmtA6qR/bsUF0ZfyotrXu3RoxoHRbz33Ka7aq7bOoX4+/Rmekzgnc4l9ussdnOHPupPIgFTNCxu/m/oQp5e6CsGp3BJyUYF05hgD/p7WSeMnN+DF4Gfb4XMrFgi78EDBXN9mjY1qo51KT1KoocpqixwC1xw6QnJr6kKohV+q0h1KedYQwKLfbIWLE8H/IIxaRC91SEc2dd9699zAyQ3OE7xEdeWiIPDWGc9SP5TpbfZnMFWxXdfDnNZkyj5jWSYjP3z/5LtV59ftyhb8m++PnNPGhC/B+4DZfHZO+XH40jgl6ProK2RcdeJxNr4k+T+8DDluTB+9Dm5ylkrtJ6/27VNLOYgnd50XNeNXSHm+kMqYlTCNSb2M1aWGX8UtUKrxW7lbtSt7xqndam9rVld13eyWfvQClYYUXyUBxH/+6vEfwrUBg3OAB8tGpVDaIpbaM3NVP5nYHDhRdvzP9Q66M/6MJLJ+Qn4DtlBfchc6W0SvIgpqwXBrA/hEWjS0of+QB5xUf9E52Q6+1qVEiGPKSBMGZTnZ55DsRYqIBPAAVvzZhtyIr3FNnMV6Pgi1b6qO6FxkyPhMrntEKPPUfml/Rbaq91ZCled2gr4QCcY88eJWv8ibjdExv3r01uZpk5+SWhEIP+1roEn5ybnZ0u2KBJByysGmDKeOPssPNPuo2dr0F+VNNGGJBAT37aAhQurOqL4WE769+XD4xqwAVs6z87IPJegN8a2DO2yQFnxer3ykc+ol5uqGvjnmi/4QW2uph/+rV7F+J+kfsfnFj3m2k2xe0y6D6HbqrAm+Q3F4DZcPds70XF78P2k+D243FbLsu6lv4/SW70xg4i+/id3/e3mNhvUzGSqAEst5XfVGw24YXc6g6a4Erfs+ecYV1TVFMt6bLuN1LFDthp/42hGBbCSkjaP8hzKnS+LjTgVvbJOnpvWNEV5V0mKmC2Hp3PIfIabtlrz7gLNgZErH82AT1s0c9P/91D+9bUR2nuAjwKKq6irrPW91yISeNln/L1Z7ffd0Cki/iWLpaPn7KyZv5Ovdlz5fC6YJzXFuU6DcbE4E+GYHaZdqRmU5XolDwlgSsvjyDZCbx/I8y/WRcH7AUrXBV5SQ6ndfJn9unwOgDDBcEp8EKS6HFPawMC7yO0gf4JX9+CjqzQlVitjdA+SvqfkAffqSSPZIUn0bhT6sFjHzxtM4seONTXCdZfnCbdKwtvYC+lb+CXExHS8CQyeKTJTZfbvMUZjxJmo7+LbIKHmxKR3/mguTkDNO+wPKCKAJYFN6rYNCik/EZoo2ycXvffFJDYYMj0kAFca8ELHZEuTVSep0dqHRwtvhuOVKCJcRY9+L4gkFw3ECXfLb4rY63fdz4eHipH6rMMPolKOIW+WV3k2wGWaCnDVqzt1kSaRSJ3QTU5mKlgKSKtSIh1HZ1XrCAsHr1QY392UcPNa11kVPn1C4UMvKB7FdrPWl22w/GdAOx20qk3et5c4vPU0A+2L8vsPU3XSwjO1uRZyZpGkMPs3SNZuaKc2eD13cAvN3CWUBlY34Gs9tzeIoCkXEdj82SiGN0BlsEP0pWkts0Zh8FEHaDN1/ghyyDtRZUNOY1cZjSoTuq9mLmRGLMAoU+J5UU2ScMAq24X1luhY4XVZMkDGHMNC1UCu2zVgqdg02shYbhRP8HFBnKkmzV4S/P/b3flkIFPDM7OyWiw+ceeK4YNoB78uPLbhksLBe48753bVIuTPGx+T1Vevi80XqdftRf8Ghhap4rGhIb51rkt95p7zheFuKXNCguLBkYD2exFGfEt8J00fNqoPIylIbYq0aLmeZDjy2j+63m7OVASSPwB0zjcrrJXwj+63kG0elXGvQBoVFrbodJ1DYmoxar9FI0pNh/M/5F5SQQ0OKx7ahTHH5Zg/0lGLuyyHY7Ld7NmMm70/tle7xvIt+YFcWyQJSKK+ioZpWT2bZqY8dALhMc6gsij44m0Fw0Wywz9lHI387w8CUAT/xPW/2T3x8oka0oYHVhkRvdvbTZNLHGKr1khz/91VHApU7N4R55VPmJ/vw3KmJ9cDtumWZXj6roR4fd8smtyK026XHB10Yg1OqRBqT6lIvguqMshnprJM33zpXk47ZkTv/z7ye/5+vROrF9vUaitU31Jgui1w8/pkccL9lbtqGF44K2LLn51CXViumELiUF9CKIxVDejRSdW4v9LcHVCdz4NNFFoKevzvMEe+WRPdT0/CRozZJ2pHuPF46FRCbX4CbBPcyaRD/xd7OrtfidRu56iXQSeXkGnAK361v5Htf8P40Ss/t+gIAdTxHeGySkJLZebnVrRv0dWh7rZHxF4O9PXZDDPSo97kyPvoU/X7PdCZ19ctdBQ/hJrJ0G+P5l7V8I1PSA1kdJrOevxt5ZqXLySgnfOEq51CPcNup6L8Udu/jCYCR/HfVSN5Pmi+fRYIdgAiiYHRstwCAASLrfKL2o2c9KXUS40KJx+5tNL9YJHyEIuez391nj2wndrks3p1NQzugFF4h723VlRjOZ6aq2ZhvAktNS+0/wTR+Wxk+STySHGhBjKLSsY2EJaVjqO/uJexwDVpXpTCfsnghLmvJlHp41/1zI4cd6RZyN584B2KQq6U6WzX02G0Xf8Gu7t9gpGNOhly6MMxbkc0dA9giBY4NeWACdnGCU+7CkcT5mIgv5dBUdhqjEf2TaKvuwP+03ontONw8njmizpJAhMrwEmSnPpH6oH14uxSHFPwQJriU/ZDzkVZV2gSPGmQe+1XedLcmNYsrtUunYh09uFnYhV/NyMxgGrED0BxkMG9THiYU746AqGJPsqYjyEX4/8gA7WDEHdFf6ZDtUi5WChPEBrWLXJpL3rEvQ6u3xmIsVN6hPu3VMdJE9F9UpoUco0f6NT8zvwCg/7v/mDENdNtoe+tUacqKP2F97gDBfvpR/KX2wy/y3GaLDI+NfIfx+AUG+fiG39lfeEVddrWqT7x/1cuwDo7GYR6qZsVgYVkUZuCHxFG5JibEq3iSKGjxTRR6roH1xS9J5ZxUfOSnZwa7ueH3DLnF+yZ876s9ZfW9Q1YSucRjl/WgkO7UDxLq1p1iee79othq1R4NH7Vnn7T3EGg2uqnXyyybHdYwv7R7JkN+B89JRfmgqLsyzzOsOjft2/urIsclSj5yNne3j0AeujRzgZ/cZotyS9hgVE2Qoq/kYrIPsB3LI7Yv2Ww0Dp8Ubf6Cdh/a43GdrqV5uQ7k78oVtHaz8qW6km3fn3djydSetjFM6H1llLXmDU9Pv7qbWNKwEqtj32lw1TibI8buhZmv6N9vwi3vKWG0L9rvfxG4WPynyMH/AT1H801Z95f3Mlwtp2D93Osw6hDEnFoOYL9TyGTwm9oAwgVX5Rh+68m80DWPBJNjpw0ED8WklX2agV2hNrHkKGQ8af2Q9sqQEReY/mKXxm/N3EXzrSfyJ0FwgB27CUvU9DDgJ3lo4ewsjuVc5X5fmJbg/Iv683yDdsfsVpNZnsDE3DOouf5fruYW6G5nX1xa+0v+TdCdAvaNz8ATu4HleEnqhnx1TvU9i4/6ZM35g7D30y0xCPw42DqDzSY19dfvh51oDHLPK+w9TBFXbrR3vwnIbfoUyDArpImTEKT3N37B9wBcot+F2QzzMwWeMs2t0FbgdWcJ2r8qe5Db816jF6wrRduh7J0QWB0XwK0Xk038daw8sYhVB5rNjNfrKmiyPGXGw+8TgFJwhwcEYpVEEv8oEpcZ1LAyKade3b6JEQ0/5e4UL/T4VvX8k0PJM7D64l7LkBoeK9Dv1vyFT7vNo8bWc/XQ2g2+xXXN4JPwbDXXW63IPYFOXf83R+QReFBRXBU5xnpPnoZJ7KLdAJq7+Dt8YMNy3TbgpcG/33yUD/zulfUgfM4WmChpvmCXh9sAwIXr7+xMRds8xr7PscfN4U3vyYgV/kdbV4kw9+ZDnfrxp4CjgM+37gEbPmTOklYUQjsWvNonHuRMNO4LiHrdHymOR7Hq9aaE5tO/CDBl/dHQ9DLLCBuvnPfnhLGR6ow/ek4T+Th//CPPxXpuG/zeyfNlq/KGu+JUgiP5UNjgOyGRlGmNemdIpF2j6Tvyeig0ZSvsTm/l4T5ZIM+l8p7WWD/vEhCQLx1Ux9Vz0LwjVmyQZAfrhNPHoRQMSz7VUNPJQUR+V7vhqoL1IhqiN4infq4OQ6lFf7xgZGxbMRK89m4NQo2MRdZZac1T0/47DZtxVdZqjAxqinwMtsrZBl1usZHZ8eqWx7KvpI6/qCsnoUNi4lh9FrOn8DwFZpgaX4Dez1iZdxjsTyTSEHLJ9u1NKTTtitHvqLbjlylMT567PM0H3Z3HVl2C7QsAyCItt4mJkGxZkS2BL7jZkM8byZMOWuy5ajW3kEvTvTYHa1pFFYnI8yczv1HaqQfJi6VUaBtn2M97IzKaCzv8MVV2P2RdsiCX1//tEmHJXGROAie9sWxH5KDqnVbWQGWLubE+tVXIifro8mn2LLCWkd5Yp8e8n0nuwkccgVRAq6oBB929nZVrjYeGOc9fXKwjKZnJLfCcSL7LVX5bSXjCQrYCPbFNl8RS7xusozZzrDQOHP3paCGV91HGvRwLEQff3iPBjEvrxJwhn8UIV9C1ALCalwDigB9M8Jr/o2F01BpFijUKeGFdtWYYk8W74jWBAfcGQHNsQOmOdNsiMKhw2yBaZH5B2VgEDoyvm7P3Gp4iosq68VIGkeeuHnkenHj53Mg+qXVTRRkM1SSZkHWKShpq6m6BgUGgE3rmEvoKhds0jT2YlvcBxEuovqkWmdN0BNlC23SIMJ7RlS7De7AAG1bL9MsSARuYSLzb27qNLvxUrovSZmdxHZtjlXwuK6pHAIwHEw5o9/kK33VsDHiKAmnt5JalQCt4pHFwaxDA+hG9kkcwOz/xSqEUC9Yh5N77Q0R+Zae8Hgncdbybu4RRMIwiAx6hDbA031H3MeYxi2uGkJZlO0ZKfL+LQKedoDIAzl5Xly+Wp0bzpVr8D7lF15n4T6aYgGOaepS3BNFCkFDu/UhOd56Cofb4HB4SpNV2FO+ws2uFf0oRm7Skg8qk6s7B6q2ZF0ZTWlysQM/1mZTvZFf/g302srz0mpI4kIDwJpJZLRvZojkCSsqyLnODsF6o3qbQFZ4HHwUfkCJhZne2x/HbLqKacbLjNI7Ka2nUmtNSAX+6TpI5ghpg0MDT+tYZTQe+DOtoxYgU4/EqD77+GV47PZL939KBxeT895ayfLJn4yZuxusKfaLw/NJtX1y34fulVsBlJk0v+IgYPSXzeZOn1tKncZiX+UYXPpSgYvDCA5yzuuTwcIZe9FdDZI52f1bfYQtGxWYJqakIbFXc0Nyx8QeQ2vWhT1cjCmUj4nHyXG2UKKCPgg3HcYnXbvLEF6kgLtpHKRiPJ/l1n/XHxf8ZIozPPQhubcPpSv4I5atwjUabJALz6E7VbaAx60KyRrNUzEzJws07zeSOOdd1Bbum5r+d4q2rJGQw2o+/HfIWzHkIqxiWoMVbaxRftYtJ88faQoz89iIwdfjR/+60vj2TH+uSoukbnAnhyVDxDLM2kg7fl7za/ZJuvv5tvf+t77Nb6KI+z5VOyBfYiDueGG7Uztux+Fp/s5m34ga6x372vfWYPtR+Xf6btWaTxaZq0V3RXdydsXIFLBldD8BcEUGODHvfzYPLb4YTn0Lxmg+mAczOs4owGaFwBF8KpdNsWwWMa+Upe9NeSVWJg3yNjhOdrggFMiPN3XI2pxcw/K9QYHLQd0b//pC4VxM53z+CDtvPbdK4vBsqNwVotAFrTDBbbnLjY+6ZfMR87k8UFPAI37Kw+DjyVTHD1qJs9mGOHM1K8pz3XMVM8ysP7SNl/ScwzrinoMaQyZBV9YV2Gldp16BqJ8PW0Gcfhw1E3cMw+NpRl/p/RW7UiuJVwKkUa9N+625/3i5FriZjqjRdRBDQoHA1nlQ1f0U/vYXoKAZr9jXX88m+m6EGt84qVY4cxX1O2ePFnnFQmvfZHUZBX9QZI2IaYR43WSyzBIn4ejTG6DfpVfXkTkeLs9m3P01n99ldV8Kn1MZf04mVaLLam1PlNqvpw4DtB4Twh+FwvPA5UM5V6rgl5+xxdIwfqcDCQKGRAof1qNGioZE5PGDRLyqD48oSrWtONzppewHCdGNusMjc9iVMtJGRv17JhPr9hiOSvX0VF2tgMzDNfH3p8g+dhuBvLo2AoDtCD7kztPk3FDcflmd8W4Jm0dpglY5eTkPi+z1XB/JPTdR9fzwA2n1wLaJaZcBXWdtFdr4DGhDp4NkV5gAaf6+tkLkx/ul9JNBIi4e3/RHJXeur3bJIgD06S3poBuNIDuE5g/X0IG2G+VMfR3CTpYeZMrhaLs8pfiSk/zUtGhdDFxpesq+AnX14O9pQ9rR3rIJpZr023KUMhaSCvGEDzcsErxdV5I+Q7x2aoVBcBDoWUrCgTGyj/dvIkNJgPj/5ZCZYOBQIqMgdPFki7LsFpRCA/64M9QZeR8nXXYKWHSUnxTB+wsMIideOtlNoOsAyvHZxtzsUARl1dt7RxGcoK9oBBqUCNPnyUBOtWD9j6lLdACVU3oCiQ5mPeATVihdT17fu4004y5efKWtvzk1fvMqfQnX00E/V45kxYyo7SLSVrm6VVDeLKZiMSkFaMqmMRaPMECdP48czfVr3bkK/l7rRdaQWrKpHm/C4x1Na2x58+y1Du8qBAe407pxyC1mFdKyMvZcexUWOF1b5W14er+3OGzzkXB3bvajghIS6Wolv0Fst5TD0aCibmQaJB1O7jyhdTfj0/GAL5+Bi/TkSOZRjRkJFxBexp1tJjCJ/waWB4UnFEL57NabdSfwyRnj8uYyPRSuhGLqhTJpWILgUwtXZaWaclNq3hdizWZWGQ1Jg9x3Q6Q490sdPM98JdZYTpXorUy6AKyazUK0b9OULRA6zim48ZVkyQsNdr6uYVXzXKTj8yPuz/CUKEGdm5ly3MvdMjsLPTA+XPG9Q6eS64OWfdVrCk5kqlvqLie0KrnsobQ2Efz/LE6P/ZBSxfRMVEhooYGWe/LkBj76M8zB7PHiOll/oFEQCYiYwDBFfw2bzDeGD6ATETHAIIrPt0dfoAMjdu8/0YqZOHLNzyxb+rtkCTrprlCUt1pUiILh/8mCe/IhMbWfaNw73qEmJmPc+9+mqASPvtvni8aG3oKfaWr1rsIkC1+kHjRTEOVayjw98q6vZYudLRoMTbo3V7UK67Wfe3i3oYCOkRvGWF6vM9mytn77al21u2sj00bgCMpGmgbUR2fB+x2UE6AN9iFp3uBeisnZxvdLjy9TO4rKYHWFYaBXYvGo9KbGtarLFYLHAZ4HtWXVWroZo7uuyjiNR+9Tse0Db/C/+dfMwbeUzEi1oirEGpFLg/7ZVDWstQdv1PRzGXaRAOxeBVNKOmMasK0+IyU3sB/tYnaExtyfx5yKPq5dxpHNbLrXDn+5Y+4xbuxRbi/NIifjyJN7yW2bMpkpoDwjoBE0BkPqEa7OWX5YwC3GVV6zdM/h20QUpae/FHh9hBDbJrwUijNd2B5ofBOceQMdg5eJfSwazL9+kgdP6z8LNcekObf1MFsfnNqlE3D9ljbiWY4hXjXKdOAi4B/ZoO1rluQanfgHMfOaQR6MbIHOOHBif406sKGQzchqQi/AIGXXfzorde2FgxwspibbhrKPqjXVase+sVFK0SyDbilD451vC17wCCQeCrW8GHHQ958fygd/uFbVFqeJC1KYoqjfLyksHjLIC42/xJqKBNl5+FonLA8uolmpshLwai4Kv8RH9Pj+3qirVjItFXeZt9jcNsO2KF5DrtJA9Cxw/B45WZQ9H1Ly4/UGD2YZ2ij2iHl2NZ+QSkYkei3fdg16ZJ0lAL+d/3r1T6M+XsV5LZtpzlOIq3N9RWsjT/VKNY7OW9zFR8GW49ULeDM7vOWYK0GjLRf6EiyVT2UUsQYBrF/He1rrDWtzEMKToVGWIZwvfWp4IWyLM1A7xbYnhXEbqLtVECRyCW1wu6JLYpzxhv1u0VAtl0BcFHxKjAnQGxq+d5/Lp9H19vIehxVdyPpYwT1LeFpBqK+39mnYSfk91SYAb0BrPCpUc+xtGgBP8ANW7hOY5uzfu1XfUOhisrWjwnWqHSVkTEA0ie9maVmFBTDpfjcNamnVojmHasL30uNhj92hHb4kTyghLcqsaqq+wtLVbz6w4daWOkX4i9Kd4WnKAkqvKlfjwrik5tJrftIpLxDLwURxoVQN1yMbbO28h0OBl9I5yPFBjgptnceLJ+JOs2DPRyGI1/7MmytuPhobIYJ3fd6/9e7fHxjVWH5ysxhfjGXzYKDIrtB7FEXni1lB4btCkkveSxoL9t5F2iidkSw6k3NZhWfx6nXiFGQVaBwWJGMWKlrYYuE4N9ns5izARZgjAApMEQAgmQ0EhB7B4SYb/vYzrT20bWfR8LmfkAAoOfAxl3fmYH8s0O7r7SPFwUrYS2+AOE08zonIx2iDjFloEj6y4KFBhAfaHYt7q76pDWFKMQUBJWS2cY1pEvKFR80LYVOAGS9+dmYgn3EnWBzI2KlRfMd1IUuJJhYWK7fVW+QsHpoBEEKo+E7tujwoABbQKBLLE3VKOheYQF+Ic52vdje3NYcWg71UBw4WdlGOWasqgqLveaiy8QFlWTFVIb8fOFVGygZqsH6W6frSExGJLq/C0XvFhIM62MxHY9dokgjdMOyk7KcdCKUNSaEBtVeSZUkVGsEBOtFkjDpxDlHW8klsuBO5qxoUj6YFDF0f411HUID+WhtPVVU4Hg9w48FnZUJSoQm7PQ2q64d0fcrNk6GzGKemvh39HqohcPwsSg8ivAUIEenHWyanfE2rswFFKiYTGAAmGAPLt4fquHPk/23be/M52yl662KjR6x58TT83ZsB6rHZPDTjkPvrW8oCIwF2c3G4xcNFiX4DF5pGgQ2oth2KS80Q/xkwYBiJTl48qUZaopxYQNwzSvVJdbueFe58XEcrcIvfJb/OFqoQ712WEIcIKN/moIKdJHD+tP+5/xc49u1vF1+qyFzbljvnJjN3wfgVUP7x8lntZbns2UBXZl/CK/6N4CzhIiagTvoUtsIwHAR2yyzGeU4Ek7OwBK64o4gDaNhie020s3pYAuV6BXX8gIPXYxvGuZBNv2FSwqLDh7OP2PK7jwvx6L74KUA+zMSQ7P14xFbh2x5o1sYldRCq2TGlnGOtnEuqBxp7SNLIQiDuOyIeypa7xuuXRFDEKtkZv7tMTR1XbnSITbkkveVBl+oGJivODGsLBrmkyyGTVYkFYaJExtmc5zUwqoe2YjiTnkI0bvJguYpzzrdxGybNTSbn4svu7uJArihP+f8f/5zHMlXoBNDqJ9UbsyfwKJ1JgdsLnODdI7N4puP1eeUGNQpqQYubL1/sMoHKVuR8hCqMQTDbGScMwGyIjZBAY1LK8Rojdj4l0BaBk/wjx2pvSlpRs7gt7Pl7dmzA8Q9EMFZhtSXQKiCietYhNBthWUjImeagbU8g6WbqbjxVYgvLZe6I8eh2dKUn+eNgKPbXRRuVcptuyooAloynpVhUShtLS8OqyBbmeiyhS6H+a91j8CY1pRXMTnoRsIOAUlZNd3cLnt2WrQ+lwKmGoxhyFhfe2FipCLO4UN284Q1KZm0KNncJUPHUyqByqmfSlLMMUyHjc0CQOWfvBU02AVGUV0NwTRDL8HykwjXe/YlEcDSbYozeQ8oZreK8uWrUe/Ufay5Xtz2NFouqBCqNX3NR7x/4hr6zOGvMcxKTchKUmanAjEPeKYn+8G0gOvtjc/6g2Yo8erZpLKtsCHptYpiDhAD+dih6+EUYgz/AyCiXynr3XtyCpuwOiVa0SkwID0rwCfhsNdulajf5lHGaZuZhnvjLZZ+R6M0MzG6yMuzhayaIat44dTsv2U/NdXf3jCqGTXj37VhR6utU6uHeriRJzUnTbwaa28DUz3UwzBFpVgW+badcd0gXoYNH3Vu+7WRWuAm3waVU8+ndvXc3MnqOo1v5vGfN1dUKpO53Io0G0YddMGwPQQ0g9XzifcUn87Iq6tO+H1KGvawKosa4OW15CQnA93BzR3bCUe6lbRCuJZqdA0iR7uVtFIcZ/pvJ+u7oCyP4RpLSxVPT+DUBG9eyMqjilzrt4ggUQGVwlnH0Lvuz5egtyQU3dSLQDYAW/56xPdavKjrE4YeSV6fgZjGLWw9UJpZZ4ZLhVmdCl99F68nJ/sXvk9cSWP4wg/yAYC8eGkMn9eB6/5aiMxuYI047ezDv7V6v+/xQjGYoE4Hfio0QjBYnzji+PN14QYf4k20oQP4PbyAlP0e1Esdabl/FtRE/sDVE6O4FMhrrKsZmsE4p9+LGQKJRD75r2eenvDzUjV74Qx8VMJn4VwD2o+Pkenql2c8WC44sF3fBxPCaHctZkto0FLWUj5SyvI5H1rGFUNt9IeoZB+NjE7wqJ2wwqTR2kl5zysHxJdbltwN7rGafQPkXQ7uc5u6/ZfvnnvMZiEKz/3I/dljTP77bZbf/2W7Ew9bSy5fQmP3qw5QDKUpA8JOd9gp7D7sdvnszjF/Nxqd3ZHwRiW3x0gGvUhKZy2SjNtVdoz6LpLppEk0TZPItd92zPd37K71ZI/mWfMKde0251vanG+vWKZNif3fh6SyebX89ork7Nqb+7bpRRajAu3DMsHtL+nRfFu+/AbzMyn7xZr0Zkqzxqb7TRfIWCVPY8v9xZ10bV56T1GdI9Fd9qfT1QwwDNpfYMPjxghus02ztHEymlx+h0K0EQfoX2kdzqMQFmNYuyAoe0qECt7AvyuVAmOhHiffMKHysEb1QverSqMJI3MZfigN1luge0BAxhQ30JrAE2oCvpd3h7PEQ5RKq1iq1Ok62cZuE7nqpGdy9M2o8yxNvKGLz9gW221HfuBgMlqCnTu1/cmqpEghDM7O3OMtcUvX3quauVcgbTtdNlHMq1g65E0XufA3klZglcwmZBYmz3Y4quJEMjIZt+kTuu1e29krGcXjGHcbpNbbmMfn3FiDyM6PZSgPp8WOPccddebYniC6HwT6TA/LPn2ywnsXMEQk0c0P/4n7cbpvBYleIdRh3ZLhc+pUZ6WOVEoLUZnHNpzO4BnyzIV3xjxkXLNqv+9cw7hwPkD2OzOzhZiX0juMChSbyjtNJgDY90yIkH142PvJmMOTxKi3QrtKQCGCOOL0G5Bf+W1hTvx8x4cUjtKQwPMbi1547CjAZ1/sozFdhzI5hMXiA5ANGx4PIxyxLkTqSEAF0sTh40DBbYc8C8zFCxRWSBDWCBz3JbbZSophG4cmne1bx4GI3OaLn/28rvb6rORdhTVCiththhUJkGAbkkSrX+h0J3AMNhSfmuV0EPQhYr/F1tu543Szd702LtvmvUz2HIpW4gEt7+sCN0GtDx6JcjT+ngrudMyC6ZwguTOA3uucj1sNo4Mi5MUmbcR2qLuD6ffpkDeC7wcT+6vScE+3sSLJH8R1uxKsooT6zGNJnqTtAb74rbE6nDkeipgRGAhSH+1+iqB/k2/V9VJblrqzDhi6coh5mCukjUBs7OzZbCFZhC8a1GGcFHaM0gG1meb7NhUR743ZFK+lfgUwg9F1nRAMVc6hDHUOBQRvL1WsVHOfzP3/qWx96x4vSd/WM4AqkH1zCNVFZQbcoANN0frUKLDiFGV/leW9H8ADV5tYoclggU7GP2UOJO1FgvII2q6uFVwpv8RSr9jXshQVkbTmbZRi/O6lpt31vNBiMuB1WWSXaAYv2BbxWkkdOQ/pk/O2cicDgJ5EgjkHqbZqPambmjfJLktfr9ErUbMrbd8L6yFoht1aMgOhNwpL1+ewNodTyu9AWcrSsaVi7dt1Thp32aI1K82PmA11EOBT/9Vwk5OJK7paxqSbdhrARMivOBM6W0jFfqTv73qiVRi9HkeVarSXGdcsfFgB74LuPgqpSsCE2NTpdlS7fsPDkG+w2SZTu61jrfB6vdZ1Tmz/jXtf6r+Z85HORZ+5VJKCPioeYX/DfirgnpNaFYO0HTZhO02di2ypsToGDSnt0v+9aqkmY+9ETIqqadh7uG2U+y7Uzzt2vSU2QgShEgLBmyW/8norZwUavlpvDRPpIXbDFMxx5r/ZV89cLM1XGfmmFoP27M5WkrGleU5qrHGaX0BTnDai1h60oOPyT6vTj0yfcA21B3slXwRAL+tNJMADT/Mo79fRDwM6SnSK8RmPttfunAXRn9zbCUZbON+4rgkOOXB/6UKRQv2ql7UyExioi05ZX2Q5xzHjhlnGC6ijbxF0GHvgpGNBD/3Sk2rO5aKdUNlwt8BUEVuFSVNLGmL6Th2zG1o7KF0w7gV6orPwHtNqvcJK22YvB9uOfFaqG02KbKnwOVs2pHqJndOlS1D7M6GGm/es5qBRm2XoVTnjR2NCRr/+gm22d2HcrIR3Mey2jAFZFUHTAbevGeFAstJObsJOmrtPTkXn20CNG6qqGu1aaqSlUs+j57YVbxEbg4Q41LgZjzvatrLMJMCjj6xUQVTtEAFopNxnGyKDqBKhhMZnbfbpl4pcqidRjUPNaJUQ4kDVcAgmv+5+idc159Yj4PDr7hS1gTAO2rJN7DS4y/rvFLjUxp2xDdzj0yAcNhhl2WtOnek7kyaU9O2ABS7p1Ye43CaE/dvNu5UXqToetrNazpyQjzh9YNOSUQUm+Yido7d+9RKlDu9aC23IwPEx57LpXDs12q6DAhX+8gm0DXYQ+rw/2caBgWbo+has2/9OyMWsrgFprFSSLPET6qrkc9LhQDtWqoJs3gs11UC9AuWC+6FJBE3zqUr4phKG0b85+2CqYGrJKXN18IsvyTgdr+IiqBDKMPAEBWvGKcxJaOSAQWJrUpvASkf0NKto71FFAm3nK6KPO4DRPu4QSb16o4zGo793zOKLnqZLZkFsjdEKymWUTQJA6M40lQ1UKzklZ3WkmLh5F6XuqD4P5MgPNJkRR0ZFlqBcmbQg2X1MqWSWzB6i2uxIsHmgXVbHNTNaibaqzLFeKSy+jaPx/xZwlyuEGaHV/FfpB9KKzfVLDWGDmf0nGB743EIhBgGK4zgLuYdBdrDkvUoY/+PtueAzy8sGGubtZq23nTYcrrcII4qoJuH/kAr5L423xXPJC5eY9c8oBmIjxc96F9NdepLCjBccsRfD0f7k9eR/anMoaJs4liR2tu7vlbO1caCBdotNYbIty7z/LhyTdNbPXeL1ojY4LPfL/G0vlYaapepQu5Hrc1MtyfuKxzGFBoPWGAnDEFhRLgEoBI96PF8SVJD1zFbuKVmiGnwELJ62YPNqtqfapdZrKbxTTT1XD+B2RC/jHR1mGXNoQzUPOZAcaupVi0Fh1DaVkzO31FyZaZMI364qeM8k76NWUYW2AxwKMItN6hnpy969ynq0n7MJPyuXA83hHP3822QdXgFM4B6Xfja6eD6iNfaQvKXrRcOOaBrrGQ2VZBxb+295U5P02QY3srxPW6Zh5CyKakM6ydyvZs4s6uiOMgWRJZxGYBvEP3tsTURY4KsfScAuZmN2JOzm8e9ZtiYlzIi0l8eDNnHgjN5H2beS9xZbYc4vdYbPP45JiBPZaLEYd+VLSgeK9GhYoYGby9eHN7XBmKc55ubXahk92RS+A+PypskMffUl4tUu16yscS7EhDOTsBvG38nNDqZj6VNZKvcSBEH3UNlnbv4BzwbCKJ8u+zA+FyoQAtSxH4dq56meMX++ONhTRDwCDMTTKm1e3KeP7GGd7mw2bKv+fmFaHeKi1PdtmpoVjXHPw7H0y/P/tSDg76DidGgzBstkh8vN18+SzaguTIJu+TjjsqdMrNyUM1ZEmjrsN/BZ7A1hW3YviQUrqwqdkjMnenEuxHNUjisxkk8Rcix2Bbtky2eCkrpiJPMwp/ezp9uIn8fn66jch+lGpoWkO4rjo1sN9LtFkBYi/zsIjs2tw9umF5+xInXHfuDmwHT4PMLTZczJcojjdi6iOrOxLgiDPNBXWpy8YXVDOkbyU1lBphsunKSVFSqlqDffk7fMJ1PTs5X5+9yqq8PGjPMRJ6yYUFLNJiyJ4C92J5rU3BOqocro4ixYlRXU+O4y/DOS1kmNDPfqMi871yxD2mm4YLdi8wti/GBeL2ldCWUWhf2VsF0uiEl/zzo8JxPbMVTjXsIo+3zDakPjqF9rIB5wK82VRV4e2r7iuFXMsZDpkIpIFtIL/ZqucWRgveOG1IjOPldyy8pKzSf0tdWSf/zSuFDBBRxM5hYx12v71TcQJbTUXyEJXhcedGpA6uKRpzKwagqLGHrg4VCNQdU4L8Tig95pX2xqcXUaJQGEpuCMtgw6O9Uc5LXgr2OD76oNutpwJNOUsLCgf5loi+maEULRItxkDXb/eZz3pa0fy3G7dotS7/aj5Az7xhL748xsbH6aDoUhDwCeeYmh/RXlXAAqo4QuhtiFPtys7CgFYytzxUYrXWgiZ/TdZLpTIAlwr0zH8FGwhiim9Rs3a7FhoN5iFU+J1j6tUJUyDta6bqWytWpfwhFCouwQlm3GKx9FBvalinXx40zF5iU5xHbeMJOajUF5qDOMQ6LIJ2PjnXNjNKwEJceKEaKBdrYtXlzorWzA79pwgQe30pToImcvmsfAEQZYG8+OOWpEuEJlLbxP57z842FSWan7HDelfkJxHR7QsktjYg7h4gHx/kUW5qyyQdwoMbq6LkUj1MgpL/ZyNMtp0VheRM1ZVBaAmvwHkDVNa49fucrfd+I05F7hrXwbaTQ0Cw4t/ROEbZ0/9iVH4BgXCjiX9M3xfffPLFICQfNuUWgdd8x8Gvy+bECOA4e4z/j7yNPXJ6dgyIZC8zK+TZYQkbF0U5bi/Ahclzyv4VM6/g+kBZnDpmRgcbGik3JOJloTKFfKGpI6o57ARJHs7DKMq+4810Jxrd8PlMFS3Nt4zDFSChQ8/8UYvMDOSb5hhxAxecLXuAmMSjZZkcFcH+JiYQuY2QO4JFgT6+r0gyQuRWkMDre3YUA2q2O29TDML+1q1hfKmaktHafJI0iUwQrPs7OoxiS1CNoEOlAXspW5qGIFkHyUJBc9ISxn4WyiB0zKma4VqFymXcyye49gDewYEeCo/QJ+wlfVVTCkAZkj/j8syZFH+UVzlvNOiY3TOiqZQ0AEm0XPNU/blgmVgAjJFslyloU3shsArOAPayGONLPlcCqc8deV++Zvi2a4YNFR2XRSMnQb8P/aGquxeMqoHE/J1H4FWgTshBuXM3M1ugdkuS8J6LOZrMAdVWd/S5wtzwfWtpf9gRYp65dh3OGToYj7yIMwWSp6OPd9yCpaqFvoE6FXSsfc4evphrrOPx6OOSuXRauPGbYGCS223L6e8kfoKlWGFkJ0aT/SPeJDbt5AROrnAAhc9QQMkhvKDXVbHvTXYXDnG46CD2/3wjmVErgEiar/ubQi6bXF3EyTQq/pTl3jtkZqe2qSJkUeeeG8dDLLoRmsKogz9KOpWUa5aKvVR1SkyrC0MB8WexuAXPh9Ioo/C2MpWAsno3mSeuF6MuywXArf67IUtpz6rMqVqzlI09icmrtjn+7LeDVRwwVzWPIsPOKGaWg0ZgFEtVB31YDhPeB+JS+fvt7hpC2hHdD9E9NE1yNUOaxfEYg4kOGeFwtpDdRZaOj0KopFotZUP+r/aND4j8DbhZIHqsfYMABGa1p60ExPyWssi7Vmub06NlBkYl8mi9faOJ+w5Mc+lvKBt7h+MzQUW/jPSyZNEe9eJhMqmat2I7jsjBhzmUrgJ5mI/S3i2ObXCI72broNo0gPlybPasgzRbK++m4rn3Lt69aEZxdA7zrpqHyVnIzwlX9mTAwiIuFtIdDYY2IbfhQj/58Vr7IRHaPTYgvvHePT1zMPZ4nIOQ8WbIX7q7hKlIBmiQZ8pZwKUmw37dLXDoX9pf5wIVyG9cbfokV+vvkkUrFlv7boqJd4/QVwmL8ciMyvzirUyC7a/IQ0rHFz+bnQb4DxlFRCupyziKxrqC9WJG5UvhaeKMjF9EuI5EsS7bAYw05spp72aSFEwVPAQ/pzRHwAoetLi17bj/eV0fiecQyDO7RxQZUMHmY32OxdCBCvW7hkMUD+GEVy3DhXJREW55zUCzC1m3chk93IQ/eD472qFMIeDiBvQ8/fili+HdE2vwqFqBKOlG+LoZBYLLQeNJnFinD4w1JZFoWwp7vO8b9Tb3rT+nUTO9QgIsERC848Mihz8MtUfj6V3frta9g2LNNIhAgfN/x+m+OReYCBR8G99niPKjlVcvxQ3R6RNj+5S4T1wM744fED9pUO+2M+yo/G4R8NYcEEc6gJ/8CkMAXhQE7/X89rlNzwpj9i+l3m0kJn4QrCsx2D6YzQPoNuKWxGG5Evc/ccKx9BKscCH8P9xmOsjdItglk4iFWhiNZYXZghZy5JailkLlZ+CkHWAtiuXXbE/wUW2FEnMgdxoLJL5wjOh9ufGYC3iEx8u0mQbmxBwj8lxQEQuYjafVpKgFjTFnDjl4CJQjI8JnKGI7EKMUgHe+f4nJn7K8xin1RDqCimdWU8sIjUeXE6DpbE5ClA5ic9Lv3i07MgWV5XjAX48qutIft7dHFHFsZUbL+dLSArItdGTVjZm9OIRai8W55wANUyIH/aZsMKG0KXjnvsXPrUCq1xzuAjj6T3KZ1B7P1Hwh/LSBxon/qND/dVSH420jdfJ//EMrhlD0znbryhYmwhc7sM8Voim71pHu4QT8IGRj5iC1PKwOzWPQ9z+Vzl5LXD+G3Eb8MZ7Y9gbETBHl7gIAntGN9+ZqgWnNHQ7G3iA3lb4E7qQkX9SrMy9HotbSX2aprdtFEXNCnwy9zdPjGGQ7HCSPnw8vCphcqSVKP7qHaLYmNlropFpYaZ3Vigi6lX21cUUWzVdeVJbqDTRCrQx6bFockrAfcNk8ma1hH/5NESmBJKU4moVrM6WnB5zZJDGGRLJc8sGcMGUgeBKUt2TR28lYzDk8eACLFknYF5VFpt+e2caJW27wlgMAmQOeB5KFSCk7kzVjs+ftqXEWNxU1pmn7bV/3NfMZuEBg+y60JG4R34miNV5O6D3WaKlcvpHLbDqoa3uxu5SqW/dn614IE7mtBSX1xop5HPYJstqJkWZnCIcA/F6oDCOrOxqqtKlcJiYummtLmqCjBLmwbOK5UN7DqVCuw7lRf/8FADtcpzfK3s4+2HHdRW2cP+zWW+rx7SJMyPp1111n3VJOOOgQcABSypSKk/w3SrdF3WDoWHJ3jxVFWN+1CYb7hGs1hQCAyTlXtdDzRcOgJOzsYnLEqHYCC+ZB+kAwCGzWq21zLbUhrTi58TNzCNlgGBDTgWy1jRvn4jjhGsHtUzxLDOb6gs09yw7xBoz+TEqkv4+4Eig/V8Tovwco5GlOJgFmq5JRdlYfLlUtTchAyy5jeiwbxVm1igIuXcM8dPAbUJb2RmeCxWXL/0b6saMxba6wSfriTghZLg0qBTKQFeF4Vng8IVlJ/PF+3WnvXLDXjxNmfHkTb0AEvOxL1DXtvvqVcH0mLYAPuLNfW2XMscznRP9fPhKXWvE5QA4vmZcPPf0l6AFoXsHpggogM0ic3ppabNEIgkX1WxL9lDWcUSj+wUc/XdXw1LZgW93r28THK02isI9u/vtVIzl1mG58bWV28KhzWwpkuK6VozTSTBEnDJdj1xYxsUmNd/BdM2Z9j4gIHPN3V8crBB1dDuSbZeWFXcCstdBpZB6kONF+K2r/CjkfedqmG9pfFc9NI6gJM2H6sN/EAqJmz8ULw3k2eTuuaBeTbDax4T0iqj9K7uhntOhn8JHgPqDJhUfEhqJ4gOYf+zuLaY48Bb136dgjmAzV5RrWhnW6WFjBkSRqiI6A6zyLPtjf3GFvtmxJYBSGxDsauLufIPP3BItlmzugvaf+dhTKqEiY/QFalaXDoxpFrKuWAeFWcFFaQ/0FzHPlRyDWTRg09Fms2MIPOZ5V3bZC+FS7WiwYeEfbzCt9qOq7q4oXswgOEdXGKUNQqWRT/We8++9aSdgCdX+LHgZhp4sLQETvCnfyPS0cUZXQdQYa+ev72vc5R7m8ig7vJwAFBgxQds3Vsc2dN9Ho7STVA/aSIxrz1SAqWRf4tx2oCD03fC/I6Joej0Gi3f+T93e/g2lyHanHoQe8uKvJVU0595YS3eKJlVT3VZVzkycfGncp66CZYqKBSV+UzbZPbF7YQKeYvo+eZUJwV57sbCPDNZToq5EipTkJtzm9deu9cyoroCjXjZtsweDksI1CM8du7u7mLtt0oPFL9y6/pxhJfSrssMWJr+BNEhRKMM0uX5HVZjEiWu/PhRg4JTGkxt1+Sx0teEFwFy/deujHLKuBYAxNzkZeiQ/Id4Ruvqps7+7IBJ6s8E27Ux/7NY1149UYVATrN2SesnxC2wQZQrpJsuz+fJevMiI3BEZ3ANA4Orgcpo54ZxjaXi1WRt1BZSIMgylfjoU3faRUvgywLw83O9lGz15XdDvV8yBJQlY0Wa+M2o1BEF6nq8hr3QKyJVBcR1GvCG+x2Lan1OCn7JcRr0rtn2iQg1y9X58h1kqjI4p58P2pZu0yxymEcqhigS8LSl8TfcNHUFg/zPp34mIqGHq6LJ8eccippoOVuRYKirNJSVV4kWWqZA80Li7VF45IiN6vMhFos0LWSgTtYBXkkSxbeQ950Fx8RNZojvLkaccwmrc2hdU4a/XyE0CFEb0bSvg0tOSrl5g3Oa3xYHatq/QIhIoP1Qgu3glscWkjfoKqLkFDmZJzXqnWm9e5BKUAZA/g2mYhT1uG0jZnDvu6J4LqGGnWDiunjc1lj1Pfj+ThpdZOGRFhkyH0LRhyEB/iQ4TE8LRCrBOBr7PaAzTsbK7IZZkc6pMv1pEb7xoJflAz9Kzm+XPM7jQKzqta8Yy8LQMgilJFQl1kQuylXFHyokxGV9eo4f0ALC7GxZ9kcmeBPR7MACxc0pZrZgTjFWH7IVk0sNCNJpyMBSaj4KnXaXJFVfimn5X3LRpRZ1uIPDzVJaTq7gzubDvLrh/QIkk/CCUojeqywyKGWSnoiaNwpKrrTnKvfnv+DuaHkC4yLj8tcrby2PYVoKR3uAorEt4harol32m8kYanVYxX9rU4sJ8ONzlNzOtdriz1sqMmE4+N52jgfBS3RRGhI3EHF5tepSv597dZGEb0V4De1n2l/xJdu+PDki6FtX0faS86aR3q1gO+/fb1UWaUxbgthSkP+NoTsVNtydVFFd2Bx+Rv0VSxxV5XGJfT/VSP92h7IKbjUN8uqpg6gjQATR4PrqF2zvci96obbJYYWt8PhKkaeTEviF9qCJ4D2LceeF+NCO7i4Mf4ZKlKatFASbQpwc0t1w7gVMOo+EjFVwgpz0iDA+O1yXAprcAT44YbZcPjaah8GY4gz4rysLLtGj90Ph3w0FEN5MB+CaKDYRUaKOoRk4etFLEr1JQWDbf2+xqJnqoyrCR6JzK4EABW4exQQpIGrVw7SMuBuB+fKSdynEs4QY+0hYGVFkWi8o3RkwIMBVCcujIRt5AzPg2z8wD4QuOEZxTEqArb1At35A0kjkDPPScL2pFLptnbacvHYzU3STFczdJp+I+L1Vh17RAAH/mXlPCilee7fwjTAYDccsYWdYDg1ZqrNBS5rwutDWxhpf5MFFaoC10VfK4SlLa0dgG35lgd/lAdBeQgyDyz5oesYCCZee2dgorkZ+F+8OoHOMIhUYhzDyEk54j81mLsMM34tdmd+3Y8esqjmwGABMj3Jg2rEE4tbXsvKkvZ0R36j4G5eTMTolgcmq/qiNfOqqZSRra1qDA2cQddbsJVNWOns9GqFZOS8j7V7dAp4yCHrgrrjSFHLcg7UBQNCPzNfkOjPmyinBNkNTayjAvrirPCzkcxjzt8k4MkhkGC0rBfUCgTTtOxlInId8K8n2D6kOh1Tn7pCGMVEETb0XMif9tforvYVfATeaZ40PDZZm9lQLfHoUCLCWoBPrtDWTMo/CKWsij/4DXDlBg96COR+fF4JcofLpQFvaGT/mEA9dpi8mnab6/zggPYTos32/6q391SLlZOlb8ezMYht++VD+2NaqytLup5SgCS1wgRNNzxn++/lKp/5cTDCmkYAvtDEGxyM5oh3quNgVchy6GAYVU3ho1dibxTsAUNlL+iNZizC2BeGuxxMmPH+h6CoTYQwc3jkWa2a1SLPiYYS1fqv9XAICnIiN8kn5JdU5lsNZOmSH5VmSEJBd/rEgrHFg4svTWBm4jfgQel/VHsjIuHFhMsRC6wWiJD0rzvVVeWGiLaFCYs1YtEOEviKgwyKpZmZl3IUvmEtFSYzrQyhwR9iTFjaGaxHBQZJnvW1+RLVxm9C1T/jkqo+gWfvFPhxecH1VCyWus4lBm1ZDb/YOBtwSDQaQ07GMthbOGUE4oJFqWc0TKkFia1VJcLUjYnv4xzIp0hYQv3dkixgD2s9PODaASiILBSkTmY2SmG0yg6SOWuAEFiazVXsS+RckH04lktmqkgG8fEPyUIl0IA4jJZ9RRpaJho2SDNskw1JGakoBGxNhgx9XgO94B096JE++ZNKnUUk0XCxNBNxwMBvXq6cfQq1ryC1KRi7B7KEz22hnKEPNGglwLnj9u1FAZrM2p/qUsLalgVNjEiTvz6+vhxg1/BqJ2EUwW6MF6T0wJQcZat6Ldp7jBwMtdohdk6SDELOJY7FYdmOtJbGvRue8iHf0q+JwKXAIrQBiGhd/zyg9QNCVnF8nSr0Q7wuEJMa9IF0NK10Ktl3piuqLXvCzvlDdHHvFn9FVZrRQyCNRDB6c9QxLkKB4VvVwoc28864Fan4XapAjqnLtYXa/X8vokp22hOFfqdpOlOetC1fMQZQW0UYTUGXaxVJLO7RENMuXh9NMsL+Zq849Dj9OUKRXTyl1Dgblgd+2GfOaWxPePNHkXZAHr2huG4o549sTYJMwQBGB59Imao939cyYHQpv/FsLF4M1nxhGCxRMvSOgdkS51COKRrPv8dIAyKC+LE+BglFn6+iXjIZkY9U1w/CKcOPEAwy/SNRD+ZpS0pNk/UgxqDwaCfWBL1N6lINLMOjUZbLR4+U1rkz3VMuzNJNKbHCKWob5ltzwyJCpr6RZM2QBVNNPvNThy7Uha9IS+d0M387600SccBQihH/Z/l+0gOA+SxrABXVxaHNgZzEoJYWKJ87fZRDa2WAtRNhHstERI2+rQlFGweg/3vXmwNcDn08jFcP28meT+yyzqEizzyCftrj+rBJpkUhJl7YPKCx4ChUYcMXZ69NqkIxlxsgtAnCCSrD5IXDmxr+u52aIJTMHXw+ob7/JL6qS9/oGh+X0wOvPX5fmtRvVnLv+6yJpL4fCX3mmlaA6BfZCjmfLKOvjiZ/AhKrvwQP1TU6GqvZBD8u0d+jaG33pP6lbIL9+yS90+vWBbweAvDVwOuIaNq5jNIQI4A80hBLD6EMaW0h21mz9GwX4BZKnw8ixMeU48p5MujHBvknvlx+ZIREGJzlY+xeNvBe15OE44H6jzIqXFnkhHiQ479q4+Dqj9orz7TDAyJDBuhPh+cIncUXy9VI7EY5XV9z5Jpoik8tr2nKJKtTmqQWksdMAJr76l8M5CJzAggPoQtgT/0Pxl4PdlpA2CKPeIQcjXInZOYqmo8t85JiC6YXXGPcqBJyh4CmyEIf/DRRcUF3McH33wxbJV0+ew1p/DwU5uWAYphCEEwWN5BCnZMdq7E5enPRcGelwSwMTTaMfw6oWXivfaIMuSA0zNzAp00guRCT6tWNWSdACxdA67mZiurv4HCdzTHuks96wEaWGbkN/MScnFUnPmV4HsMURxOSZ0o8DmhH0U5384FacwixlVBghUy6sHJUmkVMYrnQVTj72hiV3USRxW/5AKrKy/8nf/P/kR/Y/VRF1ZDQajI/VKYMTwEIfH60ld9tHHnzame2skQ5bOKH4VVBNHFMcUVwoqHt/scAg9esum82IXPp0cQ/qeycm9LdtfZOcfB7PrMX5CIyD++u6T7p1dcKypGhOX6ASXUBFl9lvUL9lzvTKYic57WKvACO7FAMMdiC193flRignYKTsBW1kwY+BvP4ox5PUWgOLhVDTvt7Fn/2icaO5DHKekEFtE1JXtX9geFFJbD0+nBuTeLJTMJvb4p2kugmJU26rdLrBXPHOIiKPSDzYUAvO8r3W0o5bEXj3jQ3W9M66Y+AEB9yyW5Fmj8zw0UaQ+zks0u4Q2ZVDfMmai2TGJn1at4E0dVSkOyrijTlJxTZ0g7tjThapaoQx1YILDZHM13y0UMcJcjMVa/y/s95xmIgK578sYu9a1B7Qlz+G7n9o9A5sSOm7Ff54z1Zn0/6uBAnkuxHEfFfDH//ZatHGPBpkUHJ0xuQPIif1fIT3wvJ9twc3cbtne7jJ5v8HWl75Ybgfs4wBjqOEgCrTDahjlhmzSinnCqoE+JRIot5yKPGE0fnty1PUi6qw/lAIsPIQx/9OIVWrYFN4vqGP68+0Ctl+rf/a0bP4dV6qocMaTJvTbCCw0a158UxENiTpggDBMXxBXDORPmFn8bNxPF341wmgGk1bwR8/mUQ18BTkCDSCN0p8tBPmSyN3C1z5Qc0pbGplpkWy64OtriIRt937l5Xc/eBnwt2hAc+CNiFHOj0JWQYzbyuxIa9NRO1rnPUxLF3BCIWCFmD2vN+3t7jhA8vdSZtc1eHeWcVpWC6DCvAzDjHMeDiWoyYL8OR5C0eDRU7TaKyzisW/1syqRHlMSo1W8asq1xsoYY6F9yjjnwGvYqXEH4VEJ9mWw6LaLI86KbMtfLAp16hj1O/OAbTK4rcyUCiLQfo7NFcnAwiOYMs4rCiS7kcg/gZZDp4c1p8V7auHlg9jFOthNHdoPiY7WXle38S5H9Psjhqid5MwhLqsSqyZC/yVfQQ1Qk/IrQyXQrAoCuv8X0Ye9agSyfU/bHix8XR1P/H/vfERgWMuyw5WJhT1FPZbjig6K47NfzPerbSCmuT5JjBCKA1o7HWPDJbf+yZnp2+JqmsIWkDdnzVbtToQYYzh0fPBwY1PocB3O5H94VtFHVbNnrkjq/JUxJxd84YwnFdtdtjuY8Ys8lUbFABn6hfu2eF///USnrc1MnWpu025s9gRdeReirFnBraqmP2fPC6dpjEgxsn3sgNVnYFwc11ThmbCN3dpLjDM4xGK1qaY0qJRgB/OYBWZghjNPkGTkXyz5yrYmxVhMJ+oUQjI+7MivXxdeHlCQXCZxmuHthkrJOC+xUmQ+PD8hIIEY/9wsHHzlKFlQj9scHTE529Y1t6m7L4pCQpL61Qka2mZYfev8s1oyb9aF7RPL9GJnrPiP7SBohUmhWyEfV4MWaewQLSsXT2VeNgz3FWZkDdMWklEfsNwIIuuY2uAYGslbmQuq/ER7UV6L0XgeA97kW0JoGZfbOo2lO8vZI9FOgXx3WnlU7Pm28q3DKs95PD3lkhJ7juAHqR796tz7RO0ZA2jXZAT0B/SxqvfCLmvUg/Xgn8Wkp2srO0WtKC8l8PqtJWN24eFFb2K61mTqBrD0lVlCoR1UKpZOExAmUEcMt/B0nTXqJHbhJOiDgUMw2xRuGH2On8y2L01zwAlnGLvjy6H4Nxe9Fd6AJwki0I4W/udEAr2DtR7jgtEUYFaix0S0epos0xnsKR2tdh1LNSH20lu+ytleEUHtVjGSJuaoFaFlzKUBXNQlVuK1KcYSpTKceOYqcAIyOGvmVfxP28ykni6cElfizFWiR+9j/Bd2DNtKcyf8wXIwwMqx/1X4du2S5zrp7Lim75IW30QkQL2zAvMnxb8p2px4O4jEhoHKAHQdxneGq4XrNNowzbhp8GSdFZKIp9BHzU/8YWFjCLoIpL7MjgXv9hApxQb7BqNBSpWlyzFe7cQJSe1XQQq1pBRbJBcXkTJPpnLNc+imlCwyWiWLQXveRAo05pWuidTufAi9h7DBFPzAwy7FIKcZLyWxVFXlG1QUS8z1OpuBSD0dMaYcEelFEKxPb6SdKPMpEeRMaMAZbR/s8YFvM5ZYEKZGiPHsumdwbm09kfIj6JR3fXVCeAIQ7nVTTd6FWbT2m9JSjUba9WRENsoUQgDkGmQBH7mwAPvDy975cUAspxciAthdXKcRuFYCwtULtVaQrLO8lBXqid9y5EmQZKRpuwrQZpSR0j0OOLJcs7gM7Fy2baW2IFrfGJj1mbl7PVNiADqxoQoEBEaplfpCNyG6LUnFlivn3KsobB0cq2n0qsANNSlZKY92Nj+PgQlPqtZ9s0nOlzaVAtxUqa07ZbsUS561C5jmlXTloOsLEr4dq/sVzJa9U4771NnUEXImGrzguwJMsG6MMTMLXVZFdRmSGUqXtAersq3tGSWvmy+fANKJCWKXXJZb+V06lnOAiKvk9GymcCVP8ooHiij9jlXxnyB2/rJKEKPWigyE6EgOoe+C+4ACT4sym8djZkfrGGverh2rQ6H0KDzG34ZHjpGw0ZX6H7AWnRumWPI2nxESK5aKQMXfkj7TN8HMdLA8G2ePV2cNnCm9/NmBuU715XPC7ZzqiwZ9y72xKuYWd2R8Z2cK/ILrEfYj+xDrtWmzSMmAmVW89kDh4rzCNAiSkjXyaA3K2ZCIH+4PmB/BMSS1u24BYBordYXFQtGCIpVTGsVCiC8lXh5ESRI7vQwdXxcsQAvGAjEDPikGXlsWDEJ3EQEXAxt2HVDGVx7iDGqRZCeynvJbHbRLQmSAr5c7yTMZ8qLuvudArBFv3DePZDYHIb7HpRR3CKQOenbzT0VhuTiOWcfzMqOzLBYUzTevWJh6+uxz7y/vb/Z4ZUGh6mw36xk3wmwf+7ud3E0Vu1xq1KKo4SxrUhagl5BfruRA7dEeOZno7t7vkYjPJ+mpfG9PeS+uRwsu4k/CIZeSPcklXy5IC+8K5qK7UE3/18/pePfV3/9O/e/rW/s8p72H/g4LYUekfRzyMkVnPeNU+/+Zmyrx6CVG/Kq+3RzmWXLqcYYshs53eSQRLfIu3HxM3UR2KsEfk+asmsqMvOL3cWfaOONh2O/Azd0F0lJ3bl/2GcWc3nUoHcHNtDH3zgeEVGcVI+NKjQOnbHw3vQvBgt5dyOfGP8M+jD2N0a1GyUEMGRhlUBDSqDkKaE91vFqgNRlI60CSUy/pvvyHKpYHSe8YxA9MWp7l5V6IpEne0xeDoc5BDHRyDYSKcC8hC+Mt0QaHoxnf4OpuC6mc8X4pFswPL8g7G68H5tHag1VgzYxarWs/wiF+9HPtP+4eKj2MdBBXs2EEobElHnEvp6y4BxooWgqliNnkmWKwSCi/+Q45UExmfczYd0Am8VZ/Lj9Lmy/qQWrjrT+UfhfOorusYMf8DLOX1knNADwH33bZyGdEbNzWOjDM3Na2Zk1cEYQkWFnCutfVVcSjTXrhyCNNDXiOOwlZi+z0lMGvAbH3NgH0eHrdRtodlO0NDSE+cyf10P9IxF+3CnvueUbA6fOar+yI313iJg8CxcC00Y6dwuRkwUIZo4InRCJ06Co6IzBxNDDgVyDOOljhw2gvg7W6nE1PqZQfi1K8tHME1506Igt2rrCgQ9jyU2FR4VtezyxqUwPHB8uNGXsllUtHX57c6hLkSeMF3UGQVpO+G0rXwvq/Za9J/9X2Nd4Gt9kZ5nFF9XYK7lxgq4sssGYK/ihcUbqL8fEmwQ8g/HMlkjLiCaAZsagKn4TAbf136hCp2XJSqXz6ZC1hFEjtsB5b2/QEJfugE6xbltN9pKLqO5Z9EZnGVRRAESDVDpnE+5jxfcxyrfRAiqf7dldEVuo13vPV/GmlmMcxK1tIKaL1/jStNbYI3Gs2XZtzUDVuNBqzqUkIF8SXCyjaX6bAizOOX6B+ZS0KINEN0NLYvmdRXFlPLN0Cbz87u7FV9fi0VZ59bfwFGTWHF5mpHiG7pIZBwLzR8HRTiEKM0K+/uPKbXYJXOLCb1Mi8U2ZSZJ5a3ueAB5J/lL/+xwGO0Zwp+SL96MdQGzuVvxH5tv2hgDTqDlNTlNzUIqVti7oB3wDXrCn3CYxRBZzq7Ntk50mwc7gkpo+D8yBWNaPJH9f50OSXWUvezNO/kW+9sVO0HAjU538ehu7qMrFLL0AAxkaUBqzw5klCEtvZZYD9eweHM6TxXQ7+GPJty1tlrU0eoN3vEpAbLZbq6eSCSsbal5ViMHSqxWno2KLp7FNQ7UKA8UThulFzGcJL3fxxa6VvO3eAxirj60Gfe+Bjd92zOR2QH1jwZsL9K9EzIUeQm2gLjMbAcD8SXTrXHWzQYto+X3z09mllXdt2bEA/w8/jQk6hcj8qSNZYS770Tx2QpDrs9NR5xZ9txeVqRSJjPwi6Ks489K6e6nmqptPQrYw9MSwYYScNQDNyZUlNkpf7j8MQh+asVzTuDeE2GS627Xq9/NtCyFCPxdkAD6ThNM7PTcoMWffQUPT4yeIyMiQuDMED8qxJdpjRmh9gupfrnNnY6lQm212hKv4vKuNJQ/GYCnrCaunialYbf2LKHN20XuwLneFX8aYJwfK75hTyD/0FEls5HPg50dJz7tPzP5Hz7dt7fy7zS/s/2HT5lnL4ZPySYsimbK9Ot2PR/DYC9gzRxm2CoFLt0re/TS7sgLdZcZF2zh2qYXm3DmLyLjfw2omZKPKXUDE+J2T3a5fUGEGWFc7S/god85gTuVW1dxh6ehdMm7bd8oJkyncixOr87ZcBJaUSfc8HKd9wsgSbGulrZQCmKRhDfw6UbmgCYPM58MJ0H1L0n/+VkHoJ0PN9ON57ec5mpLgk3JyNmchmDfeaxVb1fYUzDoYJ55KSZLfKXRZ3gWZZw+oJ7IpofUV0CxYCUyrNwKk+NCa8SjD0qYo6C+2Ok2fkqZjMTExoJ+MvTM4dDLwl5ELgjMX+s2+dTuwLt1wT31V2royxuo8zXX9HbL5XO6YxtWhzneOnmRd0xDoJZAUc8nSYeuBi28XxB025qkElnVYwh4O7zUKtGNR4JV9UH8DqTVbEU7BSn6GjD2Wo2HzGvZXWEj8jsdv8zOAYAeQehXyRXDY9u/J9n/BwlLknAMjLeesZzniVpRoWY+QXM3NBsc3KlU2+AFOJWbqbU65XAHbI3ZF+nBVVDWG0OimNFv2K47oAu1a7E5qKquU/A9cZ83YPvuEgqcmAKtrZB1TgeFTCI5bRxUNktCf2uypRHdCkU8vy+a/xzbFwdwX94QApk1GIg1iAh/tLCrZgFhIEUrScvpZCqeKhlkZ7aghlIiAysU6uZifdZXLOi92/RgVZhZmV22Zjp9FyiFz12RKFePXxYco4WAVaJGtWP/B+Xbo5C6uGK7Bq3VqSEs95CVU8MMnXR1RGrcTftBbEoyxmjaVkM9whGZhGSxx2WCs9fRl+qqGmvdd6QVOAkdIA9prYANYXwEzV4SmdoGwxtoxLtsK/LnRHfGZByV0phtLfCAxDyDYjGWFxdB2B8Xai3UpX+aAELGx184eIt7ACuAu8SndVLELqqkDNr/s2PGRnqGUTLf2tvexkY8oYsM2uOu2dLWX5RhSSfVVNTk3yDmZMroZctN9A/Y/RYHg741SRiINI/phep2ScLD91AaScjpycHcn1zM00op02YtTnrMwWxsQg8wGcLQocMfFe5EQeQF8jlZv8pYFOjztSqbsyEIDVTaFrsMlXtolf5A77mab1g3q6tchrHBI15zf47cS/H63xLzDNtyG5eVWMGXmxxHIU0NpuUGLmdlSfqagjDXrovUlzD+H1DfUnK8/Ixj6WzQluNUy/plKS5RQY6BndBKhZ2HVLD/wq8DUUzQGCsxi3GG/3cxqbcpDsngjJV2OOnIQQ+nica+5MPAzS2lLC0IObkpFIaLYvPNhzdQEgj+knMDqD9CVwON9pTbGYvVJ9WcQmwNdyFaUekl5lrI/MV51h5bzDItFGvcOhbbsGTTd0Q5IV1Lugg9WCsIemR4ZIhK587ftQ+8IIH/dVR22bU3YJGK+QWAGxtp/0FMPBVnVXjYVAs/owEXb0mNRg6qhGaDFsCgg0TKaDssbC5vv7io2srWeJIO3rDa7otSWxlt2w13ZwJbHm7P5rqi25aahda4oVZoWi3addHK330Sab1YrTKdBRRJvNnICUcXC9wc0gbQ3yPEO4nV7xOxFv+ulay0WTQQp79kbm8LFKsAvg05JBXLvW1B2pUqUPCkAH70F4ba3EMAAYsdvbeBpBV7vRQbrz68x05L9IN+2sscSUhZaoRHpLhTqxjbw4sW9XSoHrsuI7FZgZBzlQ+Nu9TF9uscUsSXHk8RTEbtHhTXAD8V12BxNaoFQ9qZZGekUQwJGb0AE2cavAQQQnmkZO8GRvdO9d3zaXUjbTk4hnsxHInjwznNwkQ0Io67FVad0mEmB0UlU/F0WQoLAzqlHkJka6MxIwCCipmObs76NL3JgWwZeywaATsg+/nX+ht0hdVIOOfrk2bvLOy5K9k/g+cmr82o2TgYDcKLTxYssw2My75RuqRpMqnlB89xWbPXc69mMtuknTWhiOW8j4vuGEuIJ1Anp9PibCIntsuJUb6evtZ1cJcAPtUjRcAKckD1HO5Lw0DyMaU4vikxytMwkmSsZYeTtDfndH3Bxyeh0tyjyFLSPzqYfCXwkzjbtr34pA6H5hFw8Rsr1Ui8ok12QETVoVCYe6y5eY7hUk1EoTYxFs3x0mIkKITNqfD0hY27W2/DOiXKtDWbOWS++ySYVA+Vv8ILrj9CXZfAiwNvlyou7L92IS6p4gLbSdKtFRIxkhGXX7fvOcIuN0LZI0YFdaCGlPANJu+2R0B0SqryDANjugQU0d3oA6C05jO5TPMRrdYTHrCygLYMSBxWZjgDn+2pw+VXWKPpGVS88Sd+ZuWP8m+6gF07ZEtXcMXIrOFfd2mu7zvgR6YmR/8THdrmCpHprkyAhvPTZD0Z4HSuezqm9Lmfq19BPjKuBzvh4pnSgpF0WMsiV6fXJu+COurTQojUFybMCbUq8X9MuLj0L4FJObbGaU1ktCae2XdulaBXhLeFPWa6vJLSqJPloipOsEdyJRll/YyWBE/Ziu8BC2elhJHtAJni/XA373fBrul2sl2zj6LJgLbuJNQ0YGpfctnyFKU9EhO1QUkDCnMW6vZbgM5QqpD5qWgPTybFWV8K3UgcTj95d69Zjye07MGW81XZOLUm2BWrHukydVec7Mf9cQDNVdyewmmcTVsSCA7yVE6AFR2vT7G6GlrQUohSwuDZEAiRR8uZjeiPmdC5sZ5/LKf2mgvljJqtl19l8n+JLO//4sEIzUFATkKDiohLS8Yekrlzrm4I4WRuL0WaLsKVXOO03b33wM40CKOmYcn0WKdoLu7fI+se1Df3sL/PD8jPybUlnw6OIG5HBC8qqH1JE/qtVXLzhHgCvyY02xPgbxMtHIxcSBgQCL6YYxVZ/gAS8SQKq+Kokc8jVbD1+iUML/PeITA4tzoX/1KkjAFbrS8ZqjwKOVxpnUroFCEuXAm9Qx+RKLExplnNTOsq3pn2t/gN0ZbBCfqvtZJ8JuJG+Wll7fCTmtyeah0HcH2tBbXltJFnNQ5PXpgxp2LI/483hbYVljBWyUIuCGv8FW/gMDfwW6e94Tju53v1dhq4lni/WiAX41FRoPQNElIcRX+bUJi3osKu17ONFbFM7hDHMR5IC9IIZjnxMwA+69vPC/D4rYKv/FlGJQ+7MSNYCF9dsOMWkn5b804WE8J5+Roc0CdnILOzt7NCDa4PzesfkjgW1N89eZC3YhKjhtu80LyG2NndiuDvMazZVccdFnE5mweqM45QHOd6Tp/z7x50Te3fZ7kpcaWfmUK2yST8I4udAVuKZuEVXQN2fog5NzrA82T9TzzbiM0zWPPEu3snd77zVnn7FAex926sJ7adDPxM3dK07+2XvjvgMuzXvvJl3602L9Uz/hw0bIC3+Xczrfneej/e/taPPlA3+D7d+hqmYnKhDtukXssLTsPsfuXK/J6BG5QBTPI6z9IvLficWv7RV+4gkvd+eETPLc6w8Ism3wdl1/XL9ds8v451uZAeu6ylsC/uTbmu1m6TqbdbsJ3qshuh76HmJPY1jSEl78WLopum/jl8wnUK+R64xXb1JoJPQ9gdC/r0J+RN18IgNBDiFYK2gjB4nDqNTqvScvuyCbTZY9Uarrj9m9di0MrmMCEgTTledBJJSResbE4cmaUpKmzgnrQK9LTD6Ij8xPtBjOIC4CYropktYx3TQVqxDN9s44litqbdZ1A8MR3Fc2Y4RyDo0m8ltKTzoUncizrFQCS+u5DySu9nF2Q4B7S00yxmeS67h5Bm4vleIvCooPr94hF2MnwIm4OrX0WDgJ5KdKu3i9xTpQdn4HhmrpbrEDdIHbjOrPpqiRvgLP9KiRNOZMLh1pCZ4ZY7W+ThbrcEjp2Fw3svZ+K0ZfTsjaOC3JMXy4Q4+3hiwS/gH4NKggVD469kG/uB+0iz5XkMVK59iXfbDOb4QUC+zwzte8IYZyjKjD3ij3M4VX4Zyo5fDLqDOSRXgetpT5qQEdMn1UX3drivfh4akMMomFCLMCqy+nVmGHT5VWDiaN9x0BpYZgWOesDB/nqOEdnK0TE8C0cNs85QLDI4dZ9iaamOhyt2OfMpZ/RDSBeOhvKcgAzpvyEIlnOmKE0cZxJkDD4Dmce8kYPIPt4HnWWLwTMnuhHaxot4kL/hM4fuxYGwSZJFEvIlabS5GyXco82PYrd+jKL/0D1cJOnHKJqzCeIec5Qsabd5RDEKO/sGLN/ZdvUwfJNfvg3XAwKmwtNQSkBVrBkevb4SYcKnvjtmSpPzHn37+xlEO89Wz4WyXyyzaSbo1zio8zLTZcLu0sot7tvdgtaU5v1ustTsXRWk58UPMK+4TRJJK0xoRMqN0eVpqVbtWmlAS78KdzXAgWHKmSX/bEsbJz9c/N3+Rf53DIz461xJt+1UG9D1kx60u/NcCohEbWajsgcLmWXUR0Hn9a6eO3thiVY8kSh9SzT4phVlwCw7nngoi3FwL2AurSF5ki0w7v7UTDvMQ8xyG+c9HnuOfAVHsUiQslvxSarDR2KXIQj2fiI4gOVlcoE1voYej9K/htJR9/usDqw91fvRaX94hDOU/4VbW+UhCXr51Lt8yL7fK5ZYYK+jmYaE9IVmUjK/z70wk/qGKOxOA4ayZGsonMqzZx1MXPAuFBzCCfM+yB/3CZ1Lmt2bPkpMsducszTxqL6h4sfhlX8Q8UVtWcRLLVAn5IU35Bx/f4s8qH2Oypvk+ewH7yNKLsa6idaqBZ4/RVybWdalTHep+isMMWOOZXpyx1lGmup0vq8ZVy6rVS8YZdg5f+nfwuXQuXq2Sl4dfMgJ+pdVTnS5CjpWK7WHU5HZl7MJ+OkDRLulvD5r/+gA3HmcUh3OpQSC8ttjCz8cC5ff2+H/oNp4xxjV/jlOUfjjwp7sAnmEy59fPTaxqq8ZVy9pq3eqxXlZWo2K82O7tZSBV9ky87F95yK89sy97l2fRK70tZrLQovWt6mCfCq2QSWW0PIesIti8jOsjR5rCbHU/H4QaHkY1tmrtuR84wmV7+HHPu1n7lgef9kQP9lFTTke4pF3GsmJd4iS8rGB95LeFtBlA9rQXNTeNqzEy+I927DFMCnuNm6nGS2m2yvRXj0aNQRngazB1QHxD2bvjnws85ZasaU494JjlabQrxeH4ffZnLjzy0kuKArQre7uZHbQqe7sxJqJ8ak59lRwcGf5ltUmhEcz5A8fAIzrmOLzYrpc69U7Ex7VyfcDV9l0UjPRRebk65Kwo/PlFG7zU3y8nV1xfD0nFpVmLSSwRvVG9wnIz8lwZEUYx8nrzVKlKcHzOnq10qbBmzYHgM+bU1zSn/jUZO6qGaE1o+XPcAi5IhfsbykYeh38jB7wJJDcFrbgOdPXSeuil15G0qaJeY7WxGwrjWct673ZuHugNrV/3smEYVN10jC6aBhUOA3cCY8uiwQgqIstwwCIM7gyQqfZtY47taJtkYauVxrJWasskR1krJnf1HPE9nA8TKFqWB+qmcFxi5SLbZVWYJP22HSO4bG8U7XoIid7hyKtGDYmp3kCP1NZX/umnn2b+N4R7QEK/Yk/DoLKN8FCcAoVPoLd29BEndxQKDIHL4hd1C9AFvoou2ss5qfiA7vD5iNajVMfoxM+xfnCBTEPEGZkaR8oBKjqjCaog9EVbd7YJsj7pyMIQvwwlPwXRoby1GWPOcShbIqwWRzGPQCZyu0pQlm0pFcdh7n+XJx5LxzyLTdOTQBowNToCFI3D652q2lIRg8S0oB01mNnCVKfqTMhr+lepThWZuEFmJyPyWrF9MbW5kbVq1d7Mp7WNTAirFT6V2/6ubMhup3ZQs46hsDLkwL/2Zfj5/6Hw0o9b/JvnQY4VmlNicuiKdOSBv2xGzH9ZAzI3RlYGiTn2ztlO6STTO/gsT2msWUZoWkc2O+vNzGAUs984Y62iPwlPvp5wSy6CITkXCQOdQyC/OiOgnWG9yFHtZ9qsDXhIXpEcm/J0zkyae8e7TEI7Vw0zavHhQLU6s9ptaFnGhdyURvOymJfWF+ctxkoNvAXEux4QQsT6PccX+4Shp6fi11zVutx2LsK4oxOcrA7BsLBbrF0Rm3bJOskxIXiv0MRiXdX8hoWyNGVcePvPr1O39Q5Letf6yefn5kvRkciq5Glhf2tpT4qvN0I8e4Nr/aWYpCkmupkfIeDxDR3hlbvrhZ9RbubYLYe4vf8OTi8i2cGDqtsfvyv+0/fz33z9PIF/uMnX4itf1n9KfyFN+uzjGQ5Fal/QTzROh/WmijUWINJ2QQ7LpDgXaIAL9ZAg6dUOTVDXBTG84GESDOzHTvD8KeLmTD9mptGJH5GiuqqBJE7XXp3We5vyJhVqb9KFGOVDw80fk9nqP46z1c1wf1PGXX4hTBb2VkXgiQy6hHk7d6pp910cGMUh9HH28Ub5C4YxNZf3rqcuYjJ1yj8kyiZgBcgJw4AOlvUPTp1alfBz3wK1mtX9KWRNmvf9KWRZmhv+atCDlfByBth3B8rR0E1GhbOol5TSgYXmwiS8E0LrYQbhRc6C6PfhjYj+PS/+J5tFUNp3WTzswQu92FR7XYqloVvicrGyfZ0Js2ocs3avfbKNyKvxS1vIDeXE1uA+TdIwOvAiQjSiC9yIhWJRMenlZLkRsruJdVLKyF8S/+QvLrTSVHreviWsSYas0EESDud4ixY9xp1TxrTN+3xh1Vuz580jQMFMCm19SD6VOU+3j0xTI5zmST02zmZ8iYLF6mRDUa+NPFARn0quOaLWWz7bLvHsxYCxZiPR2biaJbrt4lYnKZIW775oXPDbjLHunC+7hdnxxkvp0Ce2LFUkGbqRfLYyu6M6PF71qrO9nY3FLUNdnENDWObjgcZEvmLbHqmx7HkWmEPX6Hj19Xp5Ta7r/dohz7szRqCFJdb67B6jp3Cx9snBF1uwEqbUxG4Bnpv3rNFPm2/b3SC7TGuP24DT+319ki7jFeijp+HZtz7D5wBcVz8Q6u5t3hoCdiRBeRIQ/gxSYt9o2GvxPx5EX9PRrg/n6q6GnugLxG8ctvOTPde2B/5v8iHhLlApi/KdkNhZDPbwsP1RvPS4aP4yDItXYXV1RJac3SLkfkMg5JWHQxBb7UhEvW7lw3voQ2JAVA5rDuLd4ccgkTo8NH/BkUC7NR4CSZhoaSjZhiJjF3UsBuJR2oA1BmUDMXuYjJvkMPJehAxSjsQtddySqLpVKd1BXU4YUteRKjMqDnCHOUABxLj2Mkr0S2mB8SzJbYMBGHib5akExUjp7RXmVkhzD7dUin4K37YgT8QRva66ZZL3+35Omz078NhFgtQm7CK6zx52iCJWUCH9ek1+fTOl7/F1bnWZbrPhb9HrE4P/Aa085ApPcTRfXVjCXYlxOKXw7H9OBMBeLHDDrFNK5wvwqsjt/WBef/pRXgx8bqZTMpjeL+sS3McUPsKXwFs2hh+4lWuibfFkqgkyoxrYwm0ZL0CuEgns1UBnvWwxmG996ph3hVq+TbonNo0TfRY1zjJ/AGmflXKQuXvIMZCujCOTqIoJFHnwxKCszV5Q4lZ3khU0j8viyIemjX0YUewKt440nsAoLVNcnq75aVAEDRKXw9wUayulfXH8l+uJHkCej+T8qprGHl2oGbiUY5RuiDHtBZreTbhJQWpK/v940JqouSEEZXLoW+LSy4pCBFxOeqDqxchGyOzIWbZau3eAFnC4gpDP3nLdiu6D/5CvYWLjw6jEEMDcCLm0YAlvZkH04YZg2RgV7ulbLFSHNxsBmzvNW6ltzqcTUZ3pQIwrktD7QhDdz8TB0V71ejLM6hJuRw/6mrdMoNHIMZ0JJdw1yrK2dGzE6mGsx6yFpWQbEU3tRgoSy0xwgBjmAkDhw5xbuTPO8+jps2H0zukYk9mD1TtgDaycm+0ROeOV5flEXnu4uXb4CSBx1MfdNr7d9UhTl0vr0HQvhVtMptbHJq6cxu9DrGQ7PUsUxBD3zBmX/xcWKxF1WBdtiRzqO6MscNTkQP70xS0EnbYVFhKLKIaYQKCSMxuJ4gHtJV544h6EQdFDnuC8ew9G+OX1Wm9GLImEifUJCsP9w6UR3a0WCs68SY876PwevjKf+YO8wYgyq2G/KiZy8NWa3PTXYev/FkeuPYxUkogYthyN2yhmuyCXhrk2mK4G0F3kLr0QtcaTJMpMb4lwbd272+xBK/pY6uf2XfZoT0wsVrkH9dcE2fiVi+RSpmM4zeKwMDpqRXexZhOyI68DAdK1aUJdcGqgN3cAR7Vwii9CmBIj3nKBHG9lWdXSiqxqKMcdqKZQl4PUXSnLO5W6XNWUnjzn1Jym20GuKFGKKV3IaHIySC7z5zFlt0r0Ss69K2eFqdJ4g6pj6Q6jGturbI3iI9X4rH7p8/G8dhrdkHBmORH+DK5YnljxNmIDiG1iCAZnf7lbDoIVTWpQvLAIb5PWutXEM81K1zk0xdgomkmVEJaq1wOiUJAeYe9YAvICq2YI+mng7vAlv3T0g2ku1RFnMpw0AZS0SSwdGnON1Dw5wSDAa4VQPP6AI9VoPIod2ueJInbTsTiROjr3aSUey4jB+YCqB6PbHpna/Z7aDAZ9yt7l9EW6pssAkcvLnPzaquJ1U8E7RqRcpfo2q/MQAwIEvojjclZPPAtL3bxVhR8IOVl8ZfqhMMPs5WqelBmvBg7SDG6StISGEVrO4srF9X8iNZ2BTsqGMygbbt9M4srk9RGukqKEPWMG9wmlbxNiyh633W85lZ8XVHrRaouFVCkD3mjn4Lk4WW89d96VyOMSWLaL9j7HMYrEKL6vCcRFtzuIW47xokJU5jJ1YUL9aLOgrkWNwovOPdzjigHpkovKU8VMP56QaeHHU3WcHvJ7DgT+ZBQpkwnnQnbXFKQ3noZb9XnsHSkxW6/yToWcau8wRAkblmiCcc8/Xrw1LGgUuvs4Ilhzy9Jg9LmkwgaQhW8fZ8NZ852l4d9P4dvWeNFDDYHL6an+uhZbA1Y+Oxi2kk7A+m9OchHtAZsiD7+CBxyBaxYWlnoMdi1olXTH2ONf4ie+w2BK4ZkZ9yZGZqviXkqqgDS+4JrkUFbqYZgBAmygE4NKfOZEfiKpRXpOv6Q1ISbMkcJMbiYpKzLbmgYh6ghssCNwroLRkZmE3IU1tmQ1j7AlkKprlzarc9zV5kizlVGCtMnLR4ss7uxofiK0jwN8MQ0gyhUbCvRaC0At23O1v/nR78nDoi+vH+lDa86qvy93e3DbOB5stX8EacdkeEv5aJeqXTX/6dB99BHV/SBuATzS7PEtX7pFQBPCD9Hla/iJH9Zb6vIEe+dVAXaruyx1qoEcKNPwcYH1SvbWTPM/e4O6pV9niSluQQS79+IASRtXGZ3gaXxjJm8ZoEC+ekG9+QpdUwFRQNHypQmFdC5KZMzzS1Nk4U82AqzsMJmd1eP4JmLT057o2OIS9WFOrxEPxTTFwhkMNsy9PwyF+cRu1UwZvVqR3x+EaExPAQLWBxBC0uVADb7aEX6f4snDF2PqflpBYb5cEqGvaEnUT2mo2E+piUtXVkVPUZZnO0iX45je5+UqchL68ZWmwMq0akLxv3DJKpZ3bAxMm5G/j6Y8wO3ShcYFPvGGc/v4vBIm35wLeVQJRvf4vZ/8daZjO4Et2Yv1uUeJcc8xWWbfE4C8IkgSaXBBLnYarpdkyBklrIkoaPZ9Fh9Kr3PyIYlgrvUA1UXtWxRNbln9ND8MoFvF7/kxjU/PJFPKjeU2zlHbff4qR6Ythf3QN0gQErpO0P4pcxEINCliF71E1jJmWAc36cKYjy3sr/ASZhHIxSq3Q0uGdqbR6nLUSMh0WcCJQpelBHGumEvc0vMGG26TWuDhGJ7w4N6hQR80/GwGxLedLY1TDKOBcxH3y/iz7Xtiv7Lv28+ef0uToucF47RfMAg+gfZw6wTGzdmZNdvpurc38yuW5yTmgJtkKaNPPJECOIB5yy0FIacM3hmyEJN8aEQc1D+IXWbU4zwMSeErRMo/CRW52Ssy7h/pCH/OWOuPNkOO5ZDlujqBQADrcOULvppOqz8TDvlsrT9FH0+RAIIWch9q9pR93FsXXH+gQN4fvLv4aD/OdMry/0WyNrGCdfHWJyo46ELSIMiZjuv6lahs93tkCKAMFNa31Sn3LN62ji7xTjIJMxG9H0soWa8t7e2oqxCUHgqHKBdTynD7RNEsSVWUEgXR5cwHiay9r4dr6S3swcAMS0N9nEZep4w5vIYp7c1kD0SczU5wdZh+q1nF8qylZVtTwTHuLXmHsY7n3QwrJY0d8JpVtgQ+PeTK1FzbVau7p/toOrExhnvZHyNiW0J9Dtwnk/qls/6a+BA+u6qNAZ6cdtfDJ1LfkV5dmdNi8zFoczc3GReKauwRkErCpyppCJd2rGxHABg922IcT+vn/bQevy4+KZJyRyXWV+4vN6QDH/635KDnnFrWrCzC9vmVb/FfVoZTrMTAKija7r9fkRUGBRsz7u+jWBfA1nc/h4bPzN3YjPGU+5Z6cz7EQlp+Y8AYsmIEMW0SovjwReDM1/G1a7n828cgw6MHvrMtmUbkrwRnpwaEI7Z3SVq/Pri8+5xnM5T1kLde/6Wlkyhd0KM+vXUwPA+XlOBJsyHKc9VnMjxA73poD5UidBzce2HL/0P8c8JqUqINtQayT7/wq5lfxymTzmjyhgZdfhfkUb0iw3t7TSnpyyb0o5Jo7pdyeEjYaIgxa5/Dz9mkGAmXDACyX+rzQY9oIHdi3mxsqWgzAo9B7SmaRhMCFmZIrA9Dq2Q9I1Stida5utCnqRmqHyeZUlIFP2WGuOK2eziPRZrZ3dGNKnaZAlNDYerR05/ZEbuqX6FClAjwvm6eLUroWIphNkwBpJwBDfDd3jzL+Cq2U9eCeZcx5BKYG2ZLfpXTJqNT7c4Swsfu2AdUp53lpc/mzP4w8rKxK9/ylsMT/IVvv4UN04UVWsWashR+QH9d+BPP+Sy0vX6P7UCsFm9VLcd0tF1OPntFD7pAaRmm3k4YAxgZm6aSbfA1cvVN9zHJ3neeEC+prnt3LrTPD4tsMfAyf4/oPWXsBwtg2ljY7wt6+RvfbxF35MVYud/WYLu1vCkuMEvQ5kbNt589Y5iwouds4p1K8TAs0oSDzPovpe4643e63Nf+3ZPXN48Mgi3KxneDK4ELkLiBWXgVYsg9l4FT7oumAD98fDJj6B1qTDFSAV5gdu7A4DmqMZvYwUrm5rMRBh8AGJCCFiPVhzEVerh6x+kCRfOW1JUq1+W5FZ4kg2YwqejBwcc/AM/ER2FJO3nrq0Goxarlymx59Xu/SXx99okt2rXBJ08NqhpjjpUsue58n82nMAMD27HZ95L38njtz/0SxVkNLfUKxzDbO6Ra04JG8cQCZtY8pVB84xn4cQHUi8rncFsmoEcIT/LZET5u7Fivaseojez0N9sw/rjmhLUlvvIp8JA0m4+Why/KlxuAz/u1ShDPjBzNRWOq26wuVN1GASV6bSimyTTlpR2FM2/rWEtIZ0QAnl0X+kUAiAlTZFgv4WBHNs4a/slDcBQ9Jfj3XPj/5beZ7Ti12xxbPcrDtJakd6KBVLwgsQ61IfIlVGXIKbZM5ec6x5UtmiFABhChl9WyMvIvucDM8nzw7UQV697dTIY79fVJ92+t3wqMSAXuP+ouJAK7WpD4JMu62jeMnFIJv+xWzv6CxVrQGPLxyZq3VrSIwFTnY0N1TgTVv2p+qbcXvl7QS+8FHIojf3dEnkF2spK5i5qmPFgJo+A5QJMqpci9IrSjmu6oSmrinEKyM5OozQFKAKTp7WlpagNTVVkzEVVZ3aKMF6aoq6Fq9uHPZKANA9F+Pl+/9vJs1e3bANKlJl51acaErQErbR9jYC/037XZ6WPnTQ1wEkCFflRylqtKCr8FIECxAN+8yFB3rHHSBD2849GyFGX8WGXF8KmOpXWm319l+Zm4MtraOrH3Fp4zYl0MOxW9MchmUyLWqoxNz1tIHWes9cTTRPaiVVmLljrG2DZSYhV84SItFM4vN/08hwc/zjfBiEnLPcVtWAuZFwf9YEeudw7TYEcrOkzRqzy7bp9cPGlbZ0+1RwQX0cNMhb2oxJnjipfM3WqUYXa3fHq0pTLi7D2jR9jbMCThdJOpKs8JU7XMwmlUPXUTlt39V1lls/rieI1pvu1ushqnVB0gF3HheT/1QjhsuKHaDHWmSryF/TfSbZcHrVEcnVRsas89njMaHyM3mrCKhiN0ybTHve9tj7tR+q497s3o2WatOtKTYcaHt0ahtWZ098lzEodI8Ez3zTObtyT8zZbtjvJYyXwDDkRGv1NqnFQ5HD3OPW9OO7TGmdrpi0u2rFmmi1llqTenNvxrlpO1Fj42DYJd4phKa7k0XNjYrmVVX/Ie526XrAGvpY3JiciGbAg7LOC4azezkuPWbm6y467dT9HttTshHCvcZPGHOvPPJrskVJjorfJQv1JkQY4yC9+Kyge2x6sHqeJbyOyQ7CYxVoi6OGDwXL0oNHZFJyMY8QWmaMuaZZNUCVLbPfhaOlgdfyotR3HiBAoPUPJVK+iOGX54QeLJLjF3DGDXfLZxq0mDTdXBh0dmwfC3e12cLqhJyFPyUPo17bd18/zKaLA9j/GTWzJtyodT26UX11D30bmAzdICx5b2xlgdw3MbvbrZ/6HUHl7TTwJ6tggCqMwXYHRe6zVRCGpTzKq6iCHQVuIfBF3VjdHIoHYuphosgnpo73ArDrYK49BofxXPTcvFMKxAcOMrwsgrOBLZCjkAK6vQN53klM+1R+npC3Xym+iJ5IYiipiBSIqwIm4gSmxxTeFAFCkJJ80DUaelMukgiPIseZ82IooAEHOUoGw/RcLrlN61Z/O5UkMTf/CPH/ne6/fPT8frNG+reRIN/rMeCURkbyQq+MeJ76eyRuvTr4jObzlbzpfTaKJCOrmRefbhLdzqlJSbqIWozBwbqWu+i4N/0x0YtsQvZqZPY3FF8K1iGSiX7eb2OIhjounkXZKN/UguPck+NnNq9pBdTVOA4tMEwJNXdxiZhPg9tM1OtrD35UtaxH25Wk7PPGGz6EUkZDmyGYQ56UKgaKciPT5mZZZsseGitD2cZ7rs+iWIibNo/GF1qAKpTqCBrlTSz/Yzbbf/LsW9DGDsBJQnBiZ+gbkXdcaLph1GOVcsfjk7EJhGGfFmP1ldhjJHJ5Va2b8V8wFrHkAMIiZXnubYOMmz/QCiDVUSP0sN6rVArdUqws3FA3O13AylY730IarHIocbWwx9NZ6U5j2/yHOM9obNYPcEZI9L01kd8djj45QX+Oi9PZajAD7v7d1f/qBP1NM1aaYIuVablA0ILukw2AEPVj4nQsJMp13XzKEEM3hrj7aQq+M1+QLe6gKecHBJESE8bMW01K38imPPPdSbyK0Si9cOZO/ZX1OVF8+pxFTodGBA9CDCZ+iUwJxnwYGtFnxxXBSLw6KihAsKP6zNO/lf29hqKAvLKoQc9iUTrfxqaqiiR40qHNiJmKEd++9/147Bduydpihcxiq4NknUWk95TDMEIYlAtywlODQx9JJpKVYa6XRE5o8okB9ddoEdGJIGWK0k2WVNio5HltpOZva89NAZz1cwqvXhgQcSptIlOZcaNlG51oHU5u8BPGmURiHxQsR54dRLW7dhv6rMOXw9vCe1aCL8Q51m2dnvDXa556N6FbOqA1ftImmD9IM+ZPn1aSub2NOxubvrXVAi7dwBTszxZ+rv6Bt4tjLVQfA97o0KReNUVlnTrfDuf77L9xQHgfm8/eEQdeUGyaQbKLM2eZSZYNmHfflFvqt2jJV6ua/ME8BJl7blyNYibyCiTciGSYrm6NKEndv3KEx/YUfdvB0hBz3x4g9jDK7c4aIV1YKRWbaxdWKMprKfxnHnoqFC6ltvfk7kIOAh5k/7WJ7xhtI/t5VFpR4iQeI5mHOAKqCe9kemDm3mRuH9/00bOoTK1ZoQpbvA3MxQVbPVabbiNfs0rcqDhbV41pnDnOghL25ouyVN+7a5Qyq1j7jFdFoXkZ9jkpA82jGCRLAUSuvLE406MbSLPl1cG4/P596EiR+SWsxLiQjhfZRvfG2BQU/Zf/mKIe01FI+pgWCgDJLevfJgYfFdgcMuLH+m2p5rsEXqmhZX9aps58M2nyXNJBrpkLqOqW0lu2zOo71E9KLuBIVlO737veHLIUMUpEDF7f0ROOK2N229MGLMUAXfsem/Ps0IFzT+2cJK4xd2FEGmwxhMUFLch77Jcuhb7GMWKxFjC12sVrYKPgzZW8a0m2CcHS2yhMNxuAd3AVuwmnhxFXCKlSNi5a8IKLucxep7UESH8Ed+2Qc9t1MAwCFlkYQ1o7a+6Z+Sta8HxXuKlQlQp+icoJAhUViqfGUeXa7jWl37bjwUTbgx+7AyDwgplX6oHh/gxRK1kkNnR8hcwElVEAZu5HjHDLnW63Rsf0CfhNmZPAnqqZIx6IgnnrOwJ05cyWPJzwPaKJiXw9qoaPmJXxBouVQV2lOxosB6kR2I7sRz9BIKF9163DxmNsptlbrgY1cU0bLcl5avm7kvrmXadopMMB/f6Mj+oEnfKvSO5XrLIuoMsliIHkM2ZFsc+UBEQxdPItIXq6Lh9i+7YSef47teBDK7oJckMGdtzmxOBUIbTEpPkCfIry1kvaNEb1LfYQ8SH1sjBx3BCOxCA0wrOWMpJw1THeoyojBp+tvnHmSkB4zhs02ePPscpnZmn9JuloQWTzrBFOiqGvAl+xBCJK9YILy40wVzznsHDPwqpmQehXMhNN8i0KWTzJX2lqTLbrobX/Ad3bB+gyViw7SUcVgIBIZ6fUyno/yEdguEvkwqNukjoOTCfC3ARq62Z3ido4BEv5cJwOOEtJkmeNI+gITSOQCHookYbM/0hBmsKSnfWgcIGfn6SmtMwg8MCFXsESiXIl7Wp8f8WucC7HHDmpYWTIIHcwH8mBaw9F15YPx76hlOaMqMiZraqeR/m65gJWLgHYR+8VrB8cubWLz7xh580JIZNjDaIfTEnLX7SResWKzBrRniqG54yyfyztiYQOhM+7ibXqZEtmgVXAJQt8uGJ2r+oFQcAqwNszsh2PxtpT1g+JsJO9T83FYwAZrY8qUJTTxYKdRRpWZXyzpUSTPyPai10U/s5cElont8HP+5tm+q9fWDFjkbq7nIqN9HAEITDtNsMKS699MXo09sAKQ/uscdndH8vWj+b2rSrcB8S9DB+MixMWwKfcsRrZg9jeoQ/RzqnUONCCrMkYEh58QOKb8aDaRIsEjsinBg7caK/bGPdMWDfgzoxvIXjA2xehzAnf9+FRuyjd9RE1oNYcqBddn2ZdlbsjwutArjYbAHzN7KKKBvWpcecBv/vE6bBTJH7xCzcIh38oTIIQp/3JJEzHerqIslcR2LYKGKGUKM7PHs6bve0EMEB6oSlsGeiaCC4mkpmlWsIGN/0sG/GRQD0cgRKV9xByrEOY3F80GO+KfBg9AnbwtZbvMY8SGbuW8La/i8K09IkcT8T1AcEeKqo1iJJRzFRtxy0vT3Zmtt/OBls+MtIDbCSTi1j5oftH+bmfQqFGx0roDJLAlLkvZCczZ96z+yPufJFBZyR6xuOfb92pBslZpEa0CI1IUPC4WmoLcJFw6vXyzbvczRtqz6q7ntoz9VVU6+mSWye3H/uIdPsLOCDYrw8aAEgvShpJD5lSmsRksNMx4riXG1C7QmRy6SjbvbJGwYZZq3UhxsRV6xiBOZ7QR/hqK/DV1u7ktFHa4wzbZwVt7YthOF0EWJECngP1YDtFl7BExbg/1HEKPnk+h9CP2eZsOk9TMf0cfCGLQs63ecqCQ1KwfwQLZ/1ScsVkt20r4Ng3ibBSkvxaP2ywkqoiV1l8ShQaUpC+dxptmBZ9N1tnEulNMZf/TIlOWf6AeStvAA6hM3TXeRDYOUCE1KpVJcXSgAdasNCSBtlSHLZ0K+NTekCpKNWALAOWDzCjbUXR6QONDskq+wId72F45NQ8UlfYC5cgwf50U2Rt2hFtq+OPxk1T1U26zQe2KXUjRsAr2qtoGuija4lbfM8pLCh2AbN6u2985gSkmgtUykn+XdFCZ+FQU7Gf4BHk7hDJZ1RJ28SZhRgyZmrS74xMvuPVg4K1mcp1BnzY37vIseri343yoh6kiEZmeZH0+1aGgy9r2JZtlwBgOKBXKRQHTS8pCN8/6r/yBisImYdMSyGScr6gUZezMNl+/1uOX570HQ3W6N9FfcUoZGyzpVpc1+lkRpo39TiMwCFoAyhULqal8TNG7gGROPP/hxG2A0lG8vlm3PtObMY+7HGfaSm8z9XupfkUQFU5R7w7lI7wqoKPfSiAuI62WQkzAMkk1fOoxeLzUyDz9gI/vrQkyRS1L452RU8902tohbA8e1VlAGBCCjAICaaMwoNMBdYEDTmsliujFFkymDdNoXsw3Y6bmSMWV4naCZbakhcJpvT2tY/LB6Bp+O8e69w5srS26vBe6Nk/3A3P/+FzaeL5lVz1ir/XlrIMgvuy2qt3owctaHxlkXm5UV1B9/i6RgJREdO4g6sCEF6mrqF6lgLxrnhQOusHkCdBKGoz075GxSK1ljKMIkRqYaNUx4yNmPY5xlie5+lJALfbgDULFpKIpfbYyY4araqFCz88nIcAziJs+2UFYdujLukYk4R/K0HAjcdF40ji6ZMc9U4sJnv8yebD/0mRfFsrKB83tTStNvHwyBNoV2TGGXvYpTR5q/QkEoyEPcReOIv4ldScAMD9HTo4z5wOX7D5mqQBA6hCXDx+tqJL7SlphVcWGsaJbsOgC7/Qvl33v0zb331HDO6hqX2hkZhRJBMrW9Xs0ck4JAtS5BVYe6Go57A0V0JURPo7AhDgYnrNJy1QrzcvnHfP29IdoGRvt6BIUpMEZToOEJyyZbJEOqlcBsetmyYsFgkF09Q0nyOFUEP1bUxDCUCUWoPQNYWOwbA8QT3wZ6/OS6/sSdgmLgzKivRlpGcNSFdim+djhWCkaSMo47H/59WpRhopMJN+jdSQyumldPr7GqJop2UNHG5kr/uW3DjSpyPENjrHh9XH73B6qjD7cDlxazORfVv7L+KN8NVyO1N9H1VX+z7/qpvk66KrCzDXDwSmuYuG/M4yAY/sq+73tVfQ+w/N5BDyIOYGKwMJbf3PiEHrh9oH19NZbin5n4jiU0At/5MCiM8/3pR9d1OarS+BnGjfFsd3RFV63aJibiiw3l1F0o5bNCXmDl2/gBPucijm/8OGIyg8XBH7SMzvXQ/c18HXX+IHQT/WjhezbQvZhq/3JPqPrfJ2R8Ot36AjQlmE6lTp8WJDQTPY3tVdRKXJyqZB7ugDpWCabH/0cUqoAPb64dxHuOLpwQNmTdPHWzIqH0Geo4HHtK3KD4q2RvCkkeictX0UsQZAwU6YFnFT2s1arVFCvLemDBoyw1TquNokWn/NRIdMiur6v6dq5XV/Xnug5/ipU1uB5E5grcTPZmsQqyzr4Xi5BhM+LBRv2tTjAqiL6JRxJY3feq88XfcAs3w1IdX0WZehMiZ+qzgI/Ip0b2C+yCABIp3BeKNtMfQN/5Ydbg3SWw5rgzWfI4YrcouXlpIqcYJ/Z8cFNgSAPap5cqn1wHtGXxuv8W4sCwYA2QCQEEgBt2zLD7auUEzCLUfgeKsOT97afUiMKKBLWlRpoHiexj9G0b9PcAYNVrf8Fb2Ijx6k0s7KeRPdxVL4gZFiekBP6EDDplA980HnTdbPpAv5C9JAQjeqHAvXTeTrStaoX+Jp9GcQ7nNmvGc8r+bkiAUA7YL9HNCzK4QKWzKi5EAphdvYA/6IHbVZ/HmiHPPPbaDm4RMaf6jdI0vsU+fCCb7iFdMvFtKmYfrMGSlfB2G8T7nLXNS+UE/CuYs5ikNab2KgX88ecZ9AvIOBfEb2PUDYJPPJljXGQ437jOepMlyQVhM3DOBJc4e8muIR+VKCnTURoERDoJLvYhOlgogyfKh83eYGj+FkLwNpoCEjVUjf/mqmC8iAbkOGYRiQC1023vRjpc94k9CTmL4KORBkdWvZH0RzLM3rPa5xoLGAmOVArLQId5WPDPYahCPTzkKbbOWOcjlkXuSKaqohtmNuKjGN+YRqKvEAE7I7ZTfHxSyHD3lkeZxGt2x25DAFB9y2qyCo88Fb75Od6HihlqKwrpcqJaKVYY+XQhTvLlWSNm9dtmU9/+CMqnsucpwwc+uP9M7FxB65JN+Nm4UwwanXurqssTPT6JmoM51S8Kt04o4zcr6P8rqd5aVe8rjGv5rHtjcEp0RyBCTEoq67hilJTnDuBVUGwpzcP+9La4wThO7cKeYmYc0DE427lIAvYLlfrDmAAqpwZrEtG2cFdnl8lojkNtDiGlgpA8OkUjGkdwCDHDCPaAFKnAl7RNo4Y3mPo2T+M6VzKTc429QD/NLPwcqqYLwg1prvPuhssZepv4EFRFoeb1A5taa54sDz9Z16bwzPHTj8m4G9Z6tQHK10J5Y5CuT+G1zhE/1JIWY5f6IiTJlTdgdwq3F5tWYzWUCu+sIX3dswg2Z1ddEVt5/b5D38J/LIkhr5tjsaEmVtWtv9fZzM+3OLKv/2OTM1EQSOW4G2Hz16lM9vvTl39c1kBRu65XjGaEsBIwC/cDp5QUIynyh+miElYctQZVNNa6krQw3I5TK6dmbOxho6Ud+jWvH44TjVS7T14o2rcfMm3T0K70KZU0VhiH9BuVAq9ttnfaRuFoSN6ZHfWnXyM8zOFzQ8hW8bHj8b2jUk1D4DOgnq2yv+5bxxWtx7KMj9OTEexBpEdR6O0hWHCNvdmIllrZM5TY3qy0+wRgV3cguVrlTxv6wN4kANE+bQiTiHoHpMjyNZK38Gn2qhcoUR0dvUrCkqZOjOXnAB8+VbhfQg0CarUvPKb91yvV18aam9XFwkfYhvw5ake45ya6gI4ktT1wNp1vx+PLPC9/Nx4nB8eYL1Yil2OlDUp1nqNk9e5T9Q1vYrZ/1XlqO7lAK5bnJ0wtoA6VCCkvJxK6SEmYp4ePjj3uzuayb1jn6/sFW4yjEBnvjW6t3gP4BnYgdqjthO+3iSJc1fKu/4tm6qNaUUPlHWz22Ulf0Bvxj+3CmDLKrM45tvWUE60URNFYzAyeTbReDO5eLZ9u0+vPyVIVRUQMV2/nyDxMmYhyf//X56P8bpHM7mGLJ2QwVbof2MQjL/NRxuI9JqQ5c5Nr2E5wOP5sOZ+FR+7NZrr4V/nuiu5mgM70wsUPp/Z8A26BbWeV8zExqA/Ru8e+ju11mnjTrujIhm3/K/ayYKbN4GxARZgeVurNisDgKxQ2D5/9wr8++HFVjFnl6W2QV0qKPLXUdIYyeV6z4pEO78OmoHwZMsUUa8SWl2U/BYup6RgzfKInjNOcXWLKgNsDY1Fm/zDmMydiCbl9LGFE1DYzrwdL8vPtC2023gcvHumIudU5UfCbOTqwfa10Yf9AZtF94mIHSPKwuyHMZhR+Xtrn4JQ3BUcc13Jru34L0xkP3dkKuwxATN2xPg+o3jWmZ3Tjge0PJEjXg6RQZDlaPqliQIV0oUf5tOcIQPkO3Sh8f55Qvg5JFUTnQ9vAGy+DWYhhCBQ8Y2/tLImQ/Xj3ng3gNFgTCgHBNFvXCU6Xv9KPiFs5DqGfJAs4AvvhkyptITKlC1cabCmcSpAjHm+txPGHeFUfHRB8jL4JUgW6lwt6JFAPLrZahdR4Dz40sA8x5vzG541f0wc0w3unwji0nTkHfayLeH0sboK0XVRwEKCAu1RO4sI+2J2jBZgL8HUMUvrDbUjA9seIxX4c/PW9CLAU8Fg+gSp98fnVToQROrpo4M5dszJ6WRYoTPgHG0flBkhclL9HjoWG1xMuCfBJWKKxHGvDo7Nj2YUNMRWzeVXfWKcLRl516lA+BDq4CxzhsaS1NwSiVAoa1sMS9L/0h+t4yZxiSxwyzyp3bIHViOQebQNoceh79Y/niqiXqq51Afh5YLVazvD2qoRB3qnQezi4xjysQKZnVief0iLZSIDJha9/FC6SRD2pdtU3Lzz/X/Ze8VK6Kzz5+YPP6BSvXjTtV/qKf3Vq9P0vka+jvP6cNMJFweUVN4r/daTRH/HY/Lcdfm/xNbzpjA1+lUpG2JSg4mV1ye1qP5uFLy9XNuMeuE7Beg34mC96HFGCobwsZ5tYsq4QAO2CXV0SxpWSCpxZUcQGjRNxJCoNL4Wyn6fe3HYsAS7AdPC3OSBwETBD51YocXgcI2M1SN+UrMiZAvw1Z5PtPcsOz2bXCzT3YT27VAdvC0VPMbdfpgqLJaEhZ7O411iy9DksR1zwtVE98ETKbVhBErJXG/WrKcM5MpcG/qDlkY6fnrTcgG2w5ZqXh95PJ11gCbpU+oeWhxWTPT7U/aAZoQd+mFHw4B0MPCxAdMpMsQiCzKJPhn0vg7VUfPJrHTAcaOEih2HtLjX3MVhG0GXLrxKt+fGfnYgQS6r7d5dpDBCor9O0N97wXivkPjST9cfLJRTsjKjs0nBV2puI9wD8iJfVAc8zWvRfJZ9FS1EwGiy+nquvtDy5//bycvlPS38VVPNQYCuYH1bMK3jb0Tee/zruhERZ2+YcOY/862/ajjr/+SXHWhd7/KRPf27Z/k1+cmCvAoTfSHn4X1FLH/+L3vrTHtxCvYDlWocSsoz2e+GZrZdZzNf++JLWO8gQSS3IDYY4qyh/qN6lu61vWNaviyPNPckq/G2L16v+1vNHYkb09g314i3yMRsuZd7V4hasspgwCKIfB96yk74RvMH9+YJwWDICuQCaOAMtxgHwVRBj3c2ex4gQVEwGf9ce8K1vy9wC7EMLAoa6QXZ/MIkbUJNRX88l9xcHhWB1k3McvPDdaodhzG3dLa/LIwAP8fM8A0hxL6hpDB1I1dZuTc0eHEkYBsZ3VF/H29us8W5GfnfQyE9lvGgwh/rpvD/gT2jOiikbkoZTMUh4JZmzRuE51ihvHmedtCSNpJawoD815e1SKnc/wqXyqG/hXdBc5/2e/1g1RNQMevpYejINUolrqTZxrmsHJFRqS5pKjBtRyq2KVhHWOsRk7XLr1+OstWCqy+k4F8sr1U+QvImn20N8piaEid7wrWK3QSt5oGPNAQL7lBJ5tMyX2XLSSznm2ApxHenW9qzgAFYSUiIpsnKrzdmdUvYV+WDPl2UkIhOT2xASWYllRXALKieHOMg8QQBnvzWDQ487jGz5B+sY8rGpkxeEAxgM8ZKkUjRZfaqDAqmU0IOr7BUKN7gJS1RvIJQm5DO4VhM98UGH7BMevS5KxZCPN859cFiCcyou5egBgCn4cXsRxEoyahOEaPGm1hIjS2gWydhzLnImddGhxBE9KsBU9A/IiUHBXFZTFHjNzr7yt5LAhBD6GILXS9Or+MUYDB8I+cN6WJtT58JIGpVuCT1rppAha3Us0zIwUhBfFTB1dyXmiTelx12geqQmRI4v6OAULdD0w+emHz7wtiFznE6wnBfkuFl0q2LuOdOOGy2krNEgxw/J3YQ0WxkOaBpkBzAyQkSO4hgSiNQjjaiCJvBMNK0SFU/PVj6mtvtoZfTP+WRE6LF/0HbzH7YdZ2ezCzlyklZcJPWCaSI8v8EjfOALJsow1gbZGp5TEn3bRXh6hMu9YkusMDEvMAVKX2+8ufkY1m8Pgfus1zIqFjTanaNAKJld5EnHbVIN6WB88yUl2sq+R9SIZMviqzLsd0HgiNbMoQc/LNI3w1e3ilLEo6yJJR5tVqtnjsnqwEqMh0SVe6Vd3HfHWAqFpEG/hrT5rIz0XpRRlC0jFo9nh1ayTdIYtV+ZUlmyUJK+M3fSoXq47Jg0ijaNR2xN3vG27tZcgKZPHegzJHDtingil1CLc0BerMesTahFfW9IrFwhqyzLXB5c9PL24LnNH4LLH7bUnrFforsNXJvVq1gurBUGf9WsZyPDZxPNZ4zO6Ik+ledceViJC4FXe0E7GcP22OKnN0jGu8806PwinNa5M6Z/3hOiFNwCFt1TssY3feTeebhLDn3T7Ob2PMy4OZyeRsiwqSaMuaSRTOxgqgKlOwzJxptZqYiwbRhI3iL3HJ2F1I5JuwZ3OH0ymM81IGhsPXCsOtnMxmXVx4ZJCr6JHGGMJL7Du2cNVyil3HuEGq+Li7eIGZlJBLMsJtw4LjUEqlUkpsNHgwcBiB7V35mNf9AANfvXCLudYX3wZsFQD3631yBOb7CsUdj/LNQ18kFl2so7AwpxlSFD+U0XLxcmzXWj5b6l/JsJz98dNa2ctvh9QdtFx4kkplpYScW+fAbYf3iZs/gT5e6viyQ5JjvqqbvFSOQ4wKDX2+B5ERo7mq4vvNEA28rD/HYM3T4DacTb2VU4xRH/6/R9REF/b2/iwKfD5u4UmrOIoq+YhyUgJte1qNvgQ5pszkPX94qmK8MydVNsXdnktfJIOdnSbzdoInQexngc5/m7yn5i8uicHfpqdEg2UuQNW6vFUYF93c4JpQ82raZCcI8J6AmYdI4vOhp10hlgwYIkQ1EvHdRFdQoSu98Io4A78MpHFOCqJNzt1ftRxQHjB4fjCZnCxjrJ5/mmOQCOVBvxG9yTnYD3ztqwFyqIlr9lBoN0tnQCKH+k1Q4CRjkcbfjqEZQ7HPCNHLBG79QLf5sENA97jWNmTzoP8OmZ/o+K47pzi+iQmkMNz9Cm0sjQqyF0eLQCoQjo7JsgdU1YXHkjf+UfKhAVdiikwAgb0gDHjX+HjmREFP1oGftb1r5hsyjSrYzNuoT4VwFmwyZJ4K4JJk9Jlr1FWmf2cOi7JgHBHglezjzeQ90bxy2r9rqKNeBoDgtwdO9ZgX+xvs/ONBXV/SFgYKXMnVPYsdk6ISKmO2Cz32+iIVb+hcW6oMGlnSZoCEdzaf8jSzhC2QvTW/QiCeKp991lxXVnRVJ/b5iKfGUcO434Z31lnKg944kUnYPfBIxaVZp+pC2sf2Fl2Yifs82c5Io5ejsNr0G6WzrmFS9/d2e653aOWhCGwz16kpMjrDtIThw/8e3lcnDIGFCjGSetwVXK2SnCcKgv35VIoFSVDwpOM/3qE6+KktXKsV0VdNTE/azG1RTuYNymXSpZlsXcb3leMMarsJu12eADVV7RjZF+uSqJogNKnRgEFh3ejtt+Ue7e7I4kk21rlpX1a6J1bhJWW72F7yb9Vw9srDvEVGLh0b+GD5xlMhT5WNKQ6CKZMJ9BJERpluRswEL/ecBZ1NwOj+vHkhAJFwxP0IVplTD+W+YEEsZBQGqxbEDUXIEWYZuSspJpbgc0ywbYCItOL9ortoHg4U30Xw9tOCqmFb/G5mGMfoDeO1rWIqYXKHaevShAsfA3cDsylU1qiA8xgR0tTE66bfzxlx7tszB6uH7zg39WVCn8hUuq7mHAm6Zi9GzmZMxTKtt4ZdWv08M/Vnc70uZlEokcuFYcw1oJ02YzLEYOtP2I0YlFWe7sGPX2W0EMv/oZlMtd7yEITpvmMTmBEUc8BsW5cljH+LDv9Rf7tkOQ7gAZyxZuvVIq9TgYBlEoq/d9v76HtFxiI4UK923SWtRYQSPWmFHIdicmlVIUMd/NJX07cVse/R7vbGQnGlNDrF/Bt+reaTtRe6PeYuAe0JlImH6+Rz937Lv49fw6KHRjbKololHFqGl5USXnwhXTbVkkoiLngnKnZLnkOUv+rpHGqMj1I5iiJgHtfE4YN0dZ2rFlXKQeO5VKkeNsjSAIEk/Z4zUKl+g9i1MlNtzKktfHbNS8FvIhYFiEUk4X/QfUYxz+SSlHm77jT1CaWSDZebycEFQvHV60+FCNosuhATdPBGAHEku2F2ApAgUCNsw7GDpghSBKOrudENK0uNMEd5OJ8uRkp8uJkuyT/KWWvQgpCLLVPBlIwIsNZbgei2/7bt8bKVrtuIG+aQJEN8FsyZ8sjwTDty1OrgE9JbZQssHyaNXBf8/oM81KRyJT4iuw/sXZOa28zGaIQDda5ImOpAlRKZ7ALk3iZtlW1BG9XDbgwbog/bu5XB8Za5cSgkPKIrtQbhLzjkmQniHJlXf7810vxSia/obTqexRLvmcRtxjC3xl3GukaCki0NF4C7CHzDFO8mBOwC7SNbuirD+MpBwFkHWc7+B29D2yzOXsRubpRzBEHiVRXqQP64a7dfsI+uwM3/sIntXWCScQGGYQCq5xNBey2MnA25aZu+g6PijPmQlRP2gvyeUww9BYRjuirwqR8/Hx/JQjtQWxYSHWX4g9Cc7h3SQAD/CKIWtkn2NiJBVQ7UeZdycaQZ6nu4SJ6ykOab6LutPfxHna0f532L5yqlthg2zltA9IJbndSd+ophnMjlvp0Oo1ljZJzuQp5j2ug6I9Lzu/A0DViHU/eea4Z+TRHqkfgv+qitrsMGsQ3ynI9DUsXFfkxA4pn4rMbX764XMx9TIxPrp7uMdIAYZRaGafFGG2D9y4NTSUQksct5jwNL5ShOt8pvJYR/ogga70ITNAnmYk1KZJb2Z5xAVqCy01wBlXb34B4ACb9Y5APRFxL4peaow5YjueQrBwm/5H//EnS+nkQsqIp6SN065rgW+wDxo7EdeznGtLwJGgKbTGz7S1rXH2XoQGLAWideuRui5N8dnhh+LFyFcNW6ifTgt+gMc+DrgsBu6iAAu892roW+MKD7pZz8lOAD/1KJd02QnFykUwckViGQMLZh6SkU24aDZo0+CO0jUYSBLoqI8IdQX4I7wGEGP78NNX47PD2vsvY/qRko17QPbJBKRXjdegBeKhQbql7jEYwMghVWr7YpIdHrVJPBq9woleidbs6iPyIrpBHaZwwmeGKPK6NE37HqWY9ERTomTsriexjCLNmsAjdOJHYndO2Agc8rTIoQ9kP15rI/FspB3+U/ZPGTRE3gE7bioEXrkBjhkYkvIERmSSAySzn6H0lbCaLBkda9tn7VePHymhSCrBmXK3mzcvmhes7YWLy3tInUMfcgn0ll2MHBANNNuYuQVrbc5adfgj0oE4Dbheg7esb8VlZz00gvtRXcHN67jZ26hhJaMeGoHAdBVF6dupHbGSfZN86Z2KFICkAoietT1yx6E2eIH9pQLXiCucwzE+FKtQo2gg7ppoQhhNbLQRckjZDUvoQH+wp9aYbSF6wfxWuRd7e6BjJ6zNr1z0dALM8LiAZ2iDCZUfY4jtEDRN5/z0x6miXVKU9dQEDfBCT8onCg3eZzQ/tAhwLB/7ajUjhJfKyPpwgPnAEIS7Q/YBzLKUiRRLkIQbmB+5Vzgbl8BYGiBQLJ+BQeRUCLltqWdrkQaee0UCyGr9QaH2igUSLCIbDsS9fYoeEWodLLi10S++OOFk38SdKiipk/OYNwvF8QvKCWvjOa/Wd7U5rrcHgpCkjnrIISs1+WgBr85JAe0gbZZJjcPRdU0AsBQWhNEnD5Ee6tXP6kV3Qd+aEIW+/5y5Bq0qRm/Ey8zS3oms0TQpVvGdokgDFkc3zZkc0LLvaEG8W/1Xw/mj+1LMrFDKBT+jxW9PbKEgqXB4T0yf1h+JRbwM/VqfudFVEBKKmA4L3PoDSAqkfCzQV3qNCzVryL2bL/xFOZSZthbqUJQnGltkarUn4SkoA6oF7bqkFzJGke19vV+LJSQuvuBpST9yOMQ4goiZZlEUB/EFbXXHTNQOUNyAG2Zp8QduHTHgbLRD/ojgXv+MlUIKvk/MXbgkoCjR6+Ef+nFurRSIsOWHiH0x5/fzGbpY/BIRiOBdzY4QOgpXuU3hMJlDLbeUzmXYeWnGQFQnmmVqrZgosSIg1IqF3Mrv2xFwBy10mSdGZbJICyJLeEkmk+j0s/NxnAd7S63v/LU459OBKLCU9zN2ctE0dsYFu8ho82FsuhLWQVwIzlRHsMbGtLc/YYt8VKfXQ34ZtRAg1pYPlJIF2uRD+MUCgRpXLuVLTu3/NfF0n6Kx+PAv5AmvwqDoGwMmqxGgJKAQi9QsMB+sN4v5Jfuc5cXFKY39O/vlBM7LCceAQqkHnFgLC65m5UsOFcFlfNGrOFAS1OBBCJOU7fYbiXBclmE9/andW8JZ+q0F0DZ2qxb2VfKTsrlQrLjwIQcCtwJWtlBja8gVXs1G1zpn+G8H9jq5yObE+iLKWMx3vZtpSGoGWYFdzN4jUa8dfmMiFEfz1djjAg3e1dgL2ksWGdZf6XOMupON2vDNzCIEzyVeGslrX6gYbBlNop4Ls7F/cLRxqXhjvc2tjvfkVh7homFSLRgP9a38h9/DF2t64VqJH9hZa+JaK2RStQZ7zJl0j2IJSVAQV4v4+Tti1TBrX4+F6RSpwjjrmbFNvUcCcGu1MZn9eXXWbgZlxGgpwCjrY3o79l4IwOeURVEBoXwaRq+rSlCr0Qz6TrJPPy+Pvs8BExQMwWwlDqE0c+iIBgEqJJD5U+xtgon8J7hyNxToH/Krj6TioBHDLULsx95IFj04ZHasYz6E/F2Nbs1nIlc9bnLabVdKaRWQ8qllbrSHHTYgWHf4tMbb1Du9H9lGnlEqHZ5kdyLNGfIjIR6c8IEBPaO34wyphm9ic7mPotOYUlVGEp0KWDTAqjCMXuhHbYqdtqOZ6mXtMw6+9Yt55fFEJshpseC9IdGTPOemhFnGWZnH0IHa8jtWvBbwOegiwkUElxQsK4Uk4MwyEDq7MUba+/iA+BTiL2fLTqHuxSzgGaWUIeHbZCe6tUzSopO5tb7xdF2M58O6S/DmnnJN5MgqHfYIQdDOQ+fsBYo5M5F60IkSv5WskUKkVuh3Egz9hmOy2nRmaBR6+31UP5bHjP45/CpfoZOf+YRtCLG/+9ZYZ+t+GYYIyz5OjXJ2/ZSEO2HvxnpTRU7h7R2sg46ZQIe4J+QIKlKw+kl3GQPFZPx68L5E0H4hB2URfY2LdZ+JKj+VNV18nuVI1WcbclpJyAtHfUDsGRNuQRdjT/IQ7HHEeuzj37RXU1nOdRcQ7dVlo/QxKmo1jDpkwF3Ux3cKIZHHjD3n6rLKerGtnJVAuOqQpSwxH8YEuPKxJaoG44Ll0IeQUVhLti+AgnQLfZ7h+HtyXAlvGRc9Qsz5AyXuwfKLydlSqkDNd80QUlt9hTeQotJi621sVZVk8UWuDlu6czJhqy1QW5jAoaTkJt02p1Ggbu8R3J3a+J94LdTw4TnTiSSE6+2aO0mIhdiU1ToJi1EIHkPir9igBqA4a4HRn6AMGWim8jotPyXoDBtu+AzUbOyqt+gWXDHUozGRTYkqp3I+Xqb7pBTcfz8oL8D9XcrijcJ4lusj0Wxvi7uty3+BKdT2YjX4IToRVygxBqLIJo97qpouCEJ10MfMPp16ByukbhlkWHIfKmwi/7pcqW2prZwwuDAr4cfqWwYrTJHiQWZJJp9QjrtGpoP81oruLZ2fL3ubNh0iYIEjWNobsVOHAxjhn1C42zjr/gS531e3LYM3APkjbwQeg6fHe0QXB2qquV/OhH7z9wgM3/k5+uwBS5xRmijmNZy1xLHSzWdLQCAMduJ3FPD21yul99+YtbMkAPVOS3tClq8wHNPD4NTc0ev6xNK7eySKoOGVoVp4rsSFc/C3vKMM1Rl06hvLE5Jl7v45NsX8uMcS4Jy7lxQep59Lp0sXJ5yIhgoW546cR5BclmN+1ijLUgcaTIvM4ycrcQtUvVrWcfxqw9TLflA/n5yFk4+KgTsFvgyiTPSjzcOtdKEIRWszG8a3jsHTGi0pCWSE2enHK4CsFIzq1rUCDTUoyrIojSa9k2UgWZNoTZSyp8UkaiqEwicToYx4B6y7U96l5b0f3rw3Om7iqMx+fArQKoabObOBeAPBElY+afIrdDSl2d5XjOrYscI6KyBSotzLjUaz3u3vI9icFZkNI6yDPOrqyGbQcuwjmEEnqQdtHZ1Inu106rghV3IXNx1w5SZIRkiudux9czm+d58VdS1FgXEzo7fVrVVK/vpjfkseL9c1Qu5ozaQz5r+WAvHac1LOVH9YWFlW2J+usJy5nKF4q9LFXJFVFFJ7zw8UGATMf4lZMkP+DQk4LzFjZ34TzJ2ksj5k7z0aTlNp47skZd3uW9Srw58PXlNbhvaQSe/vwIkTltX5kArWfGls3L52QilayLoyLacDDHrwZJ6F8D4sx+AuIxPDPl1T97HZLvVfcMmFtbaDSNBJSNn1PmVd7VFB5zan+hPN7Oi/QJs2/HFZ/HCGsRhMkWJ5urDNZ/aeFuO1aoWYaZjgrC/LHlpESwp7u77Mv7sNHyhMmw9tPCgU/SARfpHsNU36Jc//I/1xTUMTDiqn07mnmlHI87Z6micG0vlG3C0iHP1QqkywlOllK5b+CuMhuuQJwXv+zAVvh79zQ/PuPl8v7+OnrL3yWO1rQsNXqMWa3V92PFqNIWZ80tmQyBWYRxz6bompmBEdYL3hbtr6/zmzeW8Jlu5CzgfXPcHSHofTuOcTUv6SCuod81cRgl8HoHhmdadRAmK6Km2Zr/+pdD81Gx5HI52ZRR9UYmhzh+7hMmYPQ+Kr9q+D/WVrIaRrKuG+bmrdLzpkBR7XKpL31LgezndizbKxovhi/6BzwE8hG6NM3qb/Cbt+h9Wh8MUHE0I7vmlR9uz4QOxmtw9ZY25nNyf/l3BRFjZZxU62ywUxYBXK7dxXGT5jOtjeSJSWedMrRbVbTduH53Bz7WFJw7QWc0lrKulojKG+jZ5co0xYQEtoFOnDbHwvwuFAKRRYUgvYlkHtCtVypLBxUtvDth81jdeJcSFzUpnNKiaecocM6UENL95PuiM1zqFEfqSvQ4y/KCkkQU1ZTY6tH/IT4LCFu1DraD+2QfVA4jNPHqClC07FGXSXB5hP3c8B7XWmr/rgcn+UzfksNlEavgWMVtlkKKAOxvbzz5X6auDDBELZxBkBTBnrmxHJ4yBYg0Qkb5VrXVuDXgGCJ1mtxkYX6yy6L/WGUC+FrQWHjFj3F5HdW7dlogHJskYj72GfThhmx6Ym7TlGzikbtgfb8bmq++zylMKcwBu/sMoFthD4MtnOEFJjnRsPBIWGFYgvrWi4UKAPip92Bx1ckLGj136pPUtl2SfywLqdF2KK8neh9pKKiwXLg2iJrW8LCJmcUmBKvNlKrgmpal+VuMVYi9TcjvE+mhckgxGyF6AhofFAla6/ZJq5X7vTqS21BsRNvt/rCLZlURUMnfr34jyHhchscHvSaRYnCZHIW/KSOzLZPmSDDR/7VHpy1etk03TXQ1ZzfaSJrIvOiCX+csSNcuS6tDPY7DTZnqfusrVqNIL/XXK0vvbwspCBvMI6pDN0E+rwgn+5Akx2bfKkJp6WIkURhaw2Ip8NQpK+Bl1Qt/Z+irf25qyMXsxifkgcPrsP7PmZXwaIdvPVPuPwksRAmHn1xnlsOzqErad9xq0pAvHzC9yzIwsixv9zYpqu9qBx7O5BiYBf9VLT5JiONmkLPIypfkpLHRciT9xMArRx6n890DYWICL6sA9ln+KjaQbLtRObA6/Cmu6y/W96LEQmGA5CgEWp15/i+AHJpsExiXqmao8HkAQghBpOBMfOgTSnCY/uTYa5ehvYWQfzyL+zRdhO9s4TYq6J8OEvCPOjBnbLbmAS2nEvUZBqgw36LigAHXXqnOA1CVpLXlbrqEIeAqFb1rWPBQ9AJUghavz/oQkDt6l3qemAX3kzNYJzMG72iK69JrqF0FEKvu954E/ZCFrgzTZ1zQK4CS06O1mEV7t/WrbBjaP4Uiz9WiQxpWVv1rP9AgSxT5CKosII/ujr4FCelIy02S+/6DR2kqNAcVEuekybGBOxqZitDGRkSuxkzsxdMRE2Fuj6Agee04rQb4rxmgNeR7cu5QwIeIN98aG2d0NWu6SzAsZttsHsJ8guu8Zv5umvSTU0OjPFPnI9T4ini7ILsp2kaBXIOAL5qL3nx6KwjNGtzjjv9TzFOCbjnCCt1GDT9djIozNT2QjT3UHOyGx2wuClss4aqatINVykG6QJx3h5gpKTtHLcV2QBxqaVn+Y9IqRZ5KJ6GXlVUkIQmosBXJEaEUJBU1AZlcRIftuRBSH3KsmE54Cl43pRjhGJucGIhMkmxxPaCjTeQXRW+yP7NY4zOZ+Ckquy2JyIyLZMA9rlrYdRfQj7zVRw16BFVNFHChpQN0H7lAVS7TLWSSFSni3iJltoJDYgItciqsVFvKDyrrBqmewlIVJ9Fig3AxuxEfXvlON2t3QUXLcox+uoiqpquqCCcCoMyYHHjWpRHD51KFWdx6n+j/iWgnyOb74QkpKW62Jyc1D905TjmQQvf21uEkT/drHy3PmRH0+HrUWH26X32Io21deB4w4WQ3S7/h5II5TXVdMOj4MDyQQBMGmmpW1/oXzO+1/lLVBv7ptLIlSX0i5WrMfqlF2MyfTooFG6RoKPzz6CGzC3eUN5Sclr5ssdxkkUOXVDzlQYkpyIV719f+Rvk0hbey99oJwU5cFlti8/cvgbD0kbRH5/AlLCAzbTILSagPy/ifDgjHwJ9Eyal3jV0p9Rpvp7etqAuaEn1vJ620h4FQGZyQCJYtW3dQcdx2oWASIKC2jwqx2z6IIza/Geroq5K+5KFYB/3Oxo8zESroNtfNExangxozarzU/l5StDGqwlnqlW4igQuC3TfsHFK81y2NszPTMoeNyqC13BTvq7vXjf2rulC1OGYrip3eyj7T3qEuP1VxunDXyayqfH/9pbnTyt4Qf9oktXo5P/6Vr2EDzSt6N3ok8yu/yPgBOhqU9kkuVjrYs+JTAXbcB+F9dYc0iA1mz/7Q1pv8vQ9ZaFf09QH+KNkJDSpVFIC/NUyzjAiElHMUtq9llCJYCiZJ91y5kJjNyo8+hCTYFSAoZeIu34hpLOKmEkO1PTn5mvGi758S2cFy/qKyd9blrK+yevf4+VjSmQ9v4lBWcIbGa7rFpP5Q7RSZQ06amaH7Bjbpu4wxMOPAiiMeHU7S7nRNhC7oKXcPOiqFt2IbR3StB5EXZGzKffkRavjew9k5gfumRaul7hW1FcJrsvI8WwRkmKmzUiUqG36dSwPdl/IFHUgzWLEnfWqAZiD83JHlmR7lbfDTYHkc4mdQ4jW9ipF87ZdMphDz9cU+YHoIwNWZJsaMosumXVf3+vr1CVkUF3y2HtF9llAxY3AHoOI9eBKLItqxG2TIEhE/krepgFA9zUM80Cubz7Ajh3uPCl0z1HhtdTCNch6P/aoEyCm9sOzl6oTM6653Zn80qeqXLJUAlUC9zXzgANG5l3jNz+rDvOlzNvcWO33pyJazhgpSPwr0rUsCQsBf3EfRzul+G9jimFfHYF6LojGKXsre5dCnWEdlWTG341aUMD1qjNVBDSEwXMil5q4IFPDVw47rpRzyRhL6mPpknToE19H5DlUoWKR2DRAWDWfhFAYtq9tbjF9s2pQ9AdCB5VNGUID0BVkvkNIAmC6hKVW+kmN6hS3c0KxhJrN21csnAte7UPUVH1JupH8ro83BfD8hCIWuhuSHfqZdlaS61gholq5JgE8bUuvsAfXl71v0K8AJ3329PVxyhJD4CZicp7e+WVnIatnovX8EDD3qJmeEnBGMHFnxdIrbfjC50qzIXAJGsw3f8rkI9p6Hr1muZTVXwWaCMSD5USCIkqbADDg3lpPjwfgA9uMRzsGifw9QqxDQuzgrtY0tVSVy1F+Fcte2bUOGHSEKt1xUWp99x2/6zay1qsVpeMigHN1jGdeM3bEzM6jd4wPv1FOsgKgAWDY5fHtoIC9Pi35utlsSN6d38BOHC/AlCGC0frhhTX9EXZapaozb8rd2UuWJdXVC4K41M9VseGqTsd8aW5nPDfdnOyVNTGv4OcNsdBjms8olE1Q3LemeDrka7hONwOlS9iflJ89CaA6mNwZn/q64oGDjq7TqMMAvmFOwAMDHYGhysq0pHZl2+zgcqTF4Y7/8cF3jz5wQuUFyhBduolJ0yAFJyR8LAKxmvEdhuBmcvRqVshRSG+qyDdo7TvhMyRW5NtnOQpNmNO3VmAs6vcsZ3oE13yLkS/sxb+5YPo92mR56y5EbHCfpsPNwBdKtpMfq7rPxLFHfXqfy9um8ORCXUnJxzPtQtz7OY0eXgzO+6MxQcSSnkhgRlvIhfWpuquaC38lci1q3+5BLjTF/f+vyIDhYUJE8f2v/ICeb5SZqc3kVJvwtrg0qe8hM+J8tib6Cyf5b18welN/UbpnQV/YOf/Ep6Q6HFkoLd3uHoSLQt1/8+dPQDYTFi/6dnMT7vCjzoeyh76dPaJ0f7DkU6Brs5OAusBXbgHl+eGX53+yWLEPyCfPPkcTEbE59hk9HyuBw85L/c5n01qDxYv+wzMPT7rbFCbWRcB+Ukox9ONh539Jh2WCEIkInu5XfLn6e411YB/i/eaNYbRnRZVL7jE1Jk//XamlnflJS9k1lyprrN4/3BK/hFkJJziht3eN5Yn2JRfu2N6vt46eQK3zfxZadaWy0V68+HTgHAAEpsPSUvOWZPtg9aLCrvj8TQ7OCKdpcQAv3O4iOeg3KdDBwlLw4ODtqXQICeKskO59iMsn9PcU1AQqKRDpPS9QHyIMHHQWNIv7h4nyNyeQ7K5bZ1F5SrYs3kAsKx4cViISNySNakf4t1bfHyBDzI6WwrAC7CHIvR5nF4R9pQqXO+8XjTZE+qEOaAX6G11q0Yzw9zj/watahI7iaC3LOjp3TiAs2/OILQeXkish6d0BJy2cJhLRHEC3U5Z/HZGkA3NbW7V9NngeaBdMpWIe2eMicHfDBzMaA/0fdhK8Dnaa9EM4eL7jHCRyT3iFxQpkdyfzkREQhCks4ddGMDh51lfNXlwKcYhOe6zk5h9+Q+YQNiHHHrxKInmF5ywMeGsRtqX1olgfvYb79oThHs9C8jd5VsQ58EelI9t3qzNap3xNoewxdGnxw67y2Efs8MYMdQInXvmeeA8+HD2ozLh/eQe6Wq6mqs5L6AeG6+blvswah3KncYt/jMBvuJMfWU5uOuyaN8Imy9tUNPtf8+9S2vMe4S/dJwUoD1GE+jhxdbZ96bhbogAS/Rspr8Udb0DldaIBpT/kOdp4uGebx8aUuebsiNc52B6Nu1lgmv+NrscB2OkCOmJhqY+70EqCFHk4o0YC1Hmk11xfz8JDjsc0+yE6PP50F59nLBDWmOW/6o5RTuKCYVI/94o4/tJOoMaYWMemF7A917If5872lILgRMZH1uf5mhrDxbqqRVp4GOOV0h87ODSLiXKASQr7A4zPO8s/e+wAXWSVm1A/hRcYMcAiSXvA97t2RbCRM//0WFAJPYePi+bqJv/72MIW3od0DZYvnZPeIbkGA/X4X0uLRYcwenIaExpRgA6d5o1+ggMv+6hGmI83BGQwgfMIcee6+TWgXfbFX2S0NtI/LeoYSXwGN5bVnZmZtS/Xad/WkE4/wGr418LwFQD4QWc8P9McqHH9zmHl0adre5O15bBOG0K7C/XfLmTeDFQpwfcsCDM4WjWmTwSUNHrU+4OEANRMMAhQZaBEoKrHbq8vxIxNqL8K4RFl4u/lzhFiuP9f+VKpVtdjLwv0VXj8hnou9Kf9F6n9m+dbToZhKvjKuqlxdIKzwdscDnl5E5QesH2QbFUUFd4bAOlGN4A+uL+h32eTETo4V9bit8VColk/etebLg6pRk84LPdYCsAIZAs6PsX0wAuz/i4QpgFWn1eFLencFNNn40ePGg9gXdFAHkQfLHrB7ydge1rfimz3fLdgefzZJq4ExqbMOFM2fEBDF5N/AWhWbEsMTq9r+7xo9b9/8q7lBehB+lVt7Lqm2T2gXXLouRDi7vj7FZJ0t1Jrel7S8Eet66LRF/gvISeCkMhdLGpgQyeAsorclNQKm0vHpV1GoYLgZCu9lKEllJvgr5S1vlOV0CHjLbZhooRV1mjMj//xVgr7wtR7CcRBIztwZxuSUcH4Z/Z6f2LZmjwPL3lp3y4njSxgIE5gxolYkwPATyOSmsqgWo2fWiltN8FTeB+acNeRxz2zOVN6c92MGflLZc8OrFNPOuaN34KrAdxN3Y4U6ioUqcSEt2arWQyVe092sA089/0+fKjBk+36JrdRMCcYwuu5rkL17gOynT+sCSq+5YbWg6F3Ax7JMEHGQaPZ8ote3k1bZ+S9YpNZDGucnSTenqe1dKxR/fSq+Fcf3BD+uDmoRprDJyTsBxCTuSsSBdEXmYmv1p4rn7b0gK0GnCD+uCvRXrKrtrvOrvjoLBHBl5CYNq+GUz0JaxScHF1kxBST15jecGnX1m6ccgcsD43FzmFyQQGwIE0FcMlO1PEQr5goIfp/zUrIaGZbD6E8n0IzQuzzB2CpyVmdzFi1rVXWg0/3h3Sf8m3KPLaETTW+jkZwqsg0aFKJntNkn7FeVLbay/COLa+HnatvyqZmkgNSFesHkvwIT946G82bTwiyLOVJr5k9Vs3oWJyK4gSPL8h+7/fw9cb2cE5gtmBf63JzPKIDxAh4AtPdBrLz7m1s+fTJ7fBDDWc8pLP7cOIiUBlsLjg9Q50wFHIQEdXAluaniuIXm08ZYViiMwwTID0c64CMj4jnJNACnl6HUkKwgu/1JKw9kHRZBR0KHWtpGNowjxzNU8+ouU1y/kQvv/Em20MXhjDk9sQNxWlVTod79WKLJLJGBl9t5Zb+yUjbCfBZiPfCZysXatKhL3oJBuiE67t8ttNAu/HMX3opEv9kp0h4q6cBZ2ROjLD1Tl/JrqVP3VYZuAl19ybSVlIAcqAw2Qj7IbU57vYiwRiGiSkaUQkeycPDblN8f6HWo5YyD/5MTcWNu6RTnoau/6zfnY9OX1yG5ShupOCsq/m7uI1JbAysiG3vl1VmLNRcj1nCS743astixfPdNK0cNdMjD+5GpkCEw4HpA9BH/NLGkFKTcYfpS98Tc1mdWDSPksQ+UIMm76HKPsA38Ii7jko/dI1uFNg/jj4FqB3uzs4KPUBa+EAX6e7hIfgjZzwMw83TAxqgZLkuGyntKz4cs/0hV4ih1/ba1Vi6DKwyEAgR8IwjBDIzZJ0fQBCGtJhCPB9C5HRhn9wlnYafOjmsUwAUQsi5E3GnwC11N8ENqAXZ83iO0SHU3zq8eFyeschkEIkH7Mex3cnEzNCFUansmWNozb+cNp5LtsEP7Esg9bW9n3/Fmnqhr9v81WOlus09TOzJLPy9deLIiyGgVIUvatU1KK0DZUDEspablKU+88ACee6jW1yNWEb1G4kTcK3ghkpE5oi/y5s6i0KhWt0ZXUVgOzrwQvERKMkHjuXHuqEp9ikfUZ31OVl/xZSXW5dgOn+845Wd0Byrd5Af+bFAlJL2P+9LuVtoHWBIO8zXyNc6dhxfdZv4DSuwzk4Crvjv6lO7dI6qgjYEF9Pj7BMQgru78SI9P3zIUAaYqPGzB8xwT37HpMhxrxL8aPjORs2ldD+dHzUU7keHW+Frf15sPdMz2ykU4H8ZjRQH5jA5fv4reF1iwfUr2O4l7IcAnZXDdB2f6i7KExnFLh2WSjtNE+aqlxgdMB9d+BhDfx2/ucUptMygOdOyXSUneF/zl2NJBZlkBuvEYMhGue9IbOzS+w68GEael2cTRFYH5lC70Rw9Mt2Y3+5C9qr596rwwTlnNgEvouSa9WQpEeDqsyx2Ol7f4pCPiWFBXRftJG7kl+cJRgK0pQZ/iBAInATiKICiUoBv6Oc28LPvhb0ZQI8VRjOid17ARSYCDo7dznafLzg0rWkxDcOXHPZCODsg3Zyt3sEc0lyzGilqKG3O8GWa+GkVZIw5dqj4W7Jzdp0CSHJtSHVMWuQZlQBccl97wdKJF/r/oJ0XagixyyB7TL0iWNJwbvPfAKj3FJ8Q/kZh40GaYiODXHmVE+OqL7rXzWLEyvnZ3vgz9MqMEUmnhYr1pM4sM9VHnECs2zNpZTvLdcafqx+TWlbY21b5tmuTsQmOaUOw9GvYXqSUBuWXZROtErZrRpEnVqzN8NSRaHhN4lpYhmL6P5KWhlIz1qUt3aJeij/FTEPlC/NV497P8bGqE7pL0eEYA9qgHam4pPN63dDAf83/OqhsC3cGDVk5M2WftMb16Qw/3+uT9fgATvu8xcII0OY0i/1m+DH7KLQ9faVaBh19gNEbczAaDaT2Z3bpSU2Z2x6VK6MiBaBFXIMWHYTSJ2cKFRqwdrZIbRnwSfC1o17uLZvhhodGuK/mZ5iGl7DWk4qG7GSxtxkC5y3IUf3zn/YzNwvCm0MflUxlNUvi1b0ca7tqalmLrYkt7Lz/qhEePmQmtDxAbcZ5dKqwoEMT4YH+888vD3v0GLP/9dY9w0aeToS/UmxIucEE6mE75FreVt+iMfYMqDY+aAT3d2GV1KqfazYJauukOfk6xfIBvB3bxW3DKPdgxI8VndtSEMTDzADllkZ1chL2irMBMcLLVtqHMMahuzuORFxGV3uopxj/yjWamYXEEtK4EK1QHvrXGsQSAKTXSRbh7B1o3j2+9JUdS6Tcar4XwLb7xhdMJzsQ5VFyaZtbY/iO4MZ9PZ02oyxSITIVU/qlXyEwwQradEtkSWdDIrPxXE7yYoQfzLS2T32jRVlGYIaVFuL3DJAG4hnEYnLaIszchwPsrbLluPpd8aj02MJjIVrk9KM8NHux3g7A44SB0kVhdK3FDuKZ3okGty8T8koXQ7JiNE5z9L9xm1QxoTrHqp42KHM7X65Lg0vdZWI7h2pLu8GuZdHuzGBlTgkbpVuTGqeA91wd6EU17Y3bwOZRGlMuIuHv9Be2m2H4IZz00oRqqtctNAsn9+bjN63qH8Wugz1e9DPrzkRFpZzbGUOGFIO6focaFJ6RcSHuL+Y3JJ9JL0gRshDliKg/b1o5IV9HmCzrJc82/Ic6tj7GxPbPspJwbPSJIXKxWR8XV9bkDoyn37MX4ooeoHxYCp4lzxYwuEESUvXtF5SiavdZ5t4POo0aBkvfrmHsBg/hUDQyz8fvF95wm8exmitQZt4aDL9aRXdyzTglCXcYSanvnUDOcdvEK8Xfrg4zx5P4AkoRaGqQdWZwP6LW13N3a8cJyeLMkS/EyfpjdisXSj3TVezWTFrlWp6s5Ox5soJ2dBtjt+4THwAd6CFPRxsruOze+YFeed9eJ+nhd/EmmLYPP+j/U6/5zLLGuKaDs3B/6VuPu9n39IKYfvkNqrffSiZ89vhdD6/+LghFotOf4liW7voU05HM2OnoMp0ifLj/I+/HL0Sm++DY6y1nD/iwW+hCMhtKT2ItphZzeNK7ADWugaw2ZaRlrSEM6yyB+GWHGEEq+G36JFv3yLmkqmZ4xa9UsOXes1hjsLJhG0wJyc6WW3FtTTFx4mq3AsTZ+5GXK9Mj2f/N7UqPOOMBX8Z69VTgIIFRKrO01TTy070fFtTLqQ1hyva5AxbHBEtMRT9+fjbyt8z1+cVLmJMwV6DQsYQhL2eWb0Hpj+JfrzwD3KSvTIsr8RGP1zMsbNRV/l+bs7eZMNpk3HtO7RSGtKOExZGlmSmhd3xmDWYsfBj4iOqCy0cMzfT7gPNKf7FAXML0IXM4Mog4JQn14AzTFDtxHIVbTKWB+nMwHbRValcFG9UMaXPWgq7fnYyQee7FKbPaIzf9JYTS+67mPpPF+tjHKtoCl7QnjAbFy85hUsE8asqRzH3+7PqwwLShAmqdBBrhN3man00Skc0O0BQtFTS3ZfIUUK26BQERY+WtDwYeSqbouCI1Ql/HLuZJoEfxcmdC5MphSM6nBbt4CGw8NWzabZrw9k6hAXV733Okwsein8sMLGCdYrZ49N9/og/Nq2bOZd8YUcoMavDXQJL6zyC1g2vnShw7FFe7M7YFz1tyN+wh7jGdNAihojLLMaRQ5HRiT3gD65Y567xXM6QXekfkQdfiq9IMocRt1Xzi0tdtEjvFdhfoZhqx5bXpb17VNUcZT6nKjWxphHXPPq8Ov6P84RW3CA1vCbesFepDHtmKWj/nl83xz9+iyqI997Tb7XWJma8ujRGyjjv6CGMgGa0IfIXqUY9RDjJhLWSg2V0UntKTCVZQ+YQ1pkCiKrq2SUFVMbaovFHlk8b80Q4oRNlSmfF4JlcOjvACjk6oa4Bp/cpArVihvJqwVeXlJ4wFspgWMo93o0qWZBIzR4IOeRdjERCYztnDZoj26or0XBF3pbPTFPKWWJ180C2CWduB+vtWM9Eg6CrNbEyyxQhiWPDgECW6gEtkAQeXiVIwUqIyFahQQwwibi4OwmLJVgpY8zNGTPTU0HM4BAomiD/i0ja+wtYQvaL7ERp6r/cLkLpStUa4nf7trY1rl7Ce+IwCX+KaHtPYP3kfbpCbjUV1qbmA4i2rdsdck43ARlTFXZfMGLWz87i2tVw3xOMIPG2kUJsSP8YV+sh4el7k18J+dCVASAe8Qgja/gCj2N/Ph5//IGQiCaiSe/KkJTOhhZsJN4rYT/Ohz+yLZBDnXyKCtX50vcAFh4QkBy+dEDUofFsZZFyp6hHSYh5kKnHLyuuafazAcxPFvTTjL7IgPoG1T1rVaquHyW8WfoEtO/E008qZ2UpHboKHdIOSV5OUgcA7i70oy14q0yiElRmFmWgctz3JpslXKddGfCBqPAUjlV9wm2vqfbz/nLvzKvjr5OrqK8YAvpEHJC+V19BT+699fRcw8MRmjWwQqNcZv9dYN5p8vvxlG/4LrTi4yB7mlntU4K4hu9EuCmdRdGOUWS3Vm0Bi+fz3MOVi4dZmYUZ72proB8eLm84n89A/HDf+5M6Os4DdRAIQYeofAoItxhI3FLyF9/Hb34CMUX+Pw6h7EylOq06CVTYK1OIEJ038NtdGLw/QMvvuQB0f5BSnd6eDwuulWbCkWwqRlIpc72Wkfq+r5ueraUkeoofdoWy/frSDyhH9iuh25c45WJgAR5bnkoSOrMZVHjDCQDWgV6uE1lM05aE6mr18d1NSXbhY7uSIV01fvBmiu5v4b8rwiOtQ8ZibqFMXfD6nI1p8N7JeSauZ3iWeEzY4V6Qs9VT8a9sTAjXm2mu7Hkv/+cH1ltWPUNzrNM3w9wHSWDu9R6+9NyyYG1pjJMFX5cxLKi/CzCRm9bfOUxspmkEon+tGH+tv4+BsW+EssU3ifva3fYua/ZHms5mt1SNWxxVFzhNANJpx/vfUtbI3KwbID5Z/z196EEtwwdl3cdqfMC1NHju0aEbNLD7BffRC6gP7rdxPXfRB7mkOmmonoGduIxGW1Xpx5vpTNRM9qP1NmLlASqgzmfngliCjAiizqWgXPNS4EvmorHKBJA0+g8yQ2w9DkUFXt5ZzzNajIdlZhm11S+Z34MH04Ig71S7j0vQjKwFM/j+3u/E47nsHir+V5vhwfvJajY5inr/fVW6fP/RD1313vLJ6I7uhL13oU0UnoUO9D77Vvm/dqn/rLK/r6R6r8EnE6Q9v6eJ3tew1c9IHYGCtfdmPqfX+rdpM2173/A6OBVY9oPO5X131U/6V2Um74OLfpv7gSSJvyzl8jYAK149mIYdKZmsPYCtiSn1a+c/+VvUP5mFZCVxpOeBUL6rOonvrq63AExJKWFwi2jFxTO+ihqmOroxcGc4gwqmSAZRhbwf1aWruKgAhEFUoFBuyqakF8GQgF8KBoNaPiRTeP7J8n9Ko5BVzdhpPa0LJmUbuPoQaImDHoGljdY8VI0eeJ1tpEP/+wB5siPU0AzECpdvNRG25vfWoXvobkwDGrqeEjCsE8bnkxZpN1dl2gJ6YEAzYVkmtVhZJMORY0quOZ/CrCRbZm0VocVURxCPGQ/zVjxFNLKKgqjr5bmrGHcBqaWrZv32mN2Y+S31UANGjNEMq98WxQ7XiVsT25L0Z2tcLCcJ2W4Oel6nqIfasOoGXDNba6auSnvNa+o/KyRLAgAv3YFBLMANzX56zSaH8NnWp3tqL0Uq0m5v37IoWaUW+nzxtPZYins4pQkeVpDZzlNfLL1v1PKnbsctjCyZBQvBtP/BpZUF6RvwCekXF6lwpx1McnLafarvKOrW4Qx17WmgLjyjOZkhTZUQRfV8peBUm9apjCVEqpG+YhpovSoF1VCQHlgeX03WUoKivxAvTM15n3d4VDNanJnn/pIyBD0gmNG/gtG1i4HNGY+1vT3D/DavjFqxL5lMo60129G/l60Nc+jTeRiZgpkJgfTbojMlewtzu12tEraTmCXNzWihl+ELzeTl6nLqned0owv7nrijY1OLYz0QZvbJF7q74RbL9iKeXo7/10/2foWoOSxkrDxA65E6wfMnSAu9w0AzoYesTT2mCYdUQ9szPAohud9jJMnGyNb6IW94ghnqvJZDSM/3EWl8DBvQ1FtZyu3pPd1F6xBSnkTONkXDIE0b6y4wfxuB/pEC3FQIbeAjNwrOJXp7H+Yl2HGG7erz5/7rmed0C7cgvGkmxEFZzw1ZBbABBD1Cf9dAR8OdoNh++j3XRXEJOwY2lLVJBtdRFEk1J/hpm3Re7ZdTbSMgo38V6AWTnQCBtfZ0ADaWwENdQVO66y5A+p8LTtFDEOVP4NjtbfCiKiGPSoY3Iu5rRTOlPoKoEL50Nx5vYsjYkqO2iCbtKU3nZ6M4T6B36qN53/zOzCTanBofCjJauHFWVo7R7mo+6opM5MVI9HoxMdDpPGvbvG0YJWxfhdsSFKcbhvIWBS+B09+BeECAhk1wWG7XbQ6FvU23PcoHw8so3RxDY2BMi2SDgYIQKul8iSvkXPSIUgs44tD8R24abgn36MyXyyWfPqSjStE9qsFbRDNoyR93XVSeU2IEdW6u6ba6OSlTS3AEDuhRTPrGjrgM8b+ui2NdEJO/60ra5eE+wGlkUTQZYOct7sO0ctzs2oyIygTf1d2TZ1cZun+zzZ3RbkdFI4Z/xjoiuCQUpUkG444Bm2N5r+8/6X8y/UtKjvVYBSeLMIhtCTieL/T7kDkONTavgLC/epullOf8NGLPwydaPTOjgvBydv5JzBDxywuUnuPfCWSfWAlN1S/T+/fgyGNQ7c8PFk6/DjyP1wwdtTWBvmgOW3pgWqgN78S49A+alUQkYfOhf+MicXmL/FRESvTFffdrmH71i3yIXzsMq3aUkS87HKgP3UHFla9ZtNPrrUR/9LUExMz1cI842YME9uJDBWTdvo8bRP59RobszCDlASAJZ/yAO3H0DlPoqUOyF8wQvKWrTWaoNZq1bon035rR82gR1FKJLM5Sbn/BapY6qTsNlwyRuftu7O/kgV5kR2B76nDiw2ZVYDGCTiFOugLpIbquyGYWWRZJplvAxBRXyu2rPEuPyDu9GrPAlecpySb5mVlkarLTZMxcBMWvJFfN3QqjM46Sd0Cbe4V1jv9NFsMkuARNLr0vFisbuFFMlgIa1V35FaWKK2Tzg5wkOA+DgxkmN/uYZFGbLMCWupaPuc/ptfFOoUY94sdx2Q/AUnUpPv89EycAz3tw3n+UZ0Ysdg5huijyawF3iPBZxig42SFELUkNX4TWRNYAfvjMvUWlIOtZIJGoAQlpMSKMbc1MIi1BALc33wFEth/XVw+ZdPKC/B0JxCvFhoSronhwvArL8OkJeXIZDB+YPPTLTn+Klxh/kHgVCI1xWmnTLn3FZyZm+SxcrE3Irk63ueAAO0GyAeOCuSTLjQu/Auy4apbUnwQZgN0/xh7TadBZJ5t1hsE4f/kiNsTBViiSKarzlhWVCzapVmA80zGVES6IxQ0uyKiBc7tNrxmIYChvODPcfyzEPY9n8sA2iRJOjdIjO3Q8v4ffpodiggJScMzDkdkC24tCvGFhW8whZVDylhFejrD/pOYiSVD4KGUZ+gBpTQHuh0Z0nw2ndc6n6y6jfdV04V1iBbCOpTL9WfHiuJj3rubGhxfBqCJ34etqivZIPwi8UOvvSoZdHHQt0fs826JmGtIieyzDrZxtfwfym20TCfbjMo+n+nGBw4wqwBjy6Bl/D/gQYmZT8kwa1IBeHxfNEhdOq//XAqHDyzdORCOVRSBT6brwukD6HlTPLCXTRNjYknU7xb9Gq/jwPCHQmB/Dzsi86xB0OMx3X+0pNkVDez2px3XJXJE7fx96Fu08R9/nNPhIqUguu33akUBxfzd/uBz4m7uJf6X9hhcWnno78Y+CCmNxSjwDkWamGjzHt5q1Ui4q7ERF0NjeimTpjCZQW6Xs3JOKO6/r4/sabYg9o/Miu+7Ixz6ArtRNTrOsMu2riXO0t6Ec1MXm0ZCBg9wY1vuaxaF73fIcsbYM3RLonVPLLUTaGlNViz+lNZVstUlDgvaVwyiqsv72CzRfbIsFLe9i1XLvoR7zcEjvusLGx+psFuaCAswBCSiaYQFHF47srjrE5Bmjt3qgnDYQnfJLeoJq7zpDHuyyq8BHfLhR2mHCz9pwx7nsHeaePV9p+87fZMqydFDU2PD5sGsiAY387lyXbv1eEHdaIaP/7sO+Lg+cWO5wzxJN8345iC2l9d8zRSj5qLGMVPGA86eLnTVK8zFay9PwN6b69H6AvKaJZqJfmy4Tzm+L8ybiWrMnqlpbCqck/0Szu/paq0Xa+8WAQ1ee3cVu/xFV3um0Q+Dg1wUEDWZSnSrwNbiAUSYKbc4LhgvlD54xI0QDt3k41j4IZZZmVmS2U3Hb7/JvMU1NaY+yJ4ewvJQ6BUVOZje8hDjlahaGU5lX4YiqN5SutKUWxixA4Tvvs98JlruoCiFz4Tv9JefxcrysRb68q00F1gWcjl5tjyAuaapXO+H+6EkSDAIH2Rxg2zdcqsNW42VvuJWltSKFn9Y1FfuYw+66d5rN64lFT1as5w9qgOqE5njU1mdWex9AsINIq74nLQyHBgFYts8B2ldSVrppUOx/87zrSMhZ8JpYNWhG2SdlKczqQkDGPyZaRPUK3IKPjH++mnDR/3hpZul4ONOEfoIHvf3MQ8OpAEk+Bi7DAsABEpLGZ/6BEfnbjuN+2/PUyqugJSU83pRrx2g0fxIJX8XHdFUkxLfVLCzewSoN8wq3qz1kISf/Alu6NfqP+TnwwW9NClfu1PYPsF1WAJKx1y3mwjmeZyPmuovJe+bDyIDXYnso8eHE1is92nd3CL8PTmS9Gb2yWVYiyzO4Of4jQvTHilyaF76df3A4wiw5Hfh3PhYtPvgad7orH4gmL0wV0xiLY6678HAtu+w7ItAHb4xjdzeCoR2cCAl/efyR/MnzWdsn9el5h3ROncgjIQ+mMEMgYQYTvhz25gthSgAFB13E1bSmR7ltO6BUQ/zrZm5/UvgCopSzJnLaA6lKMZfo5JvUSQ+XuZsFoVAA9S5URREz17eyuqF1hhEbY2bh8twsfIccIU8qxQ8seQytfnrFTYBJhT3WlOJ6Db9Qg8m41agIwfCQfhKXJiEmAWn7PKXut/0NvnnuhO87HMZuUgaT/4ytNAHrVTB0xcZnpWRfc0dq12UG8/pe/KPwjaUkyeYccgTfzWTB7TUs8rXc0Gbxzwnoqhb55mqdwS3gc53jfiKMRN/ZLo48/+R3IGJVv3ghrY9h4+qM+w6JInKMlQ8pCRZ5dOGEDdhuUEr2lSU2rvpdXggKjseZRrCAdOdzh1vNyZnO1pB+31kW1WiE5hs1htEfEPMDAnQzRtvlbu459Vnf3yxQ9jUAGJtYPT+8kE4SZqL3kK9nmmkYbEXmylDTQiuhlS1teSv1bPGZE21enur9DPmhtRbCpLsZtKDdpM1CvClheo5NNOizjaXx+jDudDex3kxi4fnEi803Ba9stoVL0uDej7w83GK1Iwl6JCIOf5Vgxh2HGFt3pyroyPqX/Hlmxjepruu2w4oqT/8x663njkx3SpSSRFRoEOn3KqLWvsulRKAhZVApCxKAry+bn4EzGYl4Yah6WYIm1IFK7+VrKvydRhoLKPjGEvMQDBmdigEH+hxm+oPNtecAMohHfySZqAYMmIknk0bPkdquIdXeMksTYHQQjY1u27VDrYQJ6OclqsrrBTG9sjwYCNQ+kiFz7S/N9UXWizGrlprtU6l01CIPcaXWfJGzKsY0YIVYhjwckGauJ3pM6Ravg6RwBqmPa21KmurnGl+xTuDNvvXkzcCjvf1AVqfQy+wL6c2mRqkrMQTlnnClV8LHlst2jPCzMGerxKIWTXIRBB76OUSETgzsalIsUUXBHHeT6EdTgoIjM+MfBxptQsl0bZ5aBmiRV65Krsp8hBsDcVePTyaFpppW+0pcLjTblJFhGcrRYyod818wIjf79FrlsBwanxrE+VCPSsbeU0hx7VkY6RykqGZJ8d109kNYDXn90JrbZtE83xZTkO1Nu21CRHok2kxno6CM0xJzrlT1zkiKr3RzegXl+lkXrgw4bZCZ59s6t2T/kLeMSWGoMXGVOwNKK8CQUZycjU1FQ31Dg3yzNUQmX9sr4k47Medzfg0PdqAmn9ImB7YurdimUsHcG9ukCip18lRhSLlVrI7oeMtRNAHhEGlmRHF3MxchhqcGv01g9fg2wyeuuOIvQDw00DqEmNIUKCUrGUrXvng3DPRuGB97LaMw72kjYi4xhY8LX8M200tjgEVwWVpnhKT0HmZHUnxkFfNY1WsFFodewiow1GO9ZtISyEozpRZfL5AlOUT9zPmcOotklftMlBXiNLkp/xNqvoO6pmsTgkcicL+U26NrJMD4NahWdQEUu42UZ0fcEwHDmm+ZXqjhxh+Ucragq8cH7KWYDO5dYQ3pGSq5hS9pgH+rh4AaVinGrImKVLqK6DqXgVfPWQYzL6zOpjhx4po5gRC0nupRG/CExkpYy5zPObJwnWBo7g0Hc9DsHfcXB9ypLTFBqHDgsqkbYk7qNgz0IJIKZ+eHGOyJsVyAOJg2ebnUafbv/TqoH37qVO7/E/uif1h8dinXxj+298fG/qj0iOa4cdfm2XF9fPCrf3U8ldu0++/XcT9DApV2fCjWtYxiDTVL+xQ5/iGnLbw03odoJwdEQksZPN7u4BZB+l+ti/fGTJY9ZPPrhtyerNsVS515aw7lO12dYvtPIWKLvuSS54K1Ww5VZlrDffhTbaVF3FmCx1fZ2SXLPh7+ai6/+U+b46NtBc9yiOzgl7iqxLy4PhzBHEjDwHu3FdYpgrSPkYwq9JV46Tux0rwmjIMB1wm4SWf1gbCfWu9PYtUkRLsTomgqhrwKcP4HI+F0HefdiGxAmKhIUWxlEPUe/PuYYPYYomVjBT6EWwbvyUKNqCKKgQkEPLzeEopbcI+ziQUzSGqmUyov2DRh09SysrMintOMkZIz+hS8aXiUt2/XDuRvcZmco6xoje666TRD5EZU5Q7uxduFrIybVnlEscrZ/7RGX1JF+3kesgVV4xRL0h/g0HCkZMKyIMuyAkKNUL0opvwQzBWcmo5yQlRnSUJcaT+2rH/XnAX0ZSerOE3HF/avdtZdpXpeMMYcsa6/h9qw2RlN3CQp9cTPBmgA+igB6QRg79106gF2HhFfLAS4QZMFFVSo3SRemMGE2qwhlh6q/1aCZka3sISzH052fJMvFlARAE+pu3OrfdgfXcAVdH4kcqEl7SwgaWXylXi35Sh9r9yuBRCP44i6KoNkn/38+KRzj4HffuSkYwSX/nvc5uvte/0mReik0U5SK8wcfVjBc7fLzZBVLXl0WE9+wnw8X7YvcZEVUaw6FgpLpb3DzwkPiySB140g6nHDhYv66VG7Us/+ZToJP47b4c1roCCeIWjJmk+CpoqAcXf9Cx7ttcWNzbQ2/omur9J3DaOunX2BIKXF9kRmIlmWMXh0TJ+iim46EQGrgIB/IQ8fK55/DmUW7MxsTBlKu4RoC9UJooqdD5vDQk1FYZbTKSoMhfxudELpcvP2LsqnxRJ5Uk9DADIqbcVFEmd5uUlaDDsA46hcqXujU8/6obi4iBfDp0y+UefN6qzRHtV1zJL0zxNvMiJ4JS34+x16040twxC+LOPDl+n0ZXofsUZzTbcfXCUItShcSUyXagSR5ieIyr7k9PgnpweElDFEnpNIpdGbaaqCnSor3y11u1O2oj6GV0yFFdASVGZkx9HyseKMN/R7imy91A6qvJWaFivFWZFKCYhAKShtT/tcoFwmcZSFIPaBC477m6WNloywEtwPBxvr7cJNcMdgCSSuelHIjysKjFTVRypP3K9C2KTW+XPibEPD2y9tuDsGyJntG7x2U0jYP6qPauYwEuzibPJHUErfI+qgy0UspCaZNx/rnoe+9ulCSWUMXDS2JheL2Ai9YxFIHm0SlWhayh/QfjvLlZ0mRaT2V1RDNSinghCNxyzfDhkObce5iJQVhb9mCjFSzVxm5NIVOalvZT/2WYph+21kZP+rCF9tVnlW4TN53q+YyWnorjYLwAMhnuxtBOTRD0VSPFtab8KnADfqOyrrqD/qTMGfHEZhpeOUO50hDih0qclLDrYhaQTAVb7EU3jbqPg30Ow84/gwYeNsAoDgg1P4lKPw3a7dJxtQFfit4YM5qEgN8awCV6deAYGKRJKpwCr4erUnTwAutDfbWRb9r8aqMh3OyRSvp8WNiQjZK0SKJrMV1Iu5fEDsfJkD74gEZ1lIdEi/rsVCjbws7GRoSGaMGHGLpKaniindu0g1Jac7C5vOrclD0a/hq3BQ0o9hOv0v5ky2XEjhM9CfU5/vx/YFCiL2LllcGeTGNhNeOQVOSN1avOMDuwa4ewvtznLQFl4VWCmlqkctz0S0ZHFc0cJPOVQClA+2fFTdaGDpx7BpO2j8eVrYBcxMsgteM1qU+6zqj7P6Wv91AM6YwncJeGL7rTHNJlld/zjNuQ4hg8+SJ2FAKV3eGAgdLiq+FxLtmH+KHuQPeNbT2b6qrtmxy7YmDRsFnnWZyKPvYFAP+8fLuexRqGrFYS0+Ee8wKevOqfXfkx/+zxlf1O9X/dJYySB9na6ItPRgGFW+XQdPZtFISuGTI8tdXIRjuX6P4P4cNNQdoPG6gpqqiYrdLt71nJdRDGljGhUpVybhdxcabC500/zuKBdBfDC2FrXc+7kyePzecpFdkU+SOH1xkWw7CuLUsepiMHV1kX8tVJBDzdZ0bfhceYsHKLZkzrWgprTOFR3CPTyCnv8/14TZr5qjat667GAaqxDOtxrMakqEKrzXvKTHrsxjHXdb83QnpnRTFiyS+hWzXdfJhRTaYyP3wZeSWfMH8sXtbvlPN3rVr96vfLG5m3mxOMxlK16DOHAo3qe010rrGar3vm+28NWa994h6lLsufNvX35tPL+jGXIYWLsdfreE24u9ubni8ELcPvqaxsIGsHBBxyZUGc23KouWh06uoKEfp+rqBLvmgHjKLa7QIMIglR17iX2b5On1F6xdprc3zhX5PpE0msyhcfvnRGulpq5xPOnziJL5KvupN+YYSzFdP4P22NNWEnSUI4Ybr3T9/3EUftviqtN/OwFxfP6iqsV8sqEZTD3puvLsfSWXGFOL4oAjgxU9WnQgFt3eKOYqzZa46Cd1acAYALrYhTBkapqC07FvQU5SN2NGFFDpaevL/fXfSHoON8+14RiW4VHWoIb1NXtXq5RPbQ2+U2UYVWm9LdRpGEwGfb0wd2s3I4Nw0bo0kTAyjSWHcyn15XomYiebuQRl05SoorR2Hk5gsUa8rlKRrLZQthJ5Lmkk/n8//eHwJVaH8FgdjNoGyE+U45WeFd8RMk60EeN7KK5Q9hW/3n2YGp6s7Aet8FZZdlxAGNbdMZgUAM4b7neR75nT+E5V0xKhkw3sCz+hu8d42rjAYrDeTi1x+vbNoqkyLyYcWp8dR8xY4XzWD4J7a/Mr1C2DQOrmvTnzDjiljJbPT579qcNTz+R7N51g7MzZxTzI/uzrs4wmt82JCqvc7cfAmsL+QlQvjbJSH+SalZX783r60gZIX3LHz/M3p0Pr+X/nz/wRZBKjqNHDcAznPsIl/uSHyckONHuQlqlI5aXJTFfX8xflR/EuhPr4oQqkdPIFf9N8v+N0chInsgNHqs9pnFXfVYWSQH+WNr10XLdNmlzCQI3yII4Srlh+oP0JpmC3joA/+oQ4cTsutynzTKeNGda4xXV7sztlcLhhJe0Vp1awF6sRS6xJsVben0Erowqs868nZBfOnjW7hOwh/1MhSeo+BKUzQtFqGmlIm7dIPCZmDTwKurbRZIFjrWbXKSsvfEVJ+yTTLX/8OckN0tz+qioXMYaJtr+ftcZdIPRyoiin3Am5q9LTkZS49Sh8+f+rF0MdxV6IuI8m0PJobp66ZuRTLCeHDIv3LnRyQH6O8r+L52CClZ/AyBw24O0CXLSxzUUsja/2TXpOhE2WUGP4CAljHdLnvBoPAQxKNPHJbY/YZtSkhVdGEFyuySkeYYsagBtlk3cjZpxEyUo0T2kokum5L7yqjj8q/MVDRfmnJSybXjCDVQBiM5vwc+fUqGt+IePi18FXGpxj1bWV6+wxdTsHfOLS+XHP/bsOefMJA4kmuzG912u1c0I37BPkCXOP85g6w1XjTJAO9rwg3k9TzmHortRDixk49pWbi1K44uwb4RutRjnspOUcx3qt3q0lx6/fuwsCsbuL8P2WbWH3Vi1+DNy+pCLHCn0wPvOP5SrTzFDCivPiipT7bp1vzEJlWB+RS+8bts/nbiieybCWcFxFiuCLh/q5+/15pcKB0M5BtbqigBKVsmDTeYddRf8t8I8FOlXEEdObBHj6AgTbsi1IEvGEV+s8NrGUXXa3pX8ykkQWq45nN6AQ6Emt6XMbU+fCeNVbOxmnbe7XqNAodhc0ZF2UwzL5hcsBuJ9SzOWBvvfWJIWZEJ4mSyfY3UPWgJbvsAC06CcVq05CHTHDxl12nJLTKqVQVSfHWnXIw5CBoKhET7gfU4a6CJS1y+rEJbztIg4Z6VUUJDfEeTZBop1QzkgKPFR652tG8g9woPHzKEIVRVYOzFlZie8dlZjCwnsqyRXv8UgFb4srl5wn4Hbw3BQMKWKq1BEZNcDlP0fm7pcHbcwn+0b8dZhmCEHR0dgJFMk9tLOMr9pHRBEsYf5ssgheU6X8KyvSJBLltvutQL5Q6PesOkEM7H9W4/JpR6C9eY8D8uNSLID921os/wE+k/jN3z4ifkmFHv4bqi/ZGnqKC+x3vNFUFU18Lb+lrY0NTeyaB2jnGEQSMhlaE1glVV3WEbWTJ6b2SyDE7X8f21fg76iGGfB3clP2FNgDC/ngOPq1nuDDmvW2K6jbdbbJR7YKguSFqqiEB9XxDgeeBDZdKVY+pX2N6rsWgyhJdMEyiLnph5AE8gvnxvO0nnIhtumnZv1yjjEsTjzphkn8El1I5GCnvqz9P87pYs8fYjn6UoFLJx2rKwJslM4G6iLSQWPQMipWlHiYTR/5xZ+KMtNNYTHYmIj53hXrySpxoiaxE3OopHnubulcD7usBioJDUTcN1LbriJwLBWwQTeGYV+fUhCeYkAKrt04Z64cw2OMSQI4Qhuy8bxI7SZnunjhLudzKEJRJ7pOYX4su4QZr2dU3HJe0HxlRoo113h3I6R+nAr7T5v11CxXJbUppVe+XQwdWwBNdXUnPG7IL/CGPWcklQ5gO4QT/nDRyELptNB9G6j73Cn2RIJtQo8OzoGqewSOFU/7FZCod5V8tjSLsqyXY903HjYstBgQMd4TuiA29vs8Se5R9HuKpjc4mnxfpWTvKr32MncJS6z20gW1t0+cwODN/unRdj7ikPKgAfk51nx/Z/klX7D1y1xoZpq5EGhIbseU3eYx2zTLH/AyA9Boq82U4hsi83Z/f6kTI0QIEOIIGYb3WNySHnMacPi18kpqmmXCsjvXquy5nr6dNlGuVkLPW67SwQ+YMw+H+dF9u5thY+JMM1cTp2fmjveib6HeqUEU/EM108w+43Bm+kvsMw5w4CCBUG31Ykrmwl1agLXdjhH5tm6h14bmjiZ85/n8QuDVU+VYJ3OAY2E/lFKYmlzbH3C4MwL7XeWW5N5bvkOXEPTPZYnt5rAiXzxeJJ28WFgnzwUng4dNaFaiKk3gSYupxFX01FYGsxSyVBo3Q6PvWTDHmQe3KuUhrUEFu6ruAbHib2SrHEm2rUY3UpZa2q7VhiAlL9Bc63+GrBRD5am1cLOwTb0w3apG8I20GE5sL+m95kazq7uvOHaRFo6DFEX8eB7Uo9RRxwfCDUh04ujvjRq3B0lhk0ypd4RD1zZMua8UeFhPfdX6PBzzZln701j2I7n6HK1UMOUFzYvqMjE72o8FEhNe3adsgalrm0D/JUKe0d+cJqoqE0CAxMjVxS6mV2ijiS6fTqysbbyCL0tKpBzSw9TXEJWH8SICwOXh8PcwGskuEFbtkqgM74VznCgI9Uttj45ZVqLKmHkWGoQ8HG459XOf7h8fuPDevH0qV4PKGXaV3kWvLvSbCUlTRMTFVD+2GBkg6i88yzStTM1riSq5mTOCq9ZHuZQuhAvyl3f/rripkEScKrn+5INosaWjrDIA14ig0dyOnO4iOcBlhpRVxXO3Ik4HwBuP08z8PdAKmv3NANKmVHG6BQXiOUWP1B8w6n6s7kpyZZkhqLa2ZmxRrvO7Jcr+Jjgbz+hNvD+Fb2KD8cn+q0hXHNQPeXcD19mF8cgSJHSFXga3BEniRb/FFoJ8Nohx7do7hhxel3aJ3mNcPFSXx0RLsO4xLL6IC2y7e5D+PvGr+8oO+nQabR698tVN3nwTK/vDNHDJ5Tv8xblMbWzlBDBTYJ6JGW8e4aXKtGYwVTndePZQsZafw6j0J6PD+FiQUSAJHzhdumLeknoyPu9o0XQQvLel+4kWbcDlbU5gPv+ja2l/4UFMw91cx2Hz6RpqGgys13sC+z5FNOyDynjS0i1FmNJmS8hR0ckiH0QzSYnprqKhFiiL21Fjj/3ncTjW20hWuTehLhahOArM611hgcf3kSq25nNlOHhNhmDByd9+emxopmSQEvsp+Isa+yy8x49r7gJbh0OlVpSZoIsw4zoYNDkyenADzVVB74VxZ0DdByEoElouPbVM9SNqaaZIvfnRF9VjZ42WcnOToF5iLHElHiDiB5+8HUAkaiRVVew/5Sgh3QIUOIp6yRtve4BXwOB1kFvhpEJbN8rTVG6QRO589ITFHX6VL1p62fi4KN6pqq448plZXkOPtT/oIeDLKwdiZY1p41FTAIVM+JBua+HV7SCm+zPa2drB7DXZ7TaJpMsEs3Eks464XZJ9UsaSm7Tulz2dQuUq6LiWp5kefZK9meVqWqUtMvPTwzvRdS4BogXXXMmsqBn5708Hv7yBsHrZNS+T+HJRJmo0sAR0gz8wHs46KDnKyEqtLJs6HPMPkEru9Vi1X0HWQ5F5gBxEtE0Bz4dq2+yig+ykVcgmLY7xsxjy/ms9rTLroJWqbhTGFqYuXtnywfVDzwT18wqwzlL52YYgbu0AOwYgYgL++6iOVcqglx2YdPFjfg/tzHsspEbu5dTBPsq9CDaxzTpLcorOKZYfmKmqr6miVzmbYDfPK+a5c2PLeF0hij0pOp1nqtQtfnRjKOmaTfnJSiRSTBps77ieJLN6FH6gNa5QhJSmIhiZeOxiZ0zqy9McoCKx2kIxFm0Rzop+S2VDuetJIvfrpkA0FqmZIQIzxY2NS2Dnaaffm0GOmXkaOxU+ii3NWoDUJyPtKgWD0k2ari8HhJfz3newC8rjMU3FaQgP/AvHsLwHsdwjSN+FGTIN5j/3TqnbjZ+do0KHOz+W2KyUFVPZjNBo7zkjFK9m7uUwpv7MQZ2m7NCzeyxRu+b5Rj+zt0YhHVtLHnaXJxXmP/7MoTUQ6jfciwsHKL0IrEgrsj8733Z1suVOZrdkM9gzBLuey7CsgcAbQQZvs3PbfWat9NedLtfKybovCZLpnYdiF8TQVvv9FgPIv+F06tKqLjj6ejyCGJbdqekgKb6TamhTdDpcGuLsbYJIMQ7/LZy+MMNDH8I2aTn3qqj2UMKIgnb12jNY0+ty13sE+f6YYodRpgOpTpTaK79nzbiDM3aWgN1rH9y0vaK67qTa0IoUUmsejeefkUn9lfFMh8PJyKw0H3EY+SpeTxVLE5fb8zALSRzzREHdpmoNq8k02763g49pDv1VpHSulx2RsOaT1thTqkPo2DOajZ7dG+SmOeUTUZTKlWZTxyLcjTu7cBaHxb5UbSMdPa9RL2elnrabTIKzXyBroIYOFmfrRmtTgmB3XeIkb/W0B6CJMAa4jQ+1RRbq7kMaGns8MnmTNduNY29PDnPQAwkJfzwMhmrOWjU2ozFZoan5TqzQ5cozPKw9SH4jhTYCp0e8ZBPZVQKVJGIQqr6lUsvamOremDxfxqZOO40tvEW8B4nUp1Cc3Btj73QUTBvi4DZYv6ecUi8f29VOnaBCgYnxwW7sOebC3ARb9FlWNp9Y54jr8ku+61UCZ1JO3uIxO26Fuugq5IGT9qbuobBtS4dIq9MtvmHL9vWCMzWAXFJUxZfWtfUgSXfZoSHQk5YR8rkftOaBiaMGzut/1OXBPovJqPo1UopehbXhDIyUpCpYsT2SkNZPJ4hhFfrPFCBjC6BMGQUkjgGUlEk1Zh5AQmKblD9Zse8C60hgDkBqDjKN/MwjC3Nq6MxjMb+eyc4Y3Va8xKvy96vJ41PFY8qeJ/x1Zl2hcjvD9v2fQcKtSelryRgCKYklZFj2Wljh0mq5nkHR2FTXPnBD/2vr/PklrbmFyOpBEDiY9S0pj8hUtb0QeN0GpdRhdDtdBzrz1fCfKnyiGrj6s7PaD8oxNVvvx/gILqMkPNkBRD09IVv60t+/PFjayte4zl7ajXX6FtJPvpAbMy+7VZkDmphzT+tEQKPoOrr7j7l5bfUdD4PwCXtUctyzMu1DbrGqpYP7wrANjiSzOeLaEIdwy79xJTtft01t5Y4W/gHKbV/04Yt2lUAmV9n8L3+iw7TEVP7AUAlW+O/aYgix/ILzsXj/RsS4VjvkZuXniESO8bfr+xIE3iGJHSm+yle+fxWD1vZGQW+2hrBLX4QmnwQ3DR98foNadBReqEMGqivk+jvm9lreXV3TvCYUWdKjE4BkgrmBrgf5Q/YXavAjlrbXZ7/OUzJi1Nms/ABo5BDMyjflU2VGPSSse7y1a5fe1i/Ysex15btUJEbXsYgVTf0sbNqHV39LEI73ESMKjUwmPpV07Qftq4Si1kgiOW3yOmfQqJjDhxBcXMRB4bKon6FGlMZblTd5Llpo2Q06Y1qPswV4j/lfNSJ5eMBJdCQaDwybr4LEbDVs3ioSxHIvz+35UOv3EQFoDayEFrrWV8m6wJoyX6jvnqm6YO+NTbtWH/kEljElQ9fB+yQUFfYsQOUPnaMGBMM671hWOr4/4XYsSuuPHnj71CHg9zbBM7OmGpDfEEb4UdqreXRqxCXZcgWnd+2bZxt+v9UAimsPRd56VhOCpad9MGh9xcJ6xugUjKLWPRe6fSUET3YyfjavJ2441f+oru8c3SDQ3Y3AJYHHG0iEpnYNKCU0/t6Ct1tWSC8wb3ckT23XRNflhnnz4KHZ53IX6dWEndxtpZ+TQB6u0Kz81JQXq9EyGvb3S2x8ROLKQfHunssbJpmYCrx/Hn73Rg/lg5S4ni7pKLIi5JGugxyjdKj+rIcxJWOHXK2GmfnzH9GLtSB1LMyOvJGVpzPxkUvOgSPi87njiZcLQ8xRnKgU9IuFRPMd0IslNBVihcVWwYNMSfRd2OrzWoB4XN4GApwErLBoucIXr7Y4fyYloiZ4CAAzq7K/yEQBpt21Mo39iZ9FwsJmbVaGyFc0sz1SY5iNLCQTOFvj5hbbFPjwaO80J2QlgOOdK16cpSfaOluaWGZMbZzh5SA3SACzFLnT7EAVoRr4Zw3rRB8B0OpsyMA8e3wF9ctc4S+hoiGUVGjbws8z3oiCqv3rFCl9Cz1PrR7TbaEVd4hX9u67HefXJqf9lE9GIjZfrhZnMaRC1QR527/UOfTGi9PISpGHNed6BwQkadfEXOkA2muWkubRg4sIGI/7HUUiAh8PUeH4R0opI17Q0MNMFq3kh+Z7SMUIM5CIZ+QUhg/3QgDwOo22mvVrVuwGy4ejYfID/E8FR19IyL9SLr5G5DMgWW7Z7O9+p6wI8DlcZvkUqdUeNHxHPExtcYgG7Bwch57OnYqVC6i3qsF9dtmYn+V+K10vjsrXFDoC+Hy9HLVF3GOQafsUWA2l8/Tv6C27JbF8ZJTdSDCyImeN5ETHx3OApLTzUgK2/5lHtpCWX0pEbROlfVoX3v6zJVN8Rpz8RBqD2JCT6WgMPQVv26z1F45M1fsQliW24QaCt8o2p70krrAfATbzZD3mvOdm+R9Wm+I2AUFTzZD5VQmaO2Woxh4hBDK8mIYFwILLDAK5pgk9Zb4K8xIvoR87Y3R/ixEbOpZz4tg3pUiAUy31peptMIUTfR1RRIKECMsc5wFxl542zgbX41g91uROeNtgIolYKa/rVlZhcHrNdlpQ8wN33D/vvMHA23kH8CBz1q2P6eGuluJw8NSw2s7m6DV31w9ZFQm22fhE2k2olZifkW0hFa9WaL5KsQ7hofQKaPMLqg/thzatvtRoRNp4ADcFr6DM4+0HdymJrdfls6Q1elaYfJ49wkE/b+6vNbPGSlvZsGornK+27h9JvndOgTO9BT7PM/WqVcrr3MDijkbTtMNoaIhpZ5UKd+OYyGkKh9ezAjT8s6c4uwM44a50eNmPe85Ym3NWUrkw3KxLG6qD2WDLVJOEry00MvkK9a8Qr3XD8HDeLfWPkPfOKXCmt8DneaZetUp5XTA4EFS8dhrb7H7DsYP5KZLayr23TFl3dq9MH/ZVulkt4dQGJubxgGLLcDpD0uUhkT1+f6tOeDK6eyEZgJ8gxGkQXIMGjJe2HXGEQkEBNWiALakOFDAEJSluDQ4rIj6PQDz1iTn7+f3AxWSP4AQtUA0TJu3xC7FD1pklGcpclM7WcAVRi6e5WI8YyhYhbN2l6zIK8XmeR90csSdRhDNhpRHnKvdpfUS3YtSFRs3nspZGVfJQT6pWVnVmUpf2Pb+cQP0yfo8uzISsA1n6hyOKipimI1zhFDA7FeXEJKiFKTu2V/CCHF2eQz3yJckSs+O1te50ryYwBZUe2hwP0hqs0wByDcbrLRA90pOHN8CQ+XTpASVvzLaVQ0HXgdf9x8nFuQwrQFku+Vji5H6aGzrxeN13aSxSNE4MZWJqG8YnZdYdShSfASaz2B0DVAZ5EBVa2nVuQ1AqxgOaayep+5LOlISk5g5y4Fi7bdM95T82/ATlb+AyUFiW50MuGA0FuS+bFBC478zJf7sA6AYFeCPBaQErt6bxuvx8VIxSFsqhX5za1u3GAlPgXqIwcCBwwETTeNk04YuxIVwpRoxm7JEWSvezO9dMpukAmsGI1bNuPWEEtI0Z6ybrE1HjS3FklWBURY8SddhiQAjJF9xHRh3yS+9zUYwhd2fc/DUZgqAhFOfd/eKIz01Q79Ro+0lQYaKj+yFBfUgBfvKX4le2BfDWL5vfGSnFc1qt222yx8VZ2x0qyEG5LMygZK7HjGLISMaAv0x98gWy8gGnENxAyB7SqQOPwCesnPYveArNWI7wwgthAF3iCSRzAkatH6AKuzCOlwWw6nmv4jBZBQ7jh35ni7TjOZnXe2GxxmAnfUoutM1oKvGJcYP6nY30SzNMNzpj9qeY6hOp/YXCCefLOOERUZz8m/eeOYREJfBSKt+yWGdx02Tghi2i4XVCg7Ogg9C4/TzfBjNOJf1Y85kEH95tJ6GhG3jedNNc29MD5kn88qoadbOeOQOL5BAuFB849dmmSPYU1rq5vSdltQGpfJY8TsAT/AbJEQ2UZgQ4v59IFlM8vljudOSrC1ijhRgUzayrIdaewEtwlJkLn7kDqfrU0g9sc4pkl7IVlOEEc32xoVJpE9dA6lM8hBMYq77L711ySm6Ev7sbRlR3NjejUggVpCrfGPpcQgRCVUTcBb87mwG2SPs3I2FKBkZ0vlYO+qbgvnXk/3OWZt74iIkytIGjkXMtmz/C8MEPQv99ED87Ty4ZZZhVf8xdArwFO3U7v/7TsM9YcQ8KH9zub+Q9+1VHHl6GfJa8MoGkHxsDzbrSnQAdL9OgATcbA+ZKHSBDG7UJiorP6Xao45d1DTtHi9DgyQTW3IaUQFdYJnCRASo+OmbiLmVOOp3fSo46P2dAn8dQ0DmeEH7Y9FA2TLFGz07BWka7ZzSHc99+6/MLuQ9NfUUn5gf3GVPKB8pQ9bWiVvO2bAEWijC3aRekF+wYHoaBxYvXq8EmXJ8uu0p8hlLoQJyem2qdgYINMBg4qXDzKtN7ootICD7tzh6XLzadP73FNIj1WK/+aWBml/1rJ5Dvq8G6DnBlqF20IuAtJ0U1IfPGIEOAYO8VdQ6mc+kNmxGewlesgG2pijYpDMnLWULCqkp64MteSskPD64vLK58+ECzoCrbIeYe4wdZxQeOL35rb+mWswWIfQaKHd4iqMCDEsBBUsRJnGyFsxe94++fo5vgQFJ0g4QEGA4oR2yzDCOJ5qx8WpdFuJk0p4Nd6y6LNUAIxWNE59pFPzJ6mQif3T/zzmX6/jahHySfVdtar7iiuPPlZy2SNlyfBkyeiKxmxyNog80sVnLZMF8/HKx5vFYQTSoILeIBruUAGGKnOqCQ3ybHsYv4smJ7GCm1bUQqCBBLF8XsBLa+G3i2cJB6l6fSMeiX5gPQkaUJq3pxgBimWQUcGPdOl/d2KQqLS4O/tvHE+lxr3ohjsp5ZrnsAhXgTe5gNeA2QTHqPPvOK2oaNZH6tkNVm3AM5Ap4Eg2X9m1HK/npaiR9s37kUla+z/Kk1eApTD0syPFak3iAPLCpoyIsT2HvEd425OMI3Ub3FIzoOCTRBcjp8Pvnfoftc0OfCaQkP+SCEYhV3F0iCC4Su2D4iy+CRXOcKYlaJcgTUH4V4kLS5VBMbBAhXEVXtmxGrC502UWURR+VhlxTn4nWc3XQPrRIOwPrKsAWZsUD7G4YIzzzEEpA9CXooxmGeDZYOOKm/wb5SqSFULd1xReKqwREZ2OybZyLjyjq4EtY1igmq7/n4LljdCBnpCC/j9zoPD5OQYDGlg7zgXCUYiGAxB5fwvWzwbGVDTeNyByCwUxj0nvH7r93Q/vo6sw0Y1CSfWB/UsBFfXvB+690oBZM5FQ7B82G8JaoDpWijdtY7/B85eHjReYh2VM+F//Vn8/W/rwl5Mg65F2iTm7OGtj4yhhjyZeh0ItLLfQsKvFMebLUFV1byuCAn3sqD1R34z3vHf02vrr124tAhxf0ZJzr897UY6bhLLt2HJe59/VjfNA+kAvmKGkRr0jw7aW5WGJeyCtbZw+auDCPPahkNiNZUblprqnjDfUSpV9vv3QxwypAmsN4rdO5cFeuRuYMvOyTSuGtYhacJIAPvyVVqjgN82R/M5fvKWtxj++pp43CznqyybRehqEVvtM/I/qonrtJOLLcUQ98pXTuArcxvlem7vm8nm93n9debZsDbdZlU+KATZIdi0KqfmmLqe4+dRf40HjL169HB5s5eui9xcAkBaVXxI1qrenxQpvRbO48zUlsxr8lXavDgt6UPxiHRv9mcx+P2cdeAbTu1tz/gMcWz+YpEaJV0lbBybfjr0Xfe3h6gLXttL0a9nt2H29rH3bEvk2bI+LFVGazTHFsBb7NH8K7+QhVD2Gtvb57XU98rMH3UT/5wWMv5IDO56SebA18IYCTjDMEwAs202FnUD3bs1dpW4Q39VlP7x4M0esOz9zkK+olWh5+8cfhJLw8/mYH/Xsv/QQ79T7bpf9Kdw8H7lmw42aPgZEIhNfVgRD2MWiybwRLR/oc7BOltm8JzjH3dITNlYe8Rkkxip9k4/wCoEA+wh2PXNLn3CuMx6dl9HPjMwHuZYp/pXNCjDTc8FS1mrvTFQZ4qzj5ijzrUdIbBNpMO7PJ1PH088MU4egJBFYofjE4TDzhTj36rRj6Z7ezFT8Vp8DbwbcypdThm0BI7mXYCrsFjjOkAQ9bJOKKqRypQY1l4ruI1TVSELqSF+WJYhA/XJfab9qWk3xsiux0ziQDpAnvZm3Z8o1Llqej5uLAWjtgy93PjT1yNDij5Q5aKgX8uPJbj2ycYC2y4ZM6S6a/NevmCa7RxXz3D70nNbZmqW9H397RBQxqmjBKyNjjr6X+zVLrACumUA5MVhecJwey5DpJveV6gxgmsmZ/4YIo71bJzrX64HM1+9WOzLo0wh/RcIKo65iHZqS90rEdIMU7XWbiZdX6Gu9WB8V0EvW9BJ7cC7ftCfrqnNk26W7de6+dwNC7nCTGLtguDEtBmWWr4NpGoteurF6t745XlfmQONdK8jNj9XDggxn+v8lMqI1ieINHikWCEXEU6aqs2ePriWSqGgsz0W+VsQ1JEg+fH2EW1Y9F6xNTkuAc1V3WT/Zk2PB6YpmidBZ3fZX7AvtWbZescXDfVTmKLWfpIU0RCWWu6NZC4h2xEb28pSTC0HV59/Zf1DyfRF1FYxJ9b5eXAl+KDLmRmUV22J6TSODwrIo6nMETxCww54axWIuxEJv4jlwfconF6qPrPi9/pcs0ucFZmhuUl8tJRMXruNt4RVfb8a3wwWYGZ097nWsHTjchAdFN4GaRpqy5MInGJSCxq5yhabc6Unvi4iM+kVmYy99k9cY9USfCT+8qvpQO7qFrZpV8IHJDZ288dZmrPWMYCjrtlMw/Fv0gdfk8V0fxMkrsimG86UgM/VBamXG9jmAY4puCybtspYb3zbCMfbR7octTxVmS+8eShC+Ltaj7fyM1xiY8N/xdlp3gQmlhPvXJX4xJvCzXuz+82obLaRsbvoK3D5satBtLH+o67u1D3zI4yCiGLDSBasaBa/LxJVYlvxUiCmKnVINVyrLteqLf+npsfyOuBeOPv8eg++y0bCqaqUEP9y63vvbQPezzbjb015TcsCq+/rdvAlfS+U/Zqk/W9i72OLCNk5kh+iKctVYOC6ip5FXpW9okX2Px516370BQs7IVglFXv7BS7Ox+28fHAxlRpuY75u7co4B/jAUSThhCufVfNSZnH8MSkKmqBJgC4VKmHiskwV7NrHT1tE8UVGPcbIG1DLNH8mIp/OqDRidORcd0UHRHIL2DzO7HjB0Nya0KtW287G1/0t4sAJMMGjR9lswSSdjFTKOI+yaUaPawDYv5JH2gGqT2uqovrSvNEXj5/YeeltsYHJ7KXENY7otu26rmiU+eL/7ubrafd29ZvF5+aXZzWx61IokATX7pnFsjv2JmcbI4zRUMee1NN2bI+8WnJrk4JC/w4gMU4LbsrGmOxaHdJEz2Z4PCxQZZKxTBmlw4L4EblfysSo6S3J8JQZpQZ4VBL20/JegM70xH1um7LckSvHM/bwo/KKWJdCKupLr/22T8EZMBLFRCSKVj58sCH6ARPz66oYL4KyoF4NUCLBlt9mEK5xjIKND968khI9SA0Ohaabqs4FwhkquG7UgVOam0MGW/mSquwslcrblqOP22kfo2s+EvjnzS9o8ZzZsoGw2cNBk/8l5VKJVdM/HgQpw5BPU9+4GNOAKCFXxNQe3s2vORcVHzMVFNAeVEtFEHYH6lqi6xsWc67mGUp4RWQAhy0xCLsis5mqj4++tMunkQL/XvOw8Y2YNuDyHNW8iJy1++HwAfL9u78JIYvKl6sUkg42pKVziDjCCx2jadrlDQlMU7WVoJZTjDCt/tqCI9jXG512QansBm3QlNDc2kWoStsNKqZaQhTZLSLP8SwnVIULWOmHpCIuLSQSXYza+pAFq8UcVd7UcmI7Y+EkQrneramt89jUFzqUyM+4CBZZGlZ32m7wiIzP7m5bYyCjTv1yaWqZRFawBgPrxQE+DAdrbg9hRuLMUCGHLwMMoZGLT4ojILmhjl0BdaqykwiBoSlGBeQvuWWHdj/KWMHDGmvWK0QKA1fVaOwPOPbXyCIppYkd9vdBkvG2jpoR2v2RqKrZcia+1watwctEXMF3Yw3cYTRBI9aZjgQwYRvf/3PVN8Hq7ZnTNZNqS0sywRtqUWM83xF6O+qo0bw8sF3n6UE7newGEI6uoRqK7zjCMGhR+rwpY2ybMiOLnjIiDnlyuQOz2kj3zkdz8B1q5peDKQut9guQngwdDsbMEqMOK906n+7b9EW9lQQqmv0GEX9HSaR+5CWZK3cbw/AtpDXkK/64Q8U3t33J0eIRmGUGjiqjd5hS4CWEBjf0vI1alQ++pNkGWVl76gnD3XWuP8Xh5SUXE4zg/aDW0InHUBEMfnVEgZmtd2Pobs8/Y3ibxS3pYfz44sS13MRZlkhbMSR4khgtoa2N7vBC3SeQa7StNfZDPowdNe/7oxnMN7k78Q8jVneaAbiIjoLFwD3dnV+93c2E0zc3G0ACNDnlDtud0pToq5fcPa69ady0ofwOjd8gy2jDJAd77GX4AkDM467it3t7trGre95Oi3e+9B9jXOVYyDX+CslPoXDRVnPBQIZWML03hOM4POBHHf/5MtdqFXSkax8t2uc+Re34V3MBNMNT0pWveyvdKYH8F7u2xf/8aGbJ/XHl3uID8QCzCHYrohJgoCq++XidQKQZjWmlCkJ21i89kR2KyklZP5LpEp5kcvVXxZDcIv5gqNf7Lf5dTZ3hQNOF8IUnun7ZuJabnYKM8szaXp/biLVzpUeGRcvzCR0q5QgM4GSld6WZpsM/rFnvSOc3sXNH0l/bJRMo2lnNX4UJ8HatY0eBBHNGK6BvWMUAX02Z1cI9WhxayJP4ZKFvONTQeePkRMtz1WkpAyP8gFMu8bA1h/AIgXFzB8t3TDfsqHZM7wnfhcaFBUSkzfvM3JvowoYTQsQxRvwMZ30BRXlbGlwQr/HmNzwoL0C51yKWE4GKFAI+Tiu1TlvF/oa1JtE2R1u0WtRA0lN0whSyJYfuCakuC1xZ2NWKZtU8OabdesOVy0kwNQtWOfdXS3HisGg2DJwFrmczHN8FwXQnuly9ejoZXcs456J7pLshOIge3KEyuGWve+urNFbkezIyrk4CpHzX3o1mIF7yHrUrZryQV27WjSFKVqIiKZ5ebp1iREDMi0tDiizhKJavAeZbcNBlRyy9MBK8ba35arCng84Y21eABpYXRlXUkHQWsFEgFq1G/6jC2FfBRNBV/ViHGYTAOP7jsmMwkb7ZSQ3oKS4KpfEunG+OaKvx8Q8s++UjZcDWdNVSJ/NE0Wxc7sLguN5o0DVfm2tLUsCu/xFrTiBdZUNVOBR3mfOjxgFvhhdmcGveVVlGHbH1HkBAay3kXgE+twzphKiP/AlF2C8OMIxER3X7Qqcmtf5KRy8jbIxiCa7/DJ7XJsu2hIf2DVAm7VsbpYSmjZMbn2cSLNObwDhDx6p0J9HoDbOcn2s7lJkR/0nYiYFB4hnrOdegPLglH+c201UBmYiiQyZ+3aDVmC/9rM3LDZL6bmv3Lxg/egf8JCOdL7/w8/pvT+9byKb2G6LdUNX7iv7D5TH3ykVnOfuqcVQeYzE9IOnyJgUOtZ4hITqj2e5mWBmiBPNEU1q4C++7I4nJhgnWNY8TdsSu0JbbvgHxGf/p/Thj5j9Oe/2ejUeQ/5J//DBLOZ5OPykYW6T2UPeFZGG6QD8tApkKAgumosg8zI/Q8XgKvYkYvSNqxf/yZvpJuABSoBZeRKudrlAnsH+HXKCJuVSSS3A/B67F41IAXjUYLY4zRrrJceJJYoFSw6VMFzFO9H1rrC0KA5BptOZ6iDPjAIUwRd5fhQ7u4fhFImL8ZE0K5efgGSfo3M7eXUZ/EF22t2bBfVu2WLGd1eFZ6tsSnuH5ptcA9L3zvMhlDGNTNThzMUjkL6L7P89+trJ9LmBXp27IBzM8UWc9r8K1nQY7mjmf+ebnl3q44B4kuW3eM5xgkwL638w/jXszE//N6Pff7/8e/Q/5whFUHH5d/FPMc8IjUwMOWhmmY79fIveRDbiSeZ1Dpz7Y/7mznpEOD0zPxKBciXZ08LVpMFuplk5YD9+XYAB9Hv5NDR+0jWfguzMrVdHqtpuubUSnacaIvbwTpgZokYEI5OqQPtA13xUEFYAeTDZOOKuF8BOiHAtMVWKWEwn6cZao8mnCJQ1oCZG4NU4DhBVgYFUw6Qlup/EoKdRyatSyrYIreOzwoZjyI5wBUnGhQz6J7TplbtASxXDoJsGI0SzvkwJS8tST95PSWMmWuKopqUuFks+HHIbLIDjl0nllKs2Cr5U1lnIJ8OukhUrrS7Rq7nfhZI8dFkhlZutXA3JfT6ZHZTBV4utH2TJzb1CEK2jAgAYWy6SPmI1+TVwbz2DBELrWNQsohLrtiiw1TWJqZhf+sVquTfAaY5piY0RYnGO/2QQuYuA5/bVo5mrZ65P2OvWNapBLXJRefvCLCPFeFMaF9A9FWqY/vxeUHhIiL+WqzePgL3eva6HsIDCEXt8a97ae/IuuHarUKvVk3kFfPFzvI4GsIGaR9yO7RMIh7xZFlGDuIRBcDQ6DWT75dUJWrVyjsJ7aBIFu6WunbUYxALGGCul0YrcrQxu0drEXJlU67H84BIbHEYgSZeIUeXY7kCycP/Op8WYOYNuwMKmm1uMTxKO0GOSiNLjyzsaZehpJnSR3NJWYjCG+VLl8aVnRJGyGhJXckJN1S8U+dObIZfUlgWrfhxbHEHmENQ9RGB0S7Rum3Cmd1GrTHFtj50Ko7DliJbWytiVg9onlkk94eL7di18n3jiLGXCfNPdOCGh+uPYOUZBFpb86/vAEyeBQEghabY2yvtwViJ9jixD0qLOMZYlGXAaimTjOkUKl8oFCaEaoq3VEZtTF+p9BJ7Wujb62dv0HXjdLDRa2vuJeWxy/7Y/eyH2BM81ijGWhhA3gaQC1ipsznmk5pL6cKaFp6X2MqmFgGxw2J1fKbulWIaj5PTE1u7cFz/k2iD5p7hxi0NZFrlWBzNlwJqKRj6xws4drs+uBG7LtlUuD0S5x4KfJgt6+Gm2gMREHXQQDwz567NoDqRBqOBKsb6JGSgzTGd8iyFyUWCPxwK0eG9+SayTs2f5hYZBeApQfCV+aWrWGzybaeCdRCSFQ21D+hmKh1JWUFdvzDFpB0uSYDVd8UYmmie6WTVOFVz0qYNxAGZ2OmTsqbVsQdsE95kqwdjN7KO2FaorSE20YMVzJ6PgeCAyVtOXzLpAX1RE0TcllTbPxki9Hz6cl4xlmHY1H7yKL/bDQSGjMNXQsLK4AQe/cZ8McxmUabfYh6/9HGFobKG492T7c9U25N1hAIUdLcMkUqHTIEf42UP+qWSZaTbrKE0OEB0EsKgUIUH3Y9vrc0he5F6KfY4QvkCRLaFy16WDhNv+c1YfZ3OvaAMY6onFQxl99E66EsFwqDOKrLg0qiEhNGRRCb56m/VhhTXxE/EftWanaPymhVIXZl6yiLQFDHK+JUNP7qiUj8V75CS02eqZ9U7SjNqTW5NTRuPdn8G1RU6pi7fH+iztiXBPMfjw4TimqqHA8eqv4qAo2Ej3VbqoqW7dz0wNlKErfzzqeYAcvPmdTM5dc8HndHVBHy5vAzs4aMKWc+fCKE+1VXpbdJGcGrHa+DJ5XT5wGkLV59vJMkrtmdl8osN7jBGSJPec4ZAUs7RRXlHz0cvcLtOpOKghhmKyBBaJZOtDUA8pwkc9XyiON20n/Dys42CS4H5ipRw3gdTWk8zsO0TuOOvqPlz6jORJl+tQgXywAV+dwHT8xuB6gTG15bZTkiKZ+ZyXc39GRrJibvwm0IfQKHGSr3FtK/CPIWlJJyGpqe1JJOZObkyy6dd39SuqC/QiZMWMp5EAdQJpjxC8irgcQtSt0MHS+PJDX7dhuSyLUURHjS7GOqdXfck9sgmHI6T4h6Ui5MUEsZzWtXwvVpSLWFVfmg+YKYv6GStf/JMvODC2NzUrCiPF+mOooWPplZZNZNsxItmSDm8XZ4DXm4wTIzVC3kTYTg1qEUkP1mXYH2tHTCrT6Ivf6aPCLb1CDZg3ywZracZBrbFxh5OHT9Hjt2+Xj+Wpyp8SPiewu1EAu8KQpSOgmXUI7Ov7+BKvOeM31V+MV9cgIAyJVMxVkefaJ9ajVW3/kITC7qh+2YJCCzvakbdz9U+4M1rgq8sYwjs05eu8XMJ6r5P4fI7yD1mQPPqE/lKsOZ9iRQMqe0H5tGDJgBX769d26p+My+sVmDzJDt0wPoFA29NPQhBspuS3xkdgROR+2O3IvRAUE9qOJUN0Q0Egk0ah4/+21FxkJpDbSHK0GmS6aLwV8mFWf0r/O9P6r1ZPalF3SvojZoX+ThnItYgFGHEYHsRGEgvZl5i+g1MTLM3qixdHHYCI0k8DNR90cQVLNuMWCtH9xVVpjCB0QeoDMNM1fGCUBd2pSvcv/IkqZLlafBaCH9LipjZG2Rk7HXBq8V68goBHJPvVc4Zw74ARCQ+KGI2252nm4q6L/yUc6nr//e+ehn4bKiwp9lLv08LLtNxl9VJHSdbp09toh9+rnfkLBamo4MkG7UjpPRQ4iBjRuuk4woKZJHSYLMJgapN1tgOyAZ0X83z31kccmQ0o8IJbspidHD/BXrdaFjkP4Ep+eEGjwdjihZvD98ap2dsegbiKb5Oc36KT5xnBVjxw0GVtjR7CLfkPW6mEAMjV/3+VWuAmnGlnWDQkzle675/25ljK+X/rEqgmiK5gDzp6HGf4rTKgDqMlg2MSRnoIjRi7LgN25WmnF6HKjm8+9KXFD3ubzVo7eDx7nbSHeHMUGOwoifU7Pqsai/vQvStukpSFnqHRpOfqDUbIisioqAoq4kT+Hm0IVkSG/pm7cx1IepTSmVIN3oWL8XTfRVtAj1HCsUZEb3A9O5scgbF9ab1aDTggIttnBjMxwhd34RhHQ6Sdd5zhzRYDxxYFbg4qoa58PcLh+Mnrr2reM9c+HNXVpp9u18MPAkhuqbITZKEhd7bypatsVTRB9YFP2kbEn8GLv71fyTqP3KFVJB0d9XK5165cg5yJou3jCjagUV2ugJ+H01/TV79g/+N31sS09RQXk6yCmjpr3bieInkhLaiM3dNuHgt8TuDp8LXSCAy6b2P58BieJiX4EvRpYB/ya8TEVkDDYb10ugB9w1A4oFTi9g8HjiaENad4sgOD3QQmoDOOaaLXrA2p4Cl+f2ZLU5wc+0NPUF3CWGqwwvkPDwrNNRMsoQ+JR+X1efuspEtI/pCaFimwufl2cKJS1fWaIEFG2d+4uM6JlwYF9BZF0Nd/0QGqnjm4GJpHRzvW+E0j08kTxPh5NXwFYg+RJ8ZxpPpZozj5wALKhsKj3sKS+dTBsmoYDCuafP9TkEnE2iht2C+5qw8KZqQ6GJ/6N4bTGLa5o0Md0WWnlBqIw70j/+PEiaxBhyEGU7QzZGdsKh4QvgxX+eDiwxr+MAtP4TGs9qhaZ2KaKuOm8J2qghnm6UPg2S5wbd/mHCrFZG8GvzcNPPngJZ5I6GTRGnDb4qlcXHP96VsRqga7Oo6w3avfCbaRld/Fi0En4ov5EPKF9tBuGCZgJybd6wWBN3KSJ9QNKJLAhNTE/0+eJdBkAyN7hRlLODUVRKjh2gYqs9Aj0z/yEKy39J+O+Dd12ivUkznhmYKvHssOkGiq0z/Ujmi6C9YpCoh12gu4ayUJTO26JqvMZIZD5GhP/zVA7zqee873GO0mTZDiuJOaysj7kNYOgUyaYiwRJ0yxHCYWNVGsIShNOTxyi+fV92cDU5yR/5NSG/AJrk2tCytmO+oZesMVcgGkgEWPv5CTX1ytIuHWrsvxTCi/4eIyEyMWYxLayTWtgYVghoAmwdZwdt3k6Pbu2jDoK0QZkN/DCERNensesFRZQXEgfWWgatke9jouNQatq4Oab7+pGwjmyiC08j5Zlf1ifEhccNRDFGumcR780BLl3IM+gRl4sFotAduHEmg3C4OnYIrU2eyjLHbSqzeXPm+SimdvV3QcQ7DE9XCVLVklNDaIanfTSS4+TFD5LqlbGQREvFovbI+9vstwI8p/ekYEUkx2dpornUZzW09sViSITMG/4R1wUaWEhnihT77r/KRGRbrwa1QxokzwtYbSgdIeDBBQ3A9+ydIdGL5uWHdWaYM4f0aP9SAFX0Nvqddq1nE5eKsgDmazlEeX+xnh2hv04XmblC3sWDkgUPDZqqBqXlZJuZhVs+CrwNgIBN5ZTp60uB8dFOrBguQ8AmOwqVZer7TdEhj7cfKI51vU3ctMQPceJINNnTfWIat/PcIXRxM6PIwk1zXSTnVrEmk695oii7B+93iws9YWHYrDHFzYvH957Vo6rmzWMHZ3DJ15Ru2r87sD4cOZ+rBTLIKKdw+evY/XV9B/GmX8yVGbRGtSGR84vo6vDA/XNLYI7wKYS12pbl/sSBv3532iGKt/mGjwljmN7GUC2suY1RU5orpxa8HrY4XV2TTaq4ua5QTRKzvnu3eYznSNso1Do+qlKNtH4EdlMNMCrUeQCVSFQO9SU6A1Sa2V6PwKBeAywaS2TKqWPdtinO5lz487Vo3Do8b0TMalQGmLjuKKmRA03KqgxjeS08lszQ9vaHW9FZsSfxJQyPNk2svd4RNbAbxaUYALv2wcnu+INhmoLGtwEVdDZms7GgV77z6cBJ/l5MBx0fwToABrIfm2xARz2OZGvq+aZPqLWsqtqaia3gUByVmmGyffJM51RZLba4L1fikGcgNNZ6/Q/KsRBPnevUDBVod2xdQU3f4StugoVQzm1w4m4V8DMB8ak5RZBYo9VqE5hUKncLVd+ljl6+3xfeiGUKmoVuhMIBiEhl1fINiA+tPU04hEGMxrZBtHqBGSw5zlx+89+HWgIW9RqAWOPOBwFj49/9L7coadhef28/X88lj/Edf4CfGgtH5XfxWIF3K1gV8lTw6lB+CTgvMaL1Adv4clOTR2lkaOSQ+vdoQyEtWZAd1ksV1sx5zzUOX7ctW5NJ/F5U6XbPtc7kAqHZ/FIa+ht3JHeKf9oCJv7YxjAhSBX1Vpo88nuQAy2I3Tsh3Uk7vwWL+4E2CmKsb4ifnBLGYeEYw8052r07WiLF33aKSKbig1M1MKYpk+oDh8VTP3IzNqE+Fa/gWU53DmdexMzqVnzw4s2rh/sN8JFY2PxRjs1JyWMK6i4L4D9b3E8mYaY9Msd/9RHX8ihf833Ombzt7JNHz5r2r6a00hhsU9hHmd8ITr8HmXDEzrWM7svCL6FYqg/l6u7BigFtkY3+VE5473SYwE4rYyL+5IPxrAUJrW/d3OtbKePdqFAifOuFr5TsdeV4UjwnT0QfgfO790WUj+/RLH9ClVlqmZQDcMgOt+1ID39HpcG0khs+gILUee6gzkwQdEa8GIc+d4J9N1Zf5Z5Wcprw6asVco7bIJDp1dOhT8/PbVX+hdPrVfWSNrFu9Do/JA+Fnbwq45JeOLG48r0YeIPhUXxdihQdgjQqYPOJjKHL70Ln88IsvWemQNZfufgEHtyOU2Ra1NbXGJ10o5qchQSN+Vo8Jzf3sHSm2JtFSPtuLfMmgsbCuaWg55o0pnH2Zc5SPjp/e2k5pgPAtXWlNq1crwgdHw4gh6uvpmMPcVMWnwe32JZNhYWgl3lP/vb2BW6jmQE+Waa5Uu+QecT5aemXU981n0ZX4N4N7uBkQ8PbDiqOyeLhC1P32l8ckPlqfrk5D5/0vdtDxusete9RlH+oWT24VuCpOId+RSviu99ut2o3eL4w89HeV9D22EfcU1Ufu0JoE15Nmpjnq0Alih0pdlK10s/YmP3mjLzvT87GLJqEiekDKDnpevyFowCx1StqDdjiG3QR5CgcVrcWiS/zmrgT+1VeJcuKgYvEJro8VeWi3roWa25RSnj6gbzfnrWpvx/7nMv1yr4vI0a1j++eCPEK+9T31gHPKAruJDl1sHpoCK9rv4mx4dk/LWh/w4lv9xh17+ZdSE/MRN/+eBv53WWR8c5aBfvMv/UqWwE5ZiK0yf2VHFiSUFakv74CsU3g7e95pr6BuN322VJ/tVS3EQbQm6NiIfQNKc7SZ6uOVwgTU4tt7syFwwEN0DZr+nLz5zLXWjVdR2baupfNpf2/9eHHvgZUTKIv358eybOleB7B3ZRZ4UkaSvVfCMAgrlbKwO/6pjn+tTWkEt0Cx9dOEr/loieiiwd6qchg3WmdolzbvckzPw/Uc9ME1AHvHk2z6+Cmth5eAJTEzJspWOCRKOdbPfrUP+TnvwpehLQi5PMqGy9eujvbf98ELMu7KBc/OovE1Tdn8yc+BPLszKyGgLYFu1ScyQBnvIUh1Ys4t0pIElMUnq/Yr0WB4ufN8Vs1pw9urMWKtmD5tg3u0RF3KiBKltbMjCrvqFSXqfr4OYXs2sftep5sZwdgA1WW2baOnEanWbRkdtkY5F/99V8y/dRei1L47/SkeOcG+H9mVP5wGzg9ezfibEdVDYTe4za77UnLeH17ztLycdrRlp3AtPvuWRBa5+6LUtuLAa+YP1lPaut3Rj/S6QdHvIzWg5NlwMQYQ7A03m5R7ubRObuEZOQ9P9DCHl65RtuPcKY5qLu4KJloSGxsMjho32aVXOohRi30qca/G3ShVkiPWjP5Z+UCk8umAuPARvDiOPlOV0XR+wgwdb1Cb4Zhl0+6LDVNXiPWpLjBTYdPDAylBz2DxZ1YK4L3QYrz5kbUTDg82NrSqmYclxOgswbdZho5nuifuy8e4/jMPwaJePuxWFsl9IBAB7XU1kWVVRVLMjaQmPCboFBDn4/iRueThmbaW8MZ+Xsjy54vitpTIITk7qTpaYieALkelJ98S/LMsqEh/4sanjQRBkoG1VRxc8/ocaizoN8+vZ7mTCrkOvMG39b9pT2kZvmg6WJIohH+vDtvUsJaOf94ANTCTlKLUEV6tapKlPT+ktjRM6+Mh7g8r8Ss3ZbZttTUrp+Z3OXgpm3Mmh2ym6WuwjpDPl1VBuPj2iJH+22VZ05GOfLVuTvueEci2TEPlQDtTPapq+ygVehttHB9mY3w65rTTUTJ9yjOg8W6dJ6UIVkp6C45expmJ8EkQnIuU6WTBGDBtVbl4xLg15KZPXNI6hiVS0eSMJy02zVxu/WOns/sy5LxsVrgeAD+Kvg1mXJ9T+LPZh3wcP+sl9/E4SsWuuK5qdzDR6Dr6j7XOonzM08ZFEsHGMxuYauS1tDVI23AXYovDxU3GG0p7StqF2TY+JCc9HTIAZZ5lIWaQouPCXLAIJJP4ti0I3m2ZDqv1E8fyz/K2qfI/sZeRe5EQBixdj/Hu/tQjftDZQ2B+Vdcp6TF6T/Q7G0nTi273NTUSUmoEZzLkQAqVufvJ02DaeKcOE7ctTSieG01rWI4MzxvwUPYQyw/J4Ls7lfLx0F5u2FuYalEj2GYgoVS7Sx4pb/O/PdEdb3eUEVNm+PJN4TKHTGusRcyTe/ThVeMlARJqf4jTRocdtxs+YfDAa86HcZcnQgIE3cKchrsB+o7aJmu13L0EqucjZNj0SPeA7L0ctJaDILi91WD0O7DA+bXG6WX2UryMkrg7KYlgA0EQlBq7u0kEgeXfZuQsOrRoBlt/F4rBXVcCvHNVvc9d4muDko2XABXd5KyqOYKQzOWvTGEWGSYMlap4xabNqGGS3T2b4O1cLw89FOYcqpgG6TP5bchdAcGFVaW9F7vKl95CQab6UsjK4qqH5eb1UM2TX19kg0j2M3VZoBg8FAaTqL63sggVbWkDusJo9vDrehETwUBJA6m2L0lPLE4Rqvm1m33RZNKirmed3B9Cy+OCWUGHjYzjUtriE3f/fbByX4WXzRmjZznueY9t7cV+dxI1z0Hp+iJZk0uxUzfjmo2f9eF7xGk8AZcHCLWNfz3m59Rny/jv1REhtBNV6/GYpl7UOrTPntcchgA/6b4U07Kw8k2JubdNQwc3/1pwnYtrQipkZg/djFf0r6/5seZPaI+1Nt6+g8NX1nnX8Zb5QjNDxXsfkwNHPaPiAB8nPakEtS1970a5qzpSM3DUxOyScVXY7qRdHpphQjmtaTt1MIp7XtsbuAN8HUl9a/8fv/FNbF28+Pfy9cfpGe91YHyZqfEdO5NGmq0QlJCv/oqM8KWFZVxMvMg0ER1pqnFbSQonqYRLKVhfllUpUafVE4cUhUOFrTd20b55E+STFRZhqvi9Ptj6KnhGkqHn7o4A9gRZ7IEhf7+XFlqYbJwsdVeO7x1io56lWwWJNtByFLktqJzaUhFpf2rnB1Kq2oiq+c+mLZdSqANlJyvCL/4hz7bmOV3Y68fMGOHmyJLXle4T4JeqNbNUnLb38LKnPujcQa9/BY/l7vqQQ1o1+wr+KHvnCqPZDvqJVJNTjyKGO7MgvdzDaeafypfsv8dt4kzsuWs10Mwc+x1FblTtt6K/cytjTV3Y+8EKln+WOFavSlXw/EFznjhEIVtPmT3jz1o9yoJsxkg4Z0UxR+eQoEWmwFAYfzfOl4rgf9XKn8oeGJ+3CA2xTwMhAfBg625Mu9QR/p31++/YX7yvxqvVW+0tlAp+rwP8a+rHKr+F7nftd7lTxy+Dl+cO8sR57K3kLc3CAZDeFnN/dtbJygCJCxtMrUuSlzNzIytb+C1jXNY/n4zeQt/gHKz/msNkf/AHWee84aXY00dcBGpPz4XNXkVrOe9vbDHmwl1zen+J74UPezC7X/WTRh3wwhttLNs0s5oqnlzRwK8OHZ0J2ROfuj5ICZVKsF1OKSd3KayB3h6TPHH70mkpQVfEKqB8so+jUoaNh48xKbxz4qB1036+GKAmMkfQCcv0icYyqcTF6dK/Fj2Rh4wDekIzqrDNOQhNuBXZUVIPHyC0at2BoR3lBK1J0Opl5GwCVcIqatzLRF/baVGzXHsWL7fteYdXqAdHgNhqKCPElTexWnlAJHHrWs99Ki1pAU6JAWD0IjuC1rDgtggE27cMHqkHceZYWW4Xdo46dqGQEja0phy40mWWWFn4r26BQg67cdoXSHA9ApOFqDBcEN+xZA6KWU/5qW07zq4Z3+5DFcVa/AVAa3zU9LvAzqXLKhpicpl4is75tFgm58yqzPr5e0/iYnmjCE5M103RgIy+Dwa+d6D9t1UujbkCjIcFJyBymtGbjefhFXCPM2cyb641p0UZ4H7fn7CFZsJdmlIaV8PCxeZ/+UdETl43AZtN8PhhjTTPBvTjwftXla0TD4t0k7rCiaGTUA8a0+naesaF5HwFhizABWFw7yxTRmiI7Vx69QU6Y5zUb2zyhGNSDUaeE6D20VAmh/wMsY6NhB1eLjw3LYltlWlg1aCq3nmsVaxTXOa+3Bxun9Kx/RFkwTD9iOoCYgV0otOGaaaZFo4cdakJMl0o0CDsTKcJadFSDrXOGMKNJl/LvQTeBMiFbDxU6MAnSEAbbNxTZk4PM1bIh8cjRtsioAj9aFouDrQxRiaBqRj8Gb0RHgzGTmRJJN8ygArRz6haZgNHFkBvcUOJUgK2KUTWXOGenqXqqETvmfd34td1hbMz5BrwULWttMzlds+M9WtZJTNpaFxlTfn7pG4h7X5MAk+yADfbypLL/SIPFf+Z2jcUBwNIqf60NGiz7NTCECzs6Prq3GMDO0CVa1bHC1Gee6dTjNeeE3w3S7klah7eo18mAMucRgxZXpXykl0/RL27i1EntAr3YrcQPfocK1dtyDrBOcHwMiezIqDrV80Onx+DEsxPXtLu6j9MgKyRx28v4LjJRrEAaF9mBRcG2Zl/yYzPImr3j5UUd7VvSYuhl9lGKi3YF5bDHvqG19McxBZz3mtGx39u9WRsoMAm+uy93KtABGhfwp+UffQNE0Aft6XFfN7z6QAV1KHybJFKv04PrI3PciNd1CXB7sU37jCsFDNeaYovXXT31u2ICUsTv79PMSwnVKsJL5jOioNs+BQPEMM7Kk3NPfr0VsNxoYj77E6VWuQCEdy+4mDO4URa5Et3ATZMzblo8bvQDvMs1RNFVXMjS/Wbvrbp5hevedLHLzc7aGVhBWoGMyjdyWCApaFzHu9139ZETmkD3NAd5w1KgpLDa7Bex8CqBEwoKydQXtsquDU2nP+4q6lihnE3Vr7SHACYKSqSN2oYNzhJQUtsv5x1uEPES4FG9mY13C6DL5BgHuiNS/6knYEd2rRf5kl/cFsCP8YKioz9ct9IbCUJdqLq4dbb9kCFZD4r/1eJKFV52zW939YazdbUCrQlDSG8cszAsSRqasLcX8x5NiLVRfEymel1qOO+RLBAXkKlPVJOXoeL84h6zfS1tuisgOjP6SVr6l12w03AL4lP8AVJj9vsRDai2ACtSWbfM1BdlD0hhxpuSqUTvyTOOITRlqW1htbHLYFY6ywLUWTS0278/JuArpY9NKvHc2vXrBpHcKWkzdl0gmSzkxV1VXy/IpZEm9gHcaXJcHVE01KqhZx4iJOm5VrcOzMjITZcCYiJ52oqX4fqontHbNP6z1lssLjqcqbqLWYQpQVQW+2wN4Sktmppwg6UhWaOOi8tFkL4CsAQ6n+qZJyJMMxXhFG/b55sSZOG8u97jq24WXPamyxl9xKQxGDFOvpK4MnD73LKsH7hwQmFQYgiw2CjTikbw/L0Ft9jsJ197SXHEb/am5bwgZSj9iMy6RB+7NbVmxw4XmmwouyH2Y1gbwxSqMiq9W3oESI+erl8is4Eoo+Rak4kawZ7NSexiEh6iVaPa+L0NBik/uL3fdbxnrSyZSuDGr8AsbXTCnU4ykC1Ewz73IJzrn2AcXuj4bnKdoc4WTQ3XM38YzK/f4/d1jqsjI2jnLsmMdhFa7cUGlxZlVV+r+ARHZKJmAV8s16cPUiIaAyOW6I7uMo4Pq2akhG7aZ5PoHD5wWFHPsiqz2A0q3Jbzn/6WH9m6Kw4opouYBZcPuuDJalfqyo6+sntDq/1zvJ6BxF5fH3LTrIxcoCjZpWeZj7rURZ5F9nEV7Rx5lhAEwgITxqaVDrKgW49pbMGyOGSDaG57WaWun4roBhrQypWBZcH40Ktgmol8lROSgMIduna+PvQHxvfIu4NLDDKWAg3N9cRMN8o8s03KJHigMuYuR9S3n3Vu1cfspUlpxG0LwcX85cWdX78uRVV2rr4j6XNdOocSiDB3MfWtQ92LmZtqb57FnMXt3jXaI+kIK9ao+p6liaYD2aRr8jukRWt5yVRKN4RhYCBKmZ+QDaeya0Pbmf8uoS7TYtmxR0I/fQUEkBrx02V98ezCpBShIyMu3WVkcx6nkHiDgblknRHKN3i8jWLBNU37x8lTBmBazR/4oEZ0N1BkEiZexUXbokeBGK4kVql5YMlWVJEvfQObUkZ3MDet4NGxRGlqR/1Z8IETO9Ibn5m0AKA033yeSlYZoMRlmIvCZaZ9MdfQh+hD9BlIQpxRRS9C+f4aJxi2cdGLNFOCwWChSFcZcdXBlp6Em+bFWdXEHp+nUGZFJuCKSUrqoxPtwt4kxjFLLmrPbk2tqD+xQepcjP+TT9/COwGkCu1c1pQBk+hpUCaNKc2U8Tsbd4jW1l0iLar2pxSp5Drq47rWmPcJTJmEXSxTAlGIZbdOtIq6IFXollisGgmc9MmTTx/kye2gF6Kx7cPzwcKSpakdzUcjSR1byBTx+Y91EuiRUi6kRLm0VQHkC5V6v+qGiDoJmDOdGK5uYlpnaY/Oqc7q6buNVnR9oMuoycXbScGMhgOY1+19AZgYiiIyxZwPQKKwDU1LcsLUqIf4IEG6BFDttfoUi5zSsqRpZEv1cTJSdbnddCzKIe68rY7dCt2cq7MDBsceemWrbSEl7FKoFmzObgq4s1X1Zce04DUO7VvDlajaRoJQbup73zd3TIkmgU93c1ZAVsQ4smO8ZnjVXWclGSRWrDjKUBd1GkTVWB40NdhN25hwQ56yHgIzauNOkQid2QVpkDF6HcRHlQaABM/4jzllnHusjBy4YPr6WmNWBwroZOpx7vcOkToMXrM+33+FicjsDLPpjAtGy92nGUnAkqy+or6B4vBMzlgiTkCZDIiPlagupZmUPZoMf+VOe5ocvtFWV2NwuQ/g0UI/nSUruIu+d5t/uFa1JcpyBTdPsy3q9QFYcYV5gq/9IefqXU50pzucuhUSq29L/itAHb2t6ltaCmSOqfVQt81NoUQpZ5O5s9JnrFMpATn2eY02WXB2/tTxHOCqlTBQuneztBBcX8nGMp/mnZktch9hadE3Fye02CaZ+/zD/TEjlSewIh2A+rfkBxe3LBcfP0AqBw7xlvPxhSX1skTBb2ULH62J3zh1l3lIq7hOevGtTLwomB3NX7xndtYw+7HHd8Nk+a6UqzbqNNu3yzEf6K4bVzRKaivonLetoMbRaCgGlPnqEk4V9w5blCHTXRt1WqEVdtSRNKZsnhxRP4gNK1I5eThIMitysS9ryStK656hWC9wd+fbrkt1ieJwadeOk1VkTndyWtV02JqtzDMdxmZXK/kqaxdS9+gyfdhC59WWH74c3GnDMpZ3sfa1I+n3oPLPXOFSxTNHo+K7wmHHSTxou56aBX/dXARwFTFE/aSDNDLZZXHb4YXRd5MZDQhjc/rgpVso/0PVclPBXUi7R5H8hT8vo1iKMpUhFRKxOe1zHI5GipJlx0OlFM7qO33zuVEupXUrCRecQcWNA5dxb3eYBPAWjuYVGABp6fGn++a4nD6oC3GdjrLA59bleV1OLp9ilK9jTvqrcXjNJ6e/fUjZX7j/hLfP730/NcU/eMdc73UOClICIaYGTVBbEWRuC0vGl3Nz/2w0SLeQY2ZHcweRDkQL0pxRWxCI5R3FOMjqsQsbx67I0kvfjnI9UMa4ryjSaXZkpZ9W/XiQWlmsTNueD3C4HxLNKuyK314Hj7wW0y8D5D/a7Tsx8fY+5Be2kFDVczqtd0zWaeFG5QpF3VT9+04/5W+m921s3KSkxlPfy4/gZvfecM94jwA5Z6BnR0L72yMIueyI6D4/mO+f5YiAHxwqKaHUJnVaddvy40adHm1Vnx7qqvs/sG9knj7oKs0Vxc3u8+uqW5Mft7qmP267Zj/usJZ+3K3OJtOEOzrQ+aDEFWgcY8gp8LhsSHsDmBfCTXXSR+vb4O4PPYNR9Ht1Uz/sr4+TIAV1GCaGEfZoFIMSf2jjiBBQ3KjxYHDEpSnGdUgnndUxu6K6AGWmOSo6ioiqHZUITyYkiBlr3nbJBJapJppCNIXo3kq1S6Kas6EJpV1lR6RG5X8WTvdz3jOKf9GPc9wLcS7InC40DsYFKqYpkMDCrfbjJ/oUzrReQT0nciRcFLJ1IjtsfkasvKvE9CfEeaS4H+/ee/Aei08Ko90ETSnhdv76MdH/D36eUO0PTx6zcQx36qS9Gjr//T+ceYtRpyyfMcnIl1U2JaOkZ7fqZcEPqnIUOoocJY6mOKogSoj2WDQlbK9j8RSn8hdRBV/+wkcWO/5RM57J9ud3VgcZ6wrV2m7WNdF25WjKf25lpoCkKzDRiBLohFhS8MP8c1BthSuJkjCHRVwnLyZxJXAUL6fSbzefpOGYoQiECkPIcUW5ahdtR+3mPmAGRn2x262GdnHPFcsoRIfKYQG80+e9iXz7plFVvqoMsvyEAYJKEtzqb1PsJGM7yT5PucrqCOJsakhBuVWWNuRJ1pLZ6T8fVS1aybyDseRkjNXt01KlKEbUs4SCuU/9zQW5Hu2goGDtOobZLMmZXSqFI6u46WfS2u4GqEyMHDkmyKUZuP2Is+dAls3XYf4fubBzkaOLF/3TPNbT6EdHrkPKxW/MlCdZTdg+OsKr9mLOk2eR7s9cOrd7fFlk31pa0pjC2LmCPrnc2dB+CeJvwfky7q5A+lpTcBUPFDZn/uuPwfClMRYs7/a2lWUvY5PziG+N4SmlLX70d6JT/nPsnWKb+0F2RQsa+3TUlCJ1n1scUbbTKB6YGjUJ9+DSqqzZHUo1IsK117KH++LwdvBJPV80ylkRQnJO4pclia/gcuNyA61fwlpaE8IJD4+iLBd/qPoUPlaRV2ogmW1JSgG2Fjl5r+oi/ebD/lhDdQ6/n/Tzmfjvzc/rqD8DR+o2fj+JNFT8/vr2v4V5Lrb/1MlWppIvd0aZxQcqfXew6VlQpIyBO3dxm1X0wOKyhSNQEVadgIwSgQ76ZNj9Jl9B4ajmgebeqFlGfSAreRqRTGaJzoh8aVz7ZbGhOimL96cru4XXc4iU6sT56+n/Tv3JBzp9iBxhhq6VtxSPWy/MaRmm8BjJ+auFEg9dmM+CrC6KRf1Lhwcxp2brfNpOQvacGIWBzNwY2xXcpgWJSfUPZNP9s+IvnhOjo4fwHYbt8GiBO8CrTAMnUbx9IcJRBNV8/DLEVFx03CCyI7Mhmi9Z0PI/IDcF/wKrK0CtU7hgmmT7PcLYWS9vbILr3/hiEkbkLuendIY9PlExUGU0Mgc6Wn5mjfZffzmZdXQ5/p4JW+N6naH/eoHuoEgOaG6Gt3UUgXFQPLu5ci5YiLqDoDGTsce/EqDPLEIxVvfjeMxVp1Oveh/s6XVaBB56Hcv4cD2NnfYZokBszxz2/29yP4gJHZmADolqlKnAL2o0IsNh5UWqL5SncutqfvOGWjMqg0rCbiksrfsNttVni7VkxgAPfFm0pjigM9y4ivHGlKl+/KIDILFgI6uF6vaRMN7RB8sZjQCWUJ1n/icn43kAxtuCuaa8oiumtxv8vXxSxprFmH/m52+T9a18QsNf86WIH97CghopA5NGiJ+C4oWjgt4mYdhXvU2fqKXDqHU/XPapngriGJzmoXRYOLje6CTG1nW/ienV4xJ7yzTnrsPsF8lyLKdB8sPKf+YOgecxPWOq5UN6vR5WNdocqFvHlazVNNEvx1RdhFpdUaJjkmnllEOelER/uWNoVlbrAbDH7RMp0zuI/gxSMxEe6uIXqq2kwU5qnJbw3sTURgSWlTk9lzB/fgi68tauJXcsMr4KRPjmUkX2NyayerYE0K7E1h5Rxt/Bfy1dpoCOg+hPPx21Add/Dul/9wBQbZmdnRr2FHF9nUFasr0netCLtZG7Jml8K0YB5B4XvmI+/YV/TO/cZIaZMlM/v/kreoJU72ElWPDjfzSJ56H/RFpd/NGu2Wezf86b/5woP5nkVrBO+WcppVPLHJeoVZR0wNuKV79mk5fZzX4a+hOg8+7mPulPtUnLJ0HS2EQX1NcphrjxCQ9xkcOkXB9Ot3+iqZ54swo/auFMKZxYBcdSj8YL6LQkH7y6tXe0L3Nz7acYSLc6f3TuIh23z7U3QvOF5LdNF1bS3WuYBO11v0/ApkBLbjs2Ew73SZL7lSMnHDQJv37Nrk4MQKHo86pZrvbJhLjMSwqcCruYnHRhR/6aN+/vE7v5X45reUrwEQ7bJ33Y3n/YeC7F9050dahL0w/dfTJ/0K6ZVRzOMSVFeuL7dq6Hw5Vj/+K1HrZScJWH0MNWCr6/63rYSsF18kAPWxFwlXEe2QWIs8DKa5PcEvOuwUmIVEh8XZoePcco1GN/UFtpv7xXOnpcXcE5LP9UV1X0cDjP7851nEIPmydcsUH0sHnC98NfD5snXKU/9LB5whX+Qw+bJ1xxVvSw+RFr9cmdXXPNZ/RBkGWABKUf7GokSZOazM1lQMVGrSEDJGzM/E1pLjWWAF+bzM1nKhAkshESrzAzSRrZtDVk6E4kIyfEWLMc2qjRaZXErs49a8/ZPvt3U0J3UiMlSZ3z72fCOorAjFhu1broNi+23X2t7FcHy8Oy/lz7b3VQl5A+qKW1adH8G8vFYuorhwXfLw1jav5CVU1qf5I5w9PX/v7q4XndxHW048lQO2v/bwTnvtGSUhSEg3bvQJnb0NG8r9e7FsVpaGRrVFk5k9TMSqcDPMCmmOh2eyiKX9Nuk91+3IZM/kvsdD30SBvZI28QuwMTXy5vBm6mQadFkNmLre/rF4mbSGCvnxfe1zZzABUbaz+Fs326yJjjjHyCU1+9K54q+LIC2Mg0hUu4z06ngzz0zus1DN31CeYgVTTA6zW06G9KLnErUEGBPlnE+6gFaj4e44fUTCknGbu62+otw3ApSYkOErcgdldYjydRNFR1Jqwzb4w5MbcHbEHOAmOGvLz8GnW0aV52EJCwh3ZuKPYWESarpmR35RhzEhTug8SdyvYS2/idAFczR9Zp4Y7i2FZk9hpnTkriJ8IY2KOiFvH+/ob04c8rT3Fx8A4Uy368t+OU78qIGQ7uA2Vgpc+UMfjiKZ394RU+F2pTH9eLXLtpF9a8TBNHkR5qjz627DQObsymkyZnHBzZcQNJEmY4uC9IMzbD5guSjM2wecOPk4gZNn/2v782w+YKbtuD45lLENUJcbdfPF1yRN+WTrv7GqIW6VrgplhucbsLDdWlHTMcvKRTrm4qZtjKgRw0M2wFwU4M2CgGUp3tUPCCILvQDFs5kNtmhq0M4BzMtWALsnQJkNd4WVgxHNCoBVu8WaCF3FQGMne/gY7ridczd1a0isMKeKV0U6r+IEcDZVruWeewIIShKnZH+kce5vcO80c+LO89LAd2R2Cq5AUalUNJLpVUlUaIHmjDJQ7JZTfNnJTE+/UHUkKn7mgSkGEuC8NRrGVf4IRqII8LHMULrq5CLrB5gKNRwoHjEbC5VO6QPVz3eSXhsCVulheiP70mJOeQ13oxlHJjSkshV4QiFzhKEYfIR7fDVgKuHUAusBUB5W7skDmDFTs0j/oqP3yPCS22VjTD/Tcxlq95oy95w1tK7aWWcnu5pdJiaUmbVCy1Fv4MzbL4trRNWk2NpKTprWIr2CrPnV1fHlx4yi9I+br9hMo2O+W63ahTDKA623l4ys5WuoAUm3UQVBjI2NaDxwYhJj7Qd08JW1wl4auKp7xg/DFAlapOm/kx2PFJzoItRIXpjmhws50JunwnpGHc0YS6qvs68WKn8feK9qD4EeO6B/0StGulJs+ClrlWbuqg8tb0Wq3ZUPNKbntAVbCss5SmoZb2F6L6W116q5TJpwBgJgz/o38Chmqq788x0eXDmbOx1DKZtt2uUWXKwD4r39idVCetVBiNma+B3xoFAYOPfETurVqdHWowOt4F3u4KrzFeDy7Xu/E19nXtejY5lbWns5lTs/Z8Nntq117O5ppHM1hyYGUah619x94GPlLfDdxCuJ6NNGQvV7yS/R2Wvgunts67uKeriVhYEE7bYdcAxgrxz1DNmkjnipRAw6ZgjKCS3ANvIPv66HElYrVLSLgRy0uC0+O8GidF/8WRtANK+wen9IEQ6GNPdrj7m5iGiPegY4j2/pluXRHlWVjd9hbZpGEOslfHuAvTLuh2T9EJ0e3BzMY4w3A3LJWRa99HRopS8giBkojjtbZM7kYwiiINL5KUEIKn+FQZzhfQWo5Cae1GLebm24ShskRnwziq8PkChCh3IZIOcAm0XfLZMN6xVmCL6ZZsP6xILDVgaP8s+FLnsu5lT7pnbH1fym4M62Sh7bFkB2FMgPgLL2zTUzjh4XSCtoDZ7xrea6rTny/xz8Fm3eenVH3CGBEHkEZ4ERsruntdk8yl2+swH5egy9LkmK22DxE+w23rEb5isESpCIqZLo5OFCEhtYydUCRiaaq5e0Ixszrt9Lqvq1aMxrNIm0T2tq/sBzGnXW2LfiKaradWBwuUKiZVlE96nPRIo2la7oTb9IPfK3alKEgnYNLYf8hvM0luTSRxUnbDl9yNJDzKbvjibHRxi4q79vkprU910RQ6SjjlWeQLYDHHI6cFJblBdsMk+6KhJCXIbviyL40stc9u+DIXBlcxRCpPFJZEoQ52wmoyIzETht2XiQCIcyJIZhDGvY7g1LXHdM2GyR3hqWOP1GfBNUHtJ8VoBmUWiwf8kVc1Fxmf4PQ4l32Edu20zLVzTch+jAOeUvXWK9I5MT9JV75M5w9tJk3AwYt+HGzjiCHEk2LiV1zcenXT0vQPU1hKbN+jhBvuIFW2kG/zmwG+sghhITWwx6YBCBmyWcSSRKE4XkLVrMb8dcN48WHJklgnbLd82LjsANhCDWrhBrdIQxK9HKdn4+hIAU39DTKfhxftfMXnhMQipRAPZcSCx59Qkhmb6BUfWvK+y5gXmBV1g9XZp3GiLTFe1zxK1t9cxwCpNxii10X5llHW0l9hbH2Os3zxlMLLkBKqmjqesjbAKxQKi8gf23v+bTfGdiHuYFSoP4XKQu5uJBqZshyS7lR4p6O7ofGzcum5+3Puz9zJFuG2Sciv2fpF4xdtVPO80se9WLgyC4lF6xS9V3SVYgj8ys+5/TmYps+41gX+p1u/6FsEftHZxDx9zuqKN+O/TFAqur2CRUVxqhcO/UJ+YW59f+TMWvYQ72rhrExYlaBL0CUoFoNSLCgT7hs16ReDVq/8VPrE8//zbN6P8t8/T5/w6YNm+n0MG+au3uqHx5OqHyoK+ed+89e+bIqCf/awmr2me8BugJXtA/jSLGLKu2IU0rDp2ckhWUt3MjmSIkY2qUPTIDmLrU0q4Q3AiGb4yzDd002VXYsLoqhfMhnhxBqQwURqfWWnqCBp/UsiJJmVYIIam29OrkXd+Rdx/x+BxdXim4QzXbwkyHaxPS77INqcyweIhpgbJT8sRj/Ouf4ZECslXXACh4UgQCmp267fnpj+cyjS0W3LMB2nziqpCw9lJ/JMip/3BgPWifc72/oJxjGcbuYv9bn263m71XGPtmYvxxGRZwMFF+k9IB9mzn0q7faMW1xr87/QHNO95abQGNNtj7SC2vg2IDBM9/wIO5nfoI4dGv0ZvQurLVHnNjfxYyfmL8s+ajOWJaSLjdlzd0GI68WfLjhbmRvE/qT0Tdmu6FRiCH8FmQVVAbTn8At2uTUT3SixQPW3CMp76CSEDwGB32xg5Q/AyBaURFO4L/bRmqwuy7KyqD6Pnnv1ozK0z0jMMaJfCOsKdfLokkIjhyb0cA93SWKRo2F2FOVvePsmGUPvhE6uK0s4UdGzK78+/a+TX7xurkCpJUSz18ktaFsFCr22+MMHIet3GGJNiXf1K2FapC+7OSOd1MVI6GeLEc5czm+9pJjFXkx8+NV2aMCrsdEWG+uLRI/zJWgH", "base64")).toString();
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
