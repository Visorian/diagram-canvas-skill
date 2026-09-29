import { graphlib, layout } from "@dagrejs/dagre";
import { edgeId, type Diagram, type Layout, type Position } from "./format";

// Matches the fixed node size in DiagramNode.vue.
export const nodeSize = { width: 176, height: 56 };
const rankSeparation = 72;
// Distance of a loop-back from the side of the node it passes, half the space between two nodes.
const nodeClearance = 24;

// Path of an edge across several rows through the lane the layout kept free for it, from the bottom
// of its source to the top of its target. It turns only in the gaps between rows, where `label` sits.
export interface EdgeRoute {
  points: Position[];
  label: Position;
}

export interface AutoLayout {
  positions: Layout;
  routes: Record<string, EdgeRoute>;
}

// Top-down layered layout along the edges. In a cycle, an edge to an earlier node is a loop-back and
// is laid out reversed; nodes and edges keep their declaration order within a layer. Keys get a
// prefix because graphlib stores nodes in a plain object, which would move numeric ids to the front.
export function autoLayout(diagram: Diagram): AutoLayout {
  const graph = new graphlib.Graph();
  graph.setGraph({ rankdir: "TB", nodesep: 48, ranksep: rankSeparation });
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
  for (const node of diagram.nodes) graph.setNode(`n${node.id}`, { ...nodeSize });
  const laidOut = diagram.edges.map((edge) => {
    const { source, target } = edge;
    const back = (order.get(target) ?? 0) <= (order.get(source) ?? 0) && reaches(target, source);
    const [from, to] = back ? [target, source] : [source, target];
    graph.setEdge(`n${from}`, `n${to}`, {});
    return { edge, from, to, back };
  });
  layout(graph, { disableOptimalOrderHeuristic: true });
  const center = (id: string): Position => {
    const { x, y } = graph.node(`n${id}`);
    return [x, y];
  };
  const rows = new Set(diagram.nodes.map((node) => center(node.id)[1]));
  const routes: Record<string, EdgeRoute> = {};
  const taken = new Set<string>();
  for (const { edge, from, to, back } of laidOut) {
    // Both edges of a two-way pair are one edge for dagre, so only the first gets its lane.
    if (taken.has(`${from}->${to}`)) continue;
    taken.add(`${from}->${to}`);
    // dagre splits every edge into points between its end nodes, one per row and one per gap.
    const lane = (graph.edge(`n${from}`, `n${to}`)?.points ?? [])
      .slice(1, -1)
      .map(({ x, y }: { x: number; y: number }): Position => [x, y]);
    if (back) lane.reverse();
    const route = laneRoute(center(edge.source), center(edge.target), lane, rows);
    if (route) routes[edgeId(edge)] = route;
  }
  const positions = Object.fromEntries(
    diagram.nodes.map((node): [string, Position] => {
      const [x, y] = center(node.id);
      return [node.id, [x - nodeSize.width / 2, y - nodeSize.height / 2]];
    }),
  );
  return { positions, routes };
}

// Holds the lane's x through every row it passes and turns in the gaps. A loop-back leaves below its
// source, passes it on the side of its lane, and does the same around its target to enter from above.
// Edges between neighboring rows get no route; the canvas draws a plain step for them.
function laneRoute(
  [sourceX, sourceY]: Position,
  [targetX, targetY]: Position,
  lane: Position[],
  rows: Set<number>,
): EdgeRoute | undefined {
  const stops = lane.map(([x, y]): Stop => (rows.has(y) ? { row: x } : { gap: y }));
  const passed = stops.flatMap((stop) => ("row" in stop ? [stop.row] : []));
  if (passed.length === 0) return undefined;
  const laneGaps = stops.filter((stop) => "gap" in stop);
  const labelGap = laneGaps[Math.floor(laneGaps.length / 2)];
  const half = nodeSize.height / 2;
  if (targetY < sourceY) {
    const beside = (x: number, toward: number) =>
      x + Math.sign(toward - x || 1) * (nodeSize.width / 2 + nodeClearance);
    stops.unshift(
      { gap: sourceY + half + rankSeparation / 2 },
      { row: beside(sourceX, passed[0]!) },
    );
    stops.push(
      { row: beside(targetX, passed.at(-1)!) },
      { gap: targetY - half - rankSeparation / 2 },
    );
  }
  stops.push({ row: targetX });
  const points: Position[] = [[sourceX, sourceY + half]];
  let x = sourceX;
  let turn: number | undefined;
  let label: Position | undefined;
  let beforeLabel: number | undefined;
  for (const stop of stops) {
    if ("gap" in stop) {
      turn = stop.gap;
      if (stop === labelGap) beforeLabel = x;
      continue;
    }
    if (stop.row !== x) {
      if (turn === undefined) return undefined;
      points.push([x, turn], [stop.row, turn]);
    }
    if (beforeLabel !== undefined && labelGap && !label)
      label = [(beforeLabel + stop.row) / 2, labelGap.gap];
    x = stop.row;
  }
  points.push([targetX, targetY - half]);
  return label && { points: withoutStraightBends(points), label };
}

// A row the route passes at `row`, or a gap at `gap` where it may turn.
type Stop = { row: number } | { gap: number };

// Drops points that don't change the direction, so the canvas only rounds real corners.
function withoutStraightBends(points: Position[]): Position[] {
  return points.filter((point, index) => {
    const previous = points[index - 1];
    const next = points[index + 1];
    if (!previous || !next) return true;
    const vertical = previous[0] === point[0] && point[0] === next[0];
    const horizontal = previous[1] === point[1] && point[1] === next[1];
    return !vertical && !horizontal;
  });
}
