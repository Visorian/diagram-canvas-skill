import { applyNoteOp, type Note, type NoteOp } from "./notes.ts";

// Line format, one statement per line:
//   id: Label [kind]         node, kind defaults to "service"
//   source -> target: Label  edge, label optional; unknown ids become nodes
//   # tag: name #rrggbb      question tag, see notes.ts
//   # comment
export const kinds = ["service", "db", "queue", "ext", "ui"] as const;
export type Kind = (typeof kinds)[number];

export interface DiagramNode {
  id: string;
  label: string;
  kind: Kind;
}

export interface DiagramEdge {
  source: string;
  target: string;
  label: string;
}

export interface Diagram {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  tags: QuestionTag[];
  errors: string[];
}

export interface QuestionTag {
  name: string;
  color: string;
}

export type Position = [x: number, y: number];
export type Layout = Record<string, Position>;

// Everything stored for one diagram; `marks` are node or edge ids (see `edgeId`).
export interface DiagramState {
  source: string;
  layout: Layout;
  notes: string;
  marks: string[];
}

export interface DiagramFiles extends DiagramState {
  name: string;
}

// A diagram is stored as `<name><suffix>` files; only the model is required.
export const partSuffixes = [".txt", ".layout.json", ".notes.md", ".marks"] as const;
export type PartSuffix = (typeof partSuffixes)[number];
export const partPattern = /^([\w-]+)(\.txt|\.layout\.json|\.notes\.md|\.marks)$/;

export type Op =
  | { type: "upsert-node"; node: DiagramNode; position?: Position }
  | { type: "remove-node"; id: string }
  | { type: "upsert-edge"; edge: DiagramEdge }
  | { type: "remove-edge"; source: string; target: string }
  | { type: "move"; id: string; position: Position }
  | { type: "reset-layout" }
  | { type: "mark"; target: string; marked: boolean }
  | { type: "clear-marks" }
  | NoteOp;

type Line =
  | { type: "node"; node: DiagramNode }
  | { type: "edge"; edge: DiagramEdge }
  | { type: "other"; text: string };

const idPattern = String.raw`[\w-]+`;
const edgePattern = new RegExp(String.raw`^(${idPattern})\s*->\s*(${idPattern})\s*(?::\s*(.*))?$`);
const nodePattern = new RegExp(String.raw`^(${idPattern})\s*:\s*(.*?)\s*(?:\[(\w+)\])?$`);
const tagPattern = /^# tag: ([\w-]+) (#[\da-fA-F]{6})$/;

export const edgeId = (edge: Pick<DiagramEdge, "source" | "target">) =>
  `${edge.source}->${edge.target}`;

export function isKind(value: string): value is Kind {
  return (kinds as readonly string[]).includes(value);
}

function parseLine(text: string, lineNumber: number, errors: string[]): Line {
  const trimmed = text.trim();
  if (trimmed.startsWith("# tag:") && !tagPattern.test(trimmed)) {
    errors.push(`line ${lineNumber}: invalid tag definition`);
  }
  if (trimmed === "" || trimmed.startsWith("#")) return { type: "other", text };
  const edge = edgePattern.exec(trimmed);
  if (edge?.[1] && edge[2]) {
    return { type: "edge", edge: { source: edge[1], target: edge[2], label: edge[3] ?? "" } };
  }
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
  if (line.type === "edge") {
    const { source, target, label } = line.edge;
    return `${source} -> ${target}${label ? `: ${label}` : ""}`;
  }
  const { id, label, kind } = line.node;
  return `${id}: ${label}${kind === "service" ? "" : ` [${kind}]`}`;
}

export function parseDiagram(source: string): Diagram {
  const errors: string[] = [];
  const nodes = new Map<string, DiagramNode>();
  const edges = new Map<string, DiagramEdge>();
  const tags = new Map<string, QuestionTag>();
  for (const line of parseLines(source, errors)) {
    if (line.type === "node") {
      if (nodes.has(line.node.id)) errors.push(`duplicate node "${line.node.id}"`);
      nodes.set(line.node.id, line.node);
    } else if (line.type === "edge") {
      if (edges.has(edgeId(line.edge))) errors.push(`duplicate edge "${edgeId(line.edge)}"`);
      edges.set(edgeId(line.edge), line.edge);
    } else {
      const [, name, color] = tagPattern.exec(line.text.trim()) ?? [];
      if (!name || !color) continue;
      if (tags.has(name)) errors.push(`duplicate tag "${name}"`);
      tags.set(name, { name, color });
    }
  }
  for (const edge of edges.values()) {
    for (const id of [edge.source, edge.target]) {
      if (!nodes.has(id)) nodes.set(id, { id, label: id, kind: "service" });
    }
  }
  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    tags: [...tags.values()],
    errors,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown) =>
  typeof value === "string" && new RegExp(`^${idPattern}$`).test(value);
const isTarget = (value: unknown) =>
  typeof value === "string" && new RegExp(`^${idPattern}(?:->${idPattern})?$`).test(value);
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
  };
}

export const isDiagramFiles = (value: unknown): value is DiagramFiles =>
  isRecord(value) &&
  typeof value.name === "string" &&
  typeof value.source === "string" &&
  typeof value.notes === "string" &&
  Array.isArray(value.marks) &&
  value.marks.every(isTarget) &&
  isLayout(value.layout);

const isNote = (value: unknown): value is Note =>
  isRecord(value) &&
  (value.kind === "note" || value.kind === "question") &&
  (value.target === undefined || isTarget(value.target)) &&
  isText(value.text) &&
  typeof value.text === "string" &&
  value.text.trim() !== "" &&
  (value.tag === undefined || (value.kind === "question" && isId(value.tag))) &&
  typeof value.done === "boolean";

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
        (value.position === undefined || isPosition(value.position))
      );
    case "upsert-edge":
      return isRecord(edge) && isId(edge.source) && isId(edge.target) && isText(edge.label);
    case "remove-node":
      return isId(value.id);
    case "remove-edge":
      return isId(value.source) && isId(value.target);
    case "move":
      return isId(value.id) && isPosition(value.position);
    case "reset-layout":
    case "clear-marks":
      return true;
    case "mark":
      return isTarget(value.target) && typeof value.marked === "boolean";
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
  const lastIndex = (type: Line["type"]) => lines.findLastIndex((line) => line.type === type);
  const insertAfterLast = (type: Line["type"], line: Line) => {
    const index = lastIndex(type);
    lines.splice(index === -1 ? lines.length : index + 1, 0, line);
  };

  for (const op of ops) {
    if (op.type === "upsert-node") {
      const index = lines.findIndex((line) => line.type === "node" && line.node.id === op.node.id);
      if (index === -1) insertAfterLast("node", { type: "node", node: op.node });
      else lines[index] = { type: "node", node: op.node };
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
      const id = edgeId(op.edge);
      const index = lines.findIndex((line) => line.type === "edge" && edgeId(line.edge) === id);
      if (index === -1) insertAfterLast("edge", { type: "edge", edge: op.edge });
      else lines[index] = { type: "edge", edge: op.edge };
    } else if (op.type === "remove-edge") {
      const id = edgeId(op);
      lines = lines.filter((line) => !(line.type === "edge" && edgeId(line.edge) === id));
      marks.delete(id);
    } else if (op.type === "move") {
      nextLayout[op.id] = op.position;
    } else if (op.type === "reset-layout") {
      nextLayout = {};
    } else if (op.type === "mark") {
      if (op.marked) marks.add(op.target);
      else marks.delete(op.target);
    } else if (op.type === "clear-marks") {
      marks = new Set();
    } else {
      notes = applyNoteOp(notes, op);
    }
  }
  return {
    source: `${lines.map(serializeLine).join("\n")}\n`,
    layout: nextLayout,
    notes,
    marks: [...marks],
  };
}
