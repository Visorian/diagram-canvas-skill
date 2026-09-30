// Grid layouts for diagrams with groups. Nodes sit in the cells of a table whose rows and columns
// run through the whole diagram. Groups are boxes around rectangles of cells, drawn in the gaps
// between them, and what a gap has left besides group borders is a channel for connections.
import { gridConnections, step, type Terminal } from "./connections";
import { edgeId, type Diagram, type DiagramEdge, type DiagramGroup, type Position } from "./format";
import type { AutoLayout, Box } from "./layout";

// Matches the fixed node size in DiagramNode.vue.
export const nodeSize = { width: 208, height: 56 };
// Space between the layers of a flow, where edges bend and labels sit.
export const layerSeparation = 72;

// Around the cells of a group: padding on the sides and below, and the header above. Matches
// DiagramGroup.vue.
export const groupPadding = 16;
export const groupHeader = 40;
export const headerGap = 16;
// Tracks in a channel keep this distance from what borders it.
const trackClearance = 12;

export type Slot = "single" | "left" | "right";

export interface Channel {
  at: number;
  room: number;
}

// A group box around the cells from the first to the last column and row.
interface Span {
  id: string;
  columns: [number, number];
  rows: [number, number];
}

// Positions of a table's columns, rows and group boxes. Vertical channel i runs left of column i
// and horizontal channel i above row i; the last ones run right of the last column and below the
// last row.
interface Table {
  columnX: number[];
  rowY: number[];
  boxes: Map<string, Box>;
  vertical: Channel[];
  horizontal: Channel[];
}

const covers = ([first, last]: [number, number], index: number) => first <= index && index <= last;

const across = (axis: "columns" | "rows") => (axis === "columns" ? "rows" : "columns");

const contains = (outer: Span, inner: Span) =>
  outer.columns[0] <= inner.columns[0] &&
  inner.columns[1] <= outer.columns[1] &&
  outer.rows[0] <= inner.rows[0] &&
  inner.rows[1] <= outer.rows[1];

// Every gap holds the borders of the boxes that end before it and start after it, nested ones next
// to each other, with the channel between them. It holds as many borders as any one row (or column)
// needs, so it has the same width everywhere and the columns and rows stay aligned.
function table(
  columnWidths: number[],
  rowHeights: number[],
  spans: Span[],
  channels: { vertical: number; horizontal: number; bottom: number },
): Table {
  const rowCount = rowHeights.length;
  const starting = (axis: "columns" | "rows", gap: number) =>
    spans.filter((span) => span[axis][0] === gap);
  const ending = (axis: "columns" | "rows", gap: number) =>
    spans.filter((span) => span[axis][1] === gap - 1);
  const stacked = (borders: Span[], axis: "columns" | "rows", count: number) =>
    Math.max(
      0,
      ...Array.from(
        { length: count },
        (_, index) => borders.filter((span) => covers(span[across(axis)], index)).length,
      ),
    );
  // Of the borders in one gap, the outermost is furthest from the cells: one further than the
  // deepest of the boxes it holds.
  const depth = (span: Span, borders: Span[]): number =>
    1 +
    Math.max(
      0,
      ...borders
        .filter((border) => border !== span && contains(span, border))
        .map((border) => depth(border, borders)),
    );

  const vertical: Channel[] = [];
  const columnX: number[] = [];
  let x = 0;
  for (let gap = 0; gap <= columnWidths.length; gap++) {
    x += stacked(ending("columns", gap), "columns", rowCount) * groupPadding;
    vertical.push({ at: x + channels.vertical / 2, room: channels.vertical - 2 * trackClearance });
    x += channels.vertical + stacked(starting("columns", gap), "columns", rowCount) * groupPadding;
    if (gap < columnWidths.length) {
      columnX.push(x);
      x += columnWidths[gap]!;
    }
  }
  const horizontal: Channel[] = [];
  const rowY: number[] = [];
  let y = 0;
  for (let gap = 0; gap <= rowCount; gap++) {
    // Nothing runs above the first row; below the last run only back edges and edges turning up.
    const channel = gap === 0 ? 0 : gap === rowCount ? channels.bottom : channels.horizontal;
    y += stacked(ending("rows", gap), "rows", columnWidths.length) * groupPadding;
    horizontal.push({ at: y + channel / 2, room: channel - 2 * trackClearance });
    y +=
      channel +
      stacked(starting("rows", gap), "rows", columnWidths.length) * (groupHeader + headerGap);
    if (gap < rowCount) {
      rowY.push(y);
      y += rowHeights[gap]!;
    }
  }

  const boxes = new Map(
    spans.map((span): [string, Box] => {
      const [first, last] = span.columns;
      const [top, bottom] = span.rows;
      const left = columnX[first]! - depth(span, starting("columns", first)) * groupPadding;
      const right =
        columnX[last]! +
        columnWidths[last]! +
        depth(span, ending("columns", last + 1)) * groupPadding;
      const upper = rowY[top]! - depth(span, starting("rows", top)) * (groupHeader + headerGap);
      const lower =
        rowY[bottom]! +
        rowHeights[bottom]! +
        depth(span, ending("rows", bottom + 1)) * groupPadding;
      return [span.id, { x: left, y: upper, width: right - left, height: lower - upper }];
    }),
  );
  return { columnX, rowY, boxes, vertical, horizontal };
}

// Group boxes, outermost first, so they are drawn behind the ones they hold.
function outermostFirst(spans: Span[], boxes: Map<string, Box>) {
  const ancestors = (span: Span) =>
    spans.filter((other) => other !== span && contains(other, span)).length;
  return spans
    .toSorted((a, b) => ancestors(a) - ancestors(b))
    .map(({ id }) => ({ id, box: boxes.get(id)! }));
}

function connect(
  diagram: Diagram,
  spans: Span[],
  cells: Map<string, Cell>,
  grid: Table,
  flow: boolean,
) {
  const terminals = new Map<string, Terminal>();
  const obstacles: Box[] = [];
  for (const [id, { row, column, slot, box }] of cells) {
    terminals.set(id, { box, rows: [row, row], columns: [column, column], slot });
    obstacles.push(box);
  }
  for (const { id, rows, columns } of spans) {
    terminals.set(id, { box: grid.boxes.get(id)!, rows, columns, slot: "single" });
  }
  const headers = new Map(
    [...grid.boxes].map(([id, { x, y, width }]) => [id, { x, y, width, height: groupHeader }]),
  );
  return gridConnections(diagram.edges, {
    terminals,
    obstacles,
    headers,
    horizontal: grid.horizontal,
    vertical: grid.vertical,
    flow,
  });
}

interface Cell {
  row: number;
  column: number;
  slot: Slot;
  box: Box;
}

const positionsOf = (cells: Map<string, Cell>) =>
  Object.fromEntries([...cells].map(([id, { box }]): [string, Position] => [id, [box.x, box.y]]));

// In a cycle, a depth-first walk along the edges, from the nodes in file order, finds the back
// edges: those to a node still on the walk's path. Without them no cycle is left.
function backEdges(diagram: Diagram) {
  const successors = Map.groupBy(diagram.edges, (edge) => edge.source);
  const back = new Set<DiagramEdge>();
  const onPath = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string) => {
    onPath.add(id);
    for (const edge of successors.get(id) ?? []) {
      if (onPath.has(edge.target)) back.add(edge);
      else if (!done.has(edge.target)) visit(edge.target);
    }
    onPath.delete(id);
    done.add(id);
  };
  for (const node of diagram.nodes) if (!done.has(node.id)) visit(node.id);
  return back;
}

// Flow grid: every group is a column of the same width, in file order, after a column of the nodes
// without a group. An outer group's box spans a column of its own nodes and the columns of its
// groups. Rows are the layers of the edges, shared by all columns, so an edge between two groups
// runs straight when its ends are in neighboring layers. A column holds at most two nodes per row,
// side by side when they are in the same layer. A node that finds its row full moves down within
// its column, and nothing moves in the other columns. Nothing depends on labels, so renaming moves
// nothing.
const columnGap = 16;
const columnWidth = 2 * nodeSize.width + columnGap;
const slotX: Record<Slot, number> = {
  single: (columnWidth - nodeSize.width) / 2,
  left: 0,
  right: nodeSize.width + columnGap,
};

export function flowGrid(diagram: Diagram): AutoLayout {
  const order = new Map(diagram.nodes.map((node, index) => [node.id, index]));
  const back = backEdges(diagram);
  // Edges from or to a group don't layer anything.
  const incoming = Map.groupBy(
    diagram.edges.filter(
      (edge) =>
        edge.source !== edge.target &&
        !back.has(edge) &&
        order.has(edge.source) &&
        order.has(edge.target),
    ),
    (edge) => edge.target,
  );
  // Longest path from a source.
  const layers = new Map<string, number>();
  const layerOf = (id: string): number => {
    let layer = layers.get(id);
    if (layer === undefined) {
      layer = Math.max(0, ...(incoming.get(id) ?? []).map((edge) => layerOf(edge.source) + 1));
      layers.set(id, layer);
    }
    return layer;
  };
  // Only layers that some node is in become rows.
  const usedLayers = [...new Set(diagram.nodes.map((node) => layerOf(node.id)))].toSorted(
    (a, b) => a - b,
  );
  const rowOfLayer = new Map(usedLayers.map((layer, row) => [layer, row]));

  // An outer group's column holds its own nodes.
  const columns = [undefined, ...diagram.groups.map((group) => group.id)]
    .map((id) => ({ id, members: diagram.nodes.filter((node) => node.group === id) }))
    .filter(({ members }) => members.length > 0);
  const columnOf = new Map(
    columns.flatMap(({ members }, column) => members.map((node) => [node.id, column])),
  );
  // Of two nodes sharing a row, the one whose neighbors' barycenter is further left sits left.
  const neighbors = new Map<string, number[]>();
  const betweenNodes = diagram.edges.filter(
    (edge) => order.has(edge.source) && order.has(edge.target),
  );
  for (const { source, target } of betweenNodes) {
    neighbors.set(source, [...(neighbors.get(source) ?? []), columnOf.get(target) ?? 0]);
    neighbors.set(target, [...(neighbors.get(target) ?? []), columnOf.get(source) ?? 0]);
  }
  const barycenter = (id: string) => {
    const around = neighbors.get(id) ?? [columnOf.get(id) ?? 0];
    return around.reduce((sum, column) => sum + column, 0) / around.length;
  };

  const seats: { id: string; row: number; column: number; slot: Slot }[] = [];
  let rowCount = 0;
  columns.forEach(({ members }, column) => {
    const rows: { row: number; layer: number; ids: string[] }[] = [];
    const byLayer = members.toSorted(
      (a, b) =>
        rowOfLayer.get(layerOf(a.id))! - rowOfLayer.get(layerOf(b.id))! ||
        order.get(a.id)! - order.get(b.id)!,
    );
    for (const node of byLayer) {
      const layer = layerOf(node.id);
      const open = rows.at(-1);
      if (open && open.ids.length === 1 && open.layer === layer) open.ids.push(node.id);
      else {
        const row = Math.max((open?.row ?? -1) + 1, rowOfLayer.get(layer)!);
        rows.push({ row, layer, ids: [node.id] });
      }
    }
    for (const { row, ids } of rows) {
      rowCount = Math.max(rowCount, row + 1);
      const pair = ids.toSorted(
        (a, b) => barycenter(a) - barycenter(b) || order.get(a)! - order.get(b)!,
      );
      pair.forEach((id, index) => {
        const slot = pair.length === 1 ? "single" : index === 0 ? "left" : "right";
        seats.push({ id, row, column, slot });
      });
    }
  });

  // A group's box spans its column, and an outer group's also the columns of its groups.
  const allRows: [number, number] = [0, rowCount - 1];
  const spans = diagram.groups.flatMap((group): Span[] => {
    const held = columns.flatMap(({ id }, column) =>
      inGroup(diagram.groups, id, group) ? [column] : [],
    );
    return held.length === 0
      ? []
      : [{ id: group.id, columns: [held[0]!, held.at(-1)!], rows: allRows }];
  });
  const grid = table(
    columns.map(() => columnWidth),
    Array.from({ length: rowCount }, () => nodeSize.height),
    spans,
    { vertical: 48, horizontal: layerSeparation, bottom: 32 },
  );
  const cells = new Map(
    seats.map(({ id, row, column, slot }): [string, Cell] => [
      id,
      {
        row,
        column,
        slot,
        box: { x: grid.columnX[column]! + slotX[slot], y: grid.rowY[row]!, ...nodeSize },
      },
    ]),
  );
  return {
    positions: positionsOf(cells),
    connections: connect(diagram, spans, cells, grid, true),
    groups: outermostFirst(spans, grid.boxes),
  };
}

// Architecture grid: the grouping places everything, and edges move nothing. Outer groups are bands,
// stacked in file order below a first band of what is outside them. A band holds its own nodes,
// then its groups side by side, and the nodes of each fill rows of up to three in file order. An
// empty group keeps one empty cell, so it can still be connected.
const blockWidth = 3;

export function architectureGrid(diagram: Diagram): AutoLayout {
  const nodesIn = (group: string | undefined) =>
    diagram.nodes.filter((node) => node.group === group);
  const bands = [
    {
      id: undefined,
      groups: diagram.groups.filter((group) => !group.outer && group.parent === undefined),
    },
    ...diagram.groups
      .filter((group) => group.outer)
      .map(({ id }) => ({ id, groups: diagram.groups.filter((group) => group.parent === id) })),
  ];
  const seats: { id: string; row: number; column: number }[] = [];
  const spans: Span[] = [];
  let rowCount = 0;
  let columnCount = 0;
  for (const band of bands) {
    const blocks = [
      { id: undefined, nodes: nodesIn(band.id) },
      ...band.groups.map(({ id }) => ({ id, nodes: nodesIn(id) })),
    ].filter(({ id, nodes }) => id !== undefined || nodes.length > 0);
    if (blocks.length === 0 && band.id === undefined) continue;
    let column = 0;
    let height = 1;
    for (const { id, nodes } of blocks) {
      const width = Math.max(1, Math.min(nodes.length, blockWidth));
      const rows = Math.max(1, Math.ceil(nodes.length / blockWidth));
      nodes.forEach((node, index) =>
        seats.push({
          id: node.id,
          row: rowCount + Math.floor(index / blockWidth),
          column: column + (index % blockWidth),
        }),
      );
      if (id !== undefined) {
        spans.push({
          id,
          columns: [column, column + width - 1],
          rows: [rowCount, rowCount + rows - 1],
        });
      }
      column += width;
      height = Math.max(height, rows);
    }
    if (band.id !== undefined) {
      spans.push({
        id: band.id,
        columns: [0, Math.max(column, 1) - 1],
        rows: [rowCount, rowCount + height - 1],
      });
    }
    columnCount = Math.max(columnCount, column, 1);
    rowCount += height;
  }
  if (rowCount === 0) return { positions: {}, connections: {}, groups: [] };

  const grid = table(
    Array.from({ length: columnCount }, () => nodeSize.width),
    Array.from({ length: rowCount }, () => nodeSize.height),
    spans,
    { vertical: 48, horizontal: 64, bottom: 32 },
  );
  const cells = new Map(
    seats.map(({ id, row, column }): [string, Cell] => [
      id,
      {
        row,
        column,
        slot: "single",
        box: { x: grid.columnX[column]!, y: grid.rowY[row]!, ...nodeSize },
      },
    ]),
  );
  return {
    positions: positionsOf(cells),
    connections: connect(diagram, spans, cells, grid, false),
    groups: outermostFirst(spans, grid.boxes),
  };
}

// Sequence: every node heads a column, in file order, and every edge between two nodes is a row
// below them, in file order, so the rows read top-down as steps. A node's timeline runs down its
// column through all rows. An edge runs across its row from the source's timeline to the target's,
// and a loop turns back beside its node's. A group's box spans the columns of its nodes and all rows.
const stepHeight = 40;

export function sequenceGrid(diagram: Diagram): AutoLayout {
  const columnOf = new Map(diagram.nodes.map((node, column) => [node.id, column]));
  const steps = diagram.edges.filter(
    ({ source, target }) => columnOf.has(source) && columnOf.has(target),
  );
  const rowCount = 1 + steps.length;
  const spans = diagram.groups.flatMap((group): Span[] => {
    const held = diagram.nodes.flatMap((node, column) =>
      inGroup(diagram.groups, node.group, group) ? [column] : [],
    );
    return held.length === 0
      ? []
      : [{ id: group.id, columns: [held[0]!, held.at(-1)!], rows: [0, rowCount - 1] }];
  });
  const grid = table(
    diagram.nodes.map(() => nodeSize.width),
    [nodeSize.height, ...steps.map(() => stepHeight)],
    spans,
    { vertical: 48, horizontal: 0, bottom: 16 },
  );
  const positions = Object.fromEntries(
    diagram.nodes.map((node, column): [string, Position] => [
      node.id,
      [grid.columnX[column]!, grid.rowY[0]!],
    ]),
  );
  const timeline =
    rowCount === 1 ? 0 : grid.rowY.at(-1)! + stepHeight - grid.rowY[0]! - nodeSize.height;
  const middle = (id: string) => positions[id]![0] + nodeSize.width / 2;
  const rows = steps.map((edge, index): [DiagramEdge, number] => [
    edge,
    grid.rowY[index + 1]! + stepHeight / 2,
  ]);
  return {
    positions,
    connections: Object.fromEntries(
      rows.map(([edge, y]) => [
        edgeId(edge),
        {
          ...step(
            middle(edge.source),
            middle(edge.target),
            y,
            edge.label,
            edge.source === edge.target,
          ),
          source: positions[edge.source]!,
          target: positions[edge.target]!,
        },
      ]),
    ),
    groups: outermostFirst(spans, grid.boxes),
    steps: Object.fromEntries(rows.map(([edge, y]) => [edgeId(edge), y])),
    timelines: Object.fromEntries(diagram.nodes.map((node) => [node.id, timeline])),
  };
}

// Whether a node of `group` belongs to `outer`, directly or through a group inside it.
const inGroup = (groups: DiagramGroup[], group: string | undefined, outer: DiagramGroup) =>
  group === outer.id || groups.some(({ id, parent }) => id === group && parent === outer.id);
