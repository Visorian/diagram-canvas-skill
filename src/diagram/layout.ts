import { graphlib, layout } from "@dagrejs/dagre";
import { loop, withoutStraightBends } from "./connections";
import { edgeId, type Diagram, type DiagramEdge, type Layout, type Position } from "./format";
import {
  architectureGrid,
  flowGrid,
  sequenceGrid,
  groupHeader,
  groupPadding,
  headerGap,
  layerSeparation,
  nodeSize,
} from "./grid";

export { nodeSize };

// Distance of a back edge from the side of the node it passes, half the space between two nodes.
const nodeClearance = 24;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

// The drawn path of an edge, with `label` on it. It holds while both ends stay where the auto
// layout placed them, at the top-left corners `source` and `target`.
export interface Connection {
  points: Position[];
  label: Position;
  source: Position;
  target: Position;
}

export interface AutoLayout {
  positions: Layout;
  connections: Record<string, Connection>;
  // Boxes of the groups, outer ones before the groups they hold.
  groups: { id: string; box: Box }[];
  // In a sequence: the height of every edge's row, and how far each node's timeline runs below it.
  steps?: Record<string, number>;
  timelines?: Record<string, number>;
}

// Architecture diagrams are placed by their groups, and sequences as columns of nodes and rows of
// edges. Flows are layered top-down along the edges, keeping the declaration order within a layer,
// and back edges, which close a cycle, don't count for the layers. With groups, a flow gets a grid
// of group columns, without them a layered layout.
export function autoLayout(diagram: Diagram): AutoLayout {
  if (diagram.layout === "architecture") return architectureGrid(diagram);
  if (diagram.layout === "sequence") return sequenceGrid(diagram);
  return diagram.nodes.some((node) => node.group !== undefined)
    ? flowGrid(diagram)
    : layeredLayout(diagram);
}

// Without groups, an edge is a back edge when its target comes first in the file and reaches its
// source. Every cycle has such an edge, so the other edges form no cycle.
function backEdgesByOrder(diagram: Diagram) {
  const order = new Map(diagram.nodes.map((node, index) => [node.id, index]));
  const successors = Map.groupBy(diagram.edges, (edge) => edge.source);
  const reaches = (from: string, to: string) => {
    const seen = new Set([from]);
    for (const id of seen) {
      if (id === to) return true;
      for (const edge of successors.get(id) ?? []) seen.add(edge.target);
    }
    return false;
  };
  return (edge: DiagramEdge) =>
    (order.get(edge.target) ?? 0) <= (order.get(edge.source) ?? 0) &&
    reaches(edge.target, edge.source);
}

// Keys get a prefix because graphlib stores nodes in a plain object, which would move numeric ids to
// the front. Parallel edges are edges of their own for dagre, named by their id; loops aren't
// layered at all.
function layeredLayout(diagram: Diagram): AutoLayout {
  const isBack = backEdgesByOrder(diagram);
  const graph = new graphlib.Graph({ multigraph: true });
  graph.setGraph({ rankdir: "TB", nodesep: 48, ranksep: layerSeparation });
  for (const node of diagram.nodes) graph.setNode(`n${node.id}`, { ...nodeSize });
  const loops = diagram.edges.filter((edge) => edge.source === edge.target);
  const laidOut = diagram.edges
    .filter((edge) => edge.source !== edge.target)
    .map((edge) => {
      const back = isBack(edge);
      const [from, to] = back ? [edge.target, edge.source] : [edge.source, edge.target];
      graph.setEdge(`n${from}`, `n${to}`, {}, edgeId(edge));
      return { edge, from, to, back };
    });
  layout(graph, { disableOptimalOrderHeuristic: true });
  const center = (id: string): Position => {
    const { x, y } = graph.node(`n${id}`);
    return [x, y];
  };
  const positions = Object.fromEntries(
    diagram.nodes.map((node): [string, Position] => {
      const [x, y] = center(node.id);
      return [node.id, [x - nodeSize.width / 2, y - nodeSize.height / 2]];
    }),
  );
  const layers = new Set(diagram.nodes.map((node) => center(node.id)[1]));
  const connections: Record<string, Connection> = {};
  for (const { edge, from, to, back } of laidOut) {
    // dagre gives a long edge a dummy node in every layer it passes and a point in every gap.
    const dummies = (graph.edge(`n${from}`, `n${to}`, edgeId(edge))?.points ?? [])
      .slice(1, -1)
      .map(({ x, y }: { x: number; y: number }): Position => [x, y]);
    if (back) dummies.reverse();
    const connection = longEdge(center(edge.source), center(edge.target), dummies, layers);
    if (connection) {
      connections[edgeId(edge)] = {
        ...connection,
        source: positions[edge.source]!,
        target: positions[edge.target]!,
      };
    }
  }
  for (const edge of loops) {
    const [x, y] = positions[edge.source]!;
    connections[edgeId(edge)] = {
      ...loop({ x, y, ...nodeSize }, "right", edge.label),
      source: [x, y],
      target: [x, y],
    };
  }
  return { positions, connections, groups: [] };
}

// A long edge holds the x of its dummy nodes through every layer it passes and bends in the gaps.
// A back edge leaves below its source, passes it on the side of its dummy nodes, and does the same
// around its target to enter from above. Edges between neighboring layers get no connection; the
// canvas draws a plain step for them.
function longEdge(
  [sourceX, sourceY]: Position,
  [targetX, targetY]: Position,
  dummies: Position[],
  layers: Set<number>,
): Pick<Connection, "points" | "label"> | undefined {
  const stops = dummies.map(([x, y]): Stop => (layers.has(y) ? { layer: x } : { gap: y }));
  const passed = stops.flatMap((stop) => ("layer" in stop ? [stop.layer] : []));
  if (passed.length === 0) return undefined;
  const gaps = stops.filter((stop) => "gap" in stop);
  const labelGap = gaps[Math.floor(gaps.length / 2)];
  const half = nodeSize.height / 2;
  if (targetY < sourceY) {
    const beside = (x: number, toward: number) =>
      x + Math.sign(toward - x || 1) * (nodeSize.width / 2 + nodeClearance);
    stops.unshift(
      { gap: sourceY + half + layerSeparation / 2 },
      { layer: beside(sourceX, passed[0]!) },
    );
    stops.push(
      { layer: beside(targetX, passed.at(-1)!) },
      { gap: targetY - half - layerSeparation / 2 },
    );
  }
  stops.push({ layer: targetX });
  const points: Position[] = [[sourceX, sourceY + half]];
  let x = sourceX;
  let bend: number | undefined;
  let label: Position | undefined;
  let beforeLabel: number | undefined;
  for (const stop of stops) {
    if ("gap" in stop) {
      bend = stop.gap;
      if (stop === labelGap) beforeLabel = x;
      continue;
    }
    if (stop.layer !== x) {
      if (bend === undefined) return undefined;
      points.push([x, bend], [stop.layer, bend]);
    }
    if (beforeLabel !== undefined && labelGap && !label)
      label = [(beforeLabel + stop.layer) / 2, labelGap.gap];
    x = stop.layer;
  }
  points.push([targetX, targetY - half]);
  return label && { points: withoutStraightBends(points), label };
}

// A layer the edge passes at x `layer`, or a gap at y `gap` where it may bend.
type Stop = { layer: number } | { gap: number };

// The box of each group on the canvas: as laid out, grown to hold the members the user moved. A
// group whose members all moved just surrounds them. A member of a group inside the group counts
// too, with room for both borders.
export function groupBoxes(diagram: Diagram, auto: AutoLayout, pinned: Layout) {
  const parentOf = new Map(diagram.groups.map((group) => [group.id, group.parent]));
  return auto.groups.map(({ id, box }) => {
    const members = diagram.nodes.flatMap((node) => {
      if (node.group === id) return [{ node, levels: 1 }];
      if (node.group !== undefined && parentOf.get(node.group) === id) return [{ node, levels: 2 }];
      return [];
    });
    const moved = members.flatMap(({ node, levels }) => {
      const position = pinned[node.id];
      if (!position) return [];
      const [x, y] = position;
      const side = levels * groupPadding;
      const top = levels * (groupHeader + headerGap);
      return [
        {
          x: x - side,
          y: y - top,
          width: nodeSize.width + 2 * side,
          height: nodeSize.height + top + side,
        },
      ];
    });
    const allMoved = members.length > 0 && moved.length === members.length;
    return { id, box: union(allMoved ? moved : [box, ...moved]) };
  });
}

function union(boxes: Box[]): Box {
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}
