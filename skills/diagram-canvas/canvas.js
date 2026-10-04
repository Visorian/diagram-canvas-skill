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
