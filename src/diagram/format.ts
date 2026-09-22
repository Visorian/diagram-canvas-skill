// Line format, one statement per line:
//   id: Label [kind]         node, kind defaults to "service"
//   source -> target: Label  edge, label optional; unknown ids become nodes
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
  errors: string[];
}

export type Position = [x: number, y: number];
export type Layout = Record<string, Position>;

export interface DiagramFiles {
  name: string;
  source: string;
  layout: Layout;
}

export type Op =
  | { type: "upsert-node"; node: DiagramNode; position?: Position }
  | { type: "remove-node"; id: string }
  | { type: "upsert-edge"; edge: DiagramEdge }
  | { type: "remove-edge"; source: string; target: string }
  | { type: "move"; id: string; position: Position }
  | { type: "reset-layout" };

type Line =
  | { type: "node"; node: DiagramNode }
  | { type: "edge"; edge: DiagramEdge }
  | { type: "other"; text: string };

const idPattern = String.raw`[\w-]+`;
const edgePattern = new RegExp(String.raw`^(${idPattern})\s*->\s*(${idPattern})\s*(?::\s*(.*))?$`);
const nodePattern = new RegExp(String.raw`^(${idPattern})\s*:\s*(.*?)\s*(?:\[(\w+)\])?$`);

export const edgeId = (edge: Pick<DiagramEdge, "source" | "target">) =>
  `${edge.source}->${edge.target}`;

export function isKind(value: string): value is Kind {
  return (kinds as readonly string[]).includes(value);
}

function parseLine(text: string, lineNumber: number, errors: string[]): Line {
  const trimmed = text.trim();
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
  for (const line of parseLines(source, errors)) {
    if (line.type === "node") {
      if (nodes.has(line.node.id)) errors.push(`duplicate node "${line.node.id}"`);
      nodes.set(line.node.id, line.node);
    } else if (line.type === "edge") {
      if (edges.has(edgeId(line.edge))) errors.push(`duplicate edge "${edgeId(line.edge)}"`);
      edges.set(edgeId(line.edge), line.edge);
    }
  }
  for (const edge of edges.values()) {
    for (const id of [edge.source, edge.target]) {
      if (!nodes.has(id)) nodes.set(id, { id, label: id, kind: "service" });
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], errors };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown) =>
  typeof value === "string" && new RegExp(`^${idPattern}$`).test(value);
// Newlines would inject extra statements into the file.
const isText = (value: unknown) => typeof value === "string" && !/[\r\n]/.test(value);
const isPosition = (value: unknown): value is Position =>
  Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === "number");

export const isLayout = (value: unknown): value is Layout =>
  isRecord(value) && Object.values(value).every(isPosition);

export const isDiagramFiles = (value: unknown): value is DiagramFiles =>
  isRecord(value) &&
  typeof value.name === "string" &&
  typeof value.source === "string" &&
  isLayout(value.layout);

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
      return true;
    default:
      return false;
  }
}

export const isOps = (value: unknown): value is Op[] => Array.isArray(value) && value.every(isOp);

// Applies canvas edits as line changes so comments, order and untouched lines stay as written.
export function applyOps(source: string, layout: Layout, ops: Op[]) {
  let lines = parseLines(source);
  let nextLayout = { ...layout };
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
      lines = lines.filter(
        (line) =>
          !(line.type === "node" && line.node.id === op.id) &&
          !(line.type === "edge" && (line.edge.source === op.id || line.edge.target === op.id)),
      );
      delete nextLayout[op.id];
    } else if (op.type === "upsert-edge") {
      const id = edgeId(op.edge);
      const index = lines.findIndex((line) => line.type === "edge" && edgeId(line.edge) === id);
      if (index === -1) insertAfterLast("edge", { type: "edge", edge: op.edge });
      else lines[index] = { type: "edge", edge: op.edge };
    } else if (op.type === "remove-edge") {
      const id = edgeId(op);
      lines = lines.filter((line) => !(line.type === "edge" && edgeId(line.edge) === id));
    } else if (op.type === "move") {
      nextLayout[op.id] = op.position;
    } else {
      nextLayout = {};
    }
  }
  return { source: `${lines.map(serializeLine).join("\n")}\n`, layout: nextLayout };
}
