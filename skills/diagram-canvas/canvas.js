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
