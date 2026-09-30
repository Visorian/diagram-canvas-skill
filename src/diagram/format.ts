import { applyNoteOp, type Note, type NoteOp } from "./notes.ts";

// Line format, one statement per line:
//   id: Label [kind]         node, kind defaults to "service"
//   source -> target: Label  edge between nodes or groups, label optional; unknown ids become nodes
//   source => target: Label  animated edge
//                            the same pair again is a parallel edge, a node to itself a loop
//   [[id: Label]]            outer group of the nodes and groups below it, up to the next outer one
//   [id: Label]              group of the nodes below it, up to the next group; label optional
//   # layout: architecture   placed by the groups rather than along the edges, see layout.ts
//   # layout: sequence       nodes as columns and the edges as rows in file order
//   # tag: name #rrggbb      question tag, see notes.ts
//   # comment
export const kinds = ["service", "db", "queue", "ext", "ui"] as const;
export type Kind = (typeof kinds)[number];

export const layoutKinds = ["flow", "architecture", "sequence"] as const;
export type LayoutKind = (typeof layoutKinds)[number];

export interface DiagramNode {
  id: string;
  label: string;
  kind: Kind;
  // Comes from the group line above the node; nodes above the first group have none.
  group?: string;
}

export interface DiagramEdge {
  source: string;
  target: string;
  label: string;
  animated?: boolean;
  // Parallel edges, from the same source to the same target, count up from 2 in file order.
  ordinal?: number;
}

// An outer group holds its own nodes and the groups below it; `parent` is the outer group of a group.
export interface DiagramGroup {
  id: string;
  label: string;
  outer?: boolean;
  parent?: string;
}

export interface Diagram {
  layout: LayoutKind;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  groups: DiagramGroup[];
  tags: QuestionTag[];
  errors: string[];
}

export interface QuestionTag {
  name: string;
  color: string;
}

export type Position = [x: number, y: number];
export type Layout = Record<string, Position>;

// Everything stored for one diagram; `marks` are node or edge ids (see `edgeId`). `handoff` is the
// user's message while the diagram waits for the agent, possibly empty.
export interface DiagramState {
  source: string;
  layout: Layout;
  notes: string;
  marks: string[];
  handoff?: string;
}

// A commit that changed a diagram, and the diagram as of one.
export interface Version {
  ref: string;
  date: string;
  subject: string;
}

export interface VersionFiles {
  ref: string;
  source: string;
  layout: Layout;
}

export interface DiagramFiles extends DiagramState {
  name: string;
  // Increases with every state the server sends, so the canvas can skip outdated ones.
  version?: number;
}

// A diagram is stored as `<name><suffix>` files; only the model is required.
export const partSuffixes = [".txt", ".layout.json", ".notes.md", ".marks", ".handoff"] as const;
export type PartSuffix = (typeof partSuffixes)[number];
export const partPattern = /^([\w-]+)(\.txt|\.layout\.json|\.notes\.md|\.marks|\.handoff)$/;

// Names of the diagrams that have a `suffix` part among `files`.
export const partNames = (files: string[], suffix: PartSuffix) =>
  files.flatMap((file) => {
    const match = partPattern.exec(file);
    return match?.[1] && match[2] === suffix ? [match[1]] : [];
  });

export type Op =
  | { type: "upsert-node"; node: DiagramNode; position?: Position }
  | { type: "remove-node"; id: string }
  | { type: "upsert-edge"; edge: DiagramEdge }
  | { type: "remove-edge"; source: string; target: string; ordinal?: number }
  | { type: "move"; id: string; position: Position }
  | { type: "reset-layout" }
  | { type: "mark"; target: string; marked: boolean }
  | { type: "clear-marks" }
  // Without `text` it takes the handoff back.
  | { type: "handoff"; text?: string }
  | NoteOp;

type Line =
  | { type: "node"; node: DiagramNode }
  | { type: "edge"; edge: DiagramEdge }
  | { type: "group"; group: DiagramGroup }
  | { type: "other"; text: string };

const idPattern = String.raw`[\w-]+`;
const edgePattern = new RegExp(
  String.raw`^(${idPattern})\s*(->|=>)\s*(${idPattern})\s*(?::\s*(.*))?$`,
);
const nodePattern = new RegExp(String.raw`^(${idPattern})\s*:\s*(.*?)\s*(?:\[(\w+)\])?$`);
const groupPattern = new RegExp(String.raw`^\[\s*(${idPattern})\s*(?::\s*(.*?))?\s*\]$`);
const outerGroupPattern = new RegExp(String.raw`^\[\[\s*(${idPattern})\s*(?::\s*(.*?))?\s*\]\]$`);
const tagPattern = /^# tag: ([\w-]+) (#[\da-fA-F]{6})$/;
const layoutPattern = new RegExp(`^# layout: (${layoutKinds.join("|")})$`);

// `source->target`, and `source->target#2` and so on for parallel edges.
export const edgeId = ({
  source,
  target,
  ordinal,
}: Pick<DiagramEdge, "source" | "target" | "ordinal">) =>
  `${source}->${target}${ordinal !== undefined && ordinal > 1 ? `#${ordinal}` : ""}`;

// The model line of a node or edge; a node's group is the group line above it.
export const nodeStatement = ({ id, label, kind }: DiagramNode) =>
  `${id}: ${label}${kind === "service" ? "" : ` [${kind}]`}`;
export const edgeStatement = ({ source, target, label, animated }: DiagramEdge) =>
  `${source} ${animated ? "=>" : "->"} ${target}${label ? `: ${label}` : ""}`;

export function isKind(value: string): value is Kind {
  return (kinds as readonly string[]).includes(value);
}

function parseLine(text: string, lineNumber: number, errors: string[]): Line {
  const trimmed = text.trim();
  if (trimmed.startsWith("# tag:") && !tagPattern.test(trimmed)) {
    errors.push(`line ${lineNumber}: invalid tag definition`);
  }
  if (trimmed.startsWith("# layout:") && !layoutPattern.test(trimmed)) {
    errors.push(`line ${lineNumber}: unknown layout, use flow, architecture or sequence`);
  }
  if (trimmed === "" || trimmed.startsWith("#")) return { type: "other", text };
  const edge = edgePattern.exec(trimmed);
  if (edge?.[1] && edge[3]) {
    const [, source, arrow, target, label = ""] = edge;
    return {
      type: "edge",
      edge: { source, target, label, ...(arrow === "=>" && { animated: true }) },
    };
  }
  const outer = outerGroupPattern.exec(trimmed);
  if (outer?.[1]) {
    return { type: "group", group: { id: outer[1], label: outer[2] || outer[1], outer: true } };
  }
  const group = groupPattern.exec(trimmed);
  if (group?.[1]) return { type: "group", group: { id: group[1], label: group[2] || group[1] } };
  const node = nodePattern.exec(trimmed);
  if (node?.[1]) {
    const kind = node[3] ?? "service";
    if (!isKind(kind)) errors.push(`line ${lineNumber}: unknown kind "${kind}"`);
    const label = node[2] || node[1];
    return { type: "node", node: { id: node[1], label, kind: isKind(kind) ? kind : "service" } };
  }
  errors.push(`line ${lineNumber}: cannot parse "${trimmed}"`);
  return { type: "other", text };
}

function parseLines(source: string, errors: string[] = []) {
  return source
    .replace(/\n$/, "")
    .split("\n")
    .map((text, index) => parseLine(text, index + 1, errors));
}

function serializeLine(line: Line) {
  if (line.type === "other") return line.text;
  if (line.type === "edge") return edgeStatement(line.edge);
  if (line.type === "node") return nodeStatement(line.node);
  const { id, label, outer } = line.group;
  const inside = label === id ? id : `${id}: ${label}`;
  return outer ? `[[${inside}]]` : `[${inside}]`;
}

export function parseDiagram(source: string): Diagram {
  const errors: string[] = [];
  const nodes = new Map<string, DiagramNode>();
  const edges = new Map<string, DiagramEdge>();
  const groups = new Map<string, DiagramGroup>();
  const tags = new Map<string, QuestionTag>();
  // Edges so far per source and target.
  const parallels = new Map<string, number>();
  let layout: LayoutKind = "flow";
  let outer: string | undefined;
  let group: string | undefined;
  for (const line of parseLines(source, errors)) {
    if (line.type === "group") {
      const { id } = line.group;
      if (groups.has(id)) errors.push(`duplicate group "${id}"`);
      if (line.group.outer) outer = id;
      groups.set(
        id,
        line.group.outer || outer === undefined ? line.group : { ...line.group, parent: outer },
      );
      group = id;
    } else if (line.type === "node") {
      if (nodes.has(line.node.id)) errors.push(`duplicate node "${line.node.id}"`);
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
      if (known) layout = known;
      const [, name, color] = tagPattern.exec(line.text.trim()) ?? [];
      if (!name || !color) continue;
      if (tags.has(name)) errors.push(`duplicate tag "${name}"`);
      tags.set(name, { name, color });
    }
  }
  for (const id of groups.keys()) {
    if (nodes.has(id)) errors.push(`"${id}" is both a node and a group`);
  }
  for (const edge of edges.values()) {
    for (const id of [edge.source, edge.target]) {
      if (!nodes.has(id) && !groups.has(id)) nodes.set(id, { id, label: id, kind: "service" });
    }
  }
  return {
    layout,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    groups: [...groups.values()],
    tags: [...tags.values()],
    errors,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown) =>
  typeof value === "string" && new RegExp(`^${idPattern}$`).test(value);
const isTarget = (value: unknown) =>
  typeof value === "string" &&
  new RegExp(`^${idPattern}(?:->${idPattern}(?:#\\d+)?)?$`).test(value);
const isOrdinal = (value: unknown) =>
  value === undefined || (typeof value === "number" && Number.isInteger(value) && value >= 1);
// Newlines would inject extra statements into the file.
const isText = (value: unknown) => typeof value === "string" && !/[\r\n]/.test(value);
const isPosition = (value: unknown): value is Position =>
  Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === "number");

export const isLayout = (value: unknown): value is Layout =>
  isRecord(value) && Object.values(value).every(isPosition);

export function toDiagramFiles(
  name: string,
  parts: Partial<Record<PartSuffix, string | undefined>>,
): DiagramFiles {
  let layout: unknown = {};
  try {
    layout = JSON.parse(parts[".layout.json"] ?? "{}");
  } catch {
    // A broken layout only loses pinned positions; auto layout still places everything.
  }
  return {
    name,
    source: parts[".txt"] ?? "",
    layout: isLayout(layout) ? layout : {},
    notes: parts[".notes.md"] ?? "",
    marks: (parts[".marks"] ?? "")
      .split("\n")
      .map((mark) => mark.trim())
      .filter((mark) => mark !== ""),
    ...(parts[".handoff"] !== undefined && { handoff: parts[".handoff"].trim() }),
  };
}

export const isDiagramFiles = (value: unknown): value is DiagramFiles =>
  isRecord(value) &&
  typeof value.name === "string" &&
  typeof value.source === "string" &&
  typeof value.notes === "string" &&
  Array.isArray(value.marks) &&
  value.marks.every(isTarget) &&
  isLayout(value.layout) &&
  (value.version === undefined || typeof value.version === "number") &&
  (value.handoff === undefined || typeof value.handoff === "string");

export const isVersions = (value: unknown): value is Version[] =>
  Array.isArray(value) &&
  value.every(
    (version) =>
      isRecord(version) &&
      typeof version.ref === "string" &&
      typeof version.date === "string" &&
      typeof version.subject === "string",
  );

export const isVersionFiles = (value: unknown): value is VersionFiles =>
  isRecord(value) &&
  typeof value.ref === "string" &&
  typeof value.source === "string" &&
  isLayout(value.layout);

const isEntryText = (value: unknown) =>
  isText(value) && typeof value === "string" && value.trim() !== "";

const isNote = (value: unknown): value is Note => {
  if (!isRecord(value) || (value.kind !== "note" && value.kind !== "question")) return false;
  const question = value.kind === "question";
  return (
    (value.target === undefined || isTarget(value.target)) &&
    isEntryText(value.text) &&
    (value.tag === undefined || (question && isId(value.tag))) &&
    (value.forUser === undefined || (question && value.forUser === true)) &&
    (value.answer === undefined || (question && isEntryText(value.answer))) &&
    typeof value.done === "boolean"
  );
};

function isOp(value: unknown): value is Op {
  if (!isRecord(value)) return false;
  const { node, edge } = value;
  switch (value.type) {
    case "upsert-node":
      return (
        isRecord(node) &&
        isId(node.id) &&
        isText(node.label) &&
        typeof node.kind === "string" &&
        isKind(node.kind) &&
        (node.group === undefined || isId(node.group)) &&
        (value.position === undefined || isPosition(value.position))
      );
    case "upsert-edge":
      return (
        isRecord(edge) &&
        isId(edge.source) &&
        isId(edge.target) &&
        isText(edge.label) &&
        (edge.animated === undefined || typeof edge.animated === "boolean") &&
        isOrdinal(edge.ordinal)
      );
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

export const isOps = (value: unknown): value is Op[] => Array.isArray(value) && value.every(isOp);

// Applies canvas edits as line changes so comments, order and untouched lines stay as written.
export function applyOps(state: DiagramState, ops: Op[]): DiagramState {
  let lines = parseLines(state.source);
  let nextLayout = { ...state.layout };
  let { notes } = state;
  let marks = new Set(state.marks);
  let { handoff } = state;
  const lastIndex = (type: Line["type"]) => lines.findLastIndex((line) => line.type === type);
  const insertAfterLast = (type: Line["type"], line: Line) => {
    const index = lastIndex(type);
    lines.splice(index === -1 ? lines.length : index + 1, 0, line);
  };
  // The line of the edge with this source, target and ordinal.
  const edgeLine = ({
    source,
    target,
    ordinal = 1,
  }: Pick<DiagramEdge, "source" | "target" | "ordinal">) => {
    let seen = 0;
    return lines.findIndex(
      (line) =>
        line.type === "edge" &&
        line.edge.source === source &&
        line.edge.target === target &&
        ++seen === ordinal,
    );
  };
  const groupAt = (index: number) => {
    let group: string | undefined;
    for (const line of lines.slice(0, index)) if (line.type === "group") group = line.group.id;
    return group;
  };
  // A node goes below the last node of its group, or right below the group line. Nodes without a
  // group stay above the first group. A group without a line gets one at the end.
  const insertNode = (node: DiagramNode) => {
    let group: string | undefined;
    let at: number | undefined;
    lines.forEach((line, index) => {
      if (line.type === "group") group = line.group.id;
      if (line.type !== "other" && line.type !== "edge" && group === node.group) at = index + 1;
    });
    if (at === undefined && node.group === undefined) {
      const first = lines.findIndex((line) => line.type === "group");
      at = first === -1 ? lines.length : first;
    } else if (at === undefined && node.group !== undefined) {
      const last = lines.at(-1);
      if (!(last?.type === "other" && last.text === "")) lines.push({ type: "other", text: "" });
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
        // A node moved to another group leaves its old place, so the layout puts it in the new one.
        if (index !== -1) {
          lines.splice(index, 1);
          delete nextLayout[op.node.id];
        }
        insertNode(op.node);
      }
      if (op.position) nextLayout[op.node.id] = op.position;
    } else if (op.type === "remove-node") {
      const touches = (edge: DiagramEdge) => edge.source === op.id || edge.target === op.id;
      for (const line of lines) {
        if (line.type === "edge" && touches(line.edge)) marks.delete(edgeId(line.edge));
      }
      lines = lines.filter(
        (line) =>
          !(line.type === "node" && line.node.id === op.id) &&
          !(line.type === "edge" && touches(line.edge)),
      );
      delete nextLayout[op.id];
      marks.delete(op.id);
    } else if (op.type === "upsert-edge") {
      // The ordinal is where the edge is in the file, so the line doesn't keep it.
      const { ordinal, ...edge } = op.edge;
      const index = edgeLine({ ...edge, ordinal });
      if (index === -1) insertAfterLast("edge", { type: "edge", edge });
      else lines[index] = { type: "edge", edge };
    } else if (op.type === "remove-edge") {
      const index = edgeLine(op);
      if (index !== -1) lines.splice(index, 1);
      marks.delete(edgeId(op));
    } else if (op.type === "move") {
      nextLayout[op.id] = op.position;
    } else if (op.type === "reset-layout") {
      nextLayout = {};
    } else if (op.type === "mark") {
      if (op.marked) marks.add(op.target);
      else marks.delete(op.target);
    } else if (op.type === "clear-marks") {
      marks = new Set();
    } else if (op.type === "handoff") {
      handoff = op.text?.trim();
    } else {
      notes = applyNoteOp(notes, op);
    }
  }
  return {
    source: `${lines.map(serializeLine).join("\n")}\n`,
    layout: nextLayout,
    notes,
    marks: [...marks],
    ...(handoff !== undefined && { handoff }),
  };
}
