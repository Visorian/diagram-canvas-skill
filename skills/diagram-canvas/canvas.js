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
function architectureGrid(diagram) {
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
  const grid = table(Array.from({ length: columnCount }, () => nodeSize.width), Array.from({ length: rowCount }, () => nodeSize.height), spans, { vertical: 48, horizontal: 64, bottom: 32 });
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
var colors = { added: "#40c1ac", changed: "#908cfe", removed: "#f6459d" };
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
  if (!diagram.nodes.length)
    throw new Error("Cannot export an empty diagram.");
  const changes = comparison ? comparison.changes : new Map;
  const auto = autoLayout(diagram);
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
    return `<g>${title(id, group.label)}<defs><clipPath id="group-label-${id}"><rect x="${box.x + 16}" y="${box.y}" width="${box.width - 32}" height="40"/></clipPath></defs><rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="12" fill="#0a0719" stroke="${change ? colors[change] : "#262437"}"/><text x="${box.x + 16}" y="${box.y + 26}" class="group-label" clip-path="url(#group-label-${id})">${escape(group.label)}</text></g>`;
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
  const sequenceChanges = [];
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
    const sequenceChange = diagram.layout === "sequence" ? change : undefined;
    if (sequenceChange === "changed") {
      const previous = baseDiagram?.edges.find((candidate) => edgeId(candidate) === id);
      if (previous && previous.label !== edge.label)
        sequenceChanges.push({ id, step: index + 1, before: previous.label, after: edge.label });
    }
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
    const color = change ? colors[change] : sequence ? "#64748b" : animated ? "#529aff" : "#64748b";
    const path = points.map(([x, y], i) => `${i ? "L" : "M"}${number(x)},${number(y)}`).join(" ");
    if (edge.label)
      labels.push(`<g>${title(id, edge.label)}${sequence || ly === routeY ? "" : `<path d="M${number(lx)},${number(routeY)} V${number(ly)}" stroke="#334155"/>`}<rect data-label="${escape(id)}" x="${number(labelX - width / 2)}" y="${number(ly - labelHeight / 2)}" width="${width}" height="${labelHeight}" rx="4" fill="${sequence ? "none" : "#020617"}"/><text x="${number(sequence && edge.source === edge.target ? labelX - width / 2 + 6 : labelX)}" y="${number(ly + 4)}" class="edge-label${sequence && edge.source === edge.target ? " loop-label" : ""}${sequenceChange ? ` ${sequenceChange}` : ""}">${escape(label)}</text></g>`);
    if (sequence) {
      const gutterX = Math.min(...nodeBoxes.map((box) => box.x)) - 22;
      labels.push(`<text data-step="${escape(id)}" x="${gutterX}" y="${routeY + 4}" class="step-number" fill="${change ? colors[change] : "#64748b"}">${index + 1}</text>`);
      boxes.push({ x: gutterX - 14, y: routeY - 10, width: 24, height: 20 });
    }
    const flow = animated ? diagram.layout === "sequence" ? sequenceTrail(path, points, change ? color : "#93c5fd", activeEdges.indexOf(edge), activeEdges.length) : dottedFlow(path, color) : "";
    return `<g>${title(id, `${edge.source} → ${edge.target}: ${edge.label}`)}<defs><marker id="arrow-${index}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 Z" fill="${color}"/></marker></defs><path data-edge="${escape(id)}" d="${path}" fill="none" stroke="${color}" stroke-width="1.5" marker-end="url(#arrow-${index})"${animated ? ` class="flow" stroke-opacity="${sequence ? "0.8" : "0.25"}"` : change === "removed" ? ' stroke-dasharray="5 4" opacity="0.6"' : ""}/>${flow}</g>`;
  });
  const nodes = diagram.nodes.map((node) => {
    const [x, y] = auto.positions[node.id];
    boxes.push({ x, y, ...nodeSize });
    const kind = kindStyles[node.kind];
    const change = changes.get(node.id);
    const count = sequence ? 0 : notes.filter((note) => note.target === node.id).length;
    const subtitle = [change, kind.tag, count ? `${count} note${count === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
    return `<g>${title(node.id, node.label)}<defs><clipPath id="node-label-${node.id}"><rect x="${x + 42}" y="${y}" width="${nodeSize.width - 52}" height="${nodeSize.height}"/></clipPath></defs><rect data-node="${node.id}" x="${x}" y="${y}" width="${nodeSize.width}" height="${nodeSize.height}" rx="8" fill="#141029" stroke="${change ? colors[change] : "#3e3d4b"}"${kind.dashed || change === "removed" ? ' stroke-dasharray="5 4"' : ""}/><svg x="${x + 12}" y="${y + 18}" width="20" height="20" viewBox="0 0 24 24"><path d="${kind.icon}" fill="none" stroke="#9d9d9d" stroke-width="1.5"/></svg><g clip-path="url(#node-label-${node.id})"><text x="${x + 42}" y="${y + (subtitle ? 25 : 33)}" class="node-label"${change === "removed" ? ' text-decoration="line-through"' : ""}>${escape(node.label)}</text>${subtitle ? `<text x="${x + 42}" y="${y + 43}" class="subtitle" fill="${change ? colors[change] : "#9d9d9d"}">${escape(subtitle)}</text>` : ""}</g></g>`;
  });
  const comparisons = [];
  if (sequence && comparison) {
    const x = Math.min(...nodeBoxes.map((box) => box.x));
    const y = Math.min(...nodeBoxes.map((box) => box.y)) - 24;
    const entries = ["added", "changed", "removed"].flatMap((change) => {
      const count = drawableEdges.filter((edge) => changes.get(edgeId(edge)) === change).length;
      return count ? [{ change, label: `${count} ${change}` }] : [];
    });
    let legendX = x;
    for (const { change, label } of entries) {
      comparisons.push(`<path d="M${legendX},${y - 4} h20" stroke="${colors[change]}" stroke-width="2"${change === "removed" ? ' stroke-dasharray="5 4"' : ""}/><text x="${legendX + 28}" y="${y}" class="legend-label">${escape(label)}</text>`);
      legendX += labelWidth(label) + 56;
    }
    if (entries.length)
      boxes.push({ x, y: y - 14, width: legendX - x, height: 20 });
    if (sequenceChanges.length) {
      const top = Math.max(...boxes.map((box) => box.y + box.height)) + 28;
      const beforeX = x + 52;
      const afterX = beforeX + Math.max(180, ...sequenceChanges.map(({ before }) => labelWidth(before))) + 36;
      const width = Math.max(...nodeBoxes.map((box) => box.x + box.width - x), ...sequenceChanges.map(({ after }) => afterX - x + labelWidth(after)));
      comparisons.push(`<path d="M${x},${top} h${width}" stroke="#262437"/><text x="${x}" y="${top + 28}" class="comparison-title">Changed operations</text><text x="${x}" y="${top + 54}" class="legend-label">Step</text><text x="${beforeX}" y="${top + 54}" class="legend-label">Before</text><text x="${afterX}" y="${top + 54}" class="legend-label">Now</text>`);
      sequenceChanges.forEach(({ id, step: operation, before, after }, index) => {
        const rowY = top + 80 + index * 28;
        comparisons.push(`<text x="${x}" y="${rowY}" class="comparison-value" fill="#908cfe">${operation}</text><text data-before="${escape(id)}" x="${beforeX}" y="${rowY}" class="comparison-value" fill="#94a3b8">${escape(before)}</text><text data-after="${escape(id)}" x="${afterX}" y="${rowY}" class="comparison-value" fill="#e2e8f0">${escape(after)}</text>`);
      });
      boxes.push({ x, y: top, width, height: 92 + (sequenceChanges.length - 1) * 28 });
    }
  }
  const left = Math.min(...boxes.map((box) => box.x)) - 32;
  const top = Math.min(...boxes.map((box) => box.y)) - 32;
  const width = number(Math.max(...boxes.map((box) => box.x + box.width)) + 32 - left);
  const height = number(Math.max(...boxes.map((box) => box.y + box.height)) + 32 - top);
  const name = base ? `${current.name} compared with ${base.name}` : current.name;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${number(left)} ${number(top)} ${width} ${height}" role="img" aria-labelledby="diagram-title"><title id="diagram-title">${escape(name)}</title><desc>Component relationships and ordered operations. Green indicates additions, violet indicates changes, and pink dashed lines indicate removals. Moving dotted lines trace selected connections.</desc><defs><pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="0.7" fill="#1e293b"/></pattern></defs><style>text{font-family:system-ui,sans-serif}.node-label{font-size:14px;fill:white}.group-label{font-size:13px;font-weight:600;fill:white}.subtitle{font-size:12px}.edge-label{font-size:11px;text-anchor:middle;fill:#cbd5e1}${diagram.layout === "sequence" ? ".loop-label{text-anchor:start}.edge-label.added{fill:#40c1ac}.edge-label.changed{fill:#b2aaff}.edge-label.removed{fill:#f6459d}.step-number{font-size:10px;text-anchor:end}.legend-label{font-size:11px;fill:#94a3b8}.comparison-title{font-size:13px;font-weight:600;fill:#e2e8f0}.comparison-value{font-size:12px}" : ""}@media(prefers-reduced-motion:reduce){.dotted-flow{display:none}.flow{stroke-opacity:1}}</style><rect x="${number(left)}" y="${number(top)}" width="${width}" height="${height}" fill="#020617"/>${sequence ? "" : `<rect x="${number(left)}" y="${number(top)}" width="${width}" height="${height}" fill="url(#grid)"/>`}${[...groups, ...timelines, ...edges, ...nodes, ...labels, ...comparisons].join(`
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
