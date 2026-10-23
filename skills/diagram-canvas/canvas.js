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
var page = () => brotliDecompressSync(Buffer.from("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", "base64")).toString();
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
