import { graphlib, layout } from "@dagrejs/dagre";
import type { Diagram, Layout } from "./format";

// Matches the fixed node size in DiagramNode.vue.
export const nodeSize = { width: 176, height: 56 };

// Top-down layered layout along the edges. In a cycle, an edge to an earlier node is a loop-back and
// is laid out reversed; nodes and edges keep their declaration order within a layer. Keys get a
// prefix because graphlib stores nodes in a plain object, which would move numeric ids to the front.
export function autoLayout(diagram: Diagram): Layout {
  const graph = new graphlib.Graph();
  graph.setGraph({ rankdir: "TB", nodesep: 48, ranksep: 72 });
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
  for (const { source, target } of diagram.edges) {
    const back = (order.get(target) ?? 0) <= (order.get(source) ?? 0) && reaches(target, source);
    graph.setEdge(`n${back ? target : source}`, `n${back ? source : target}`, {});
  }
  layout(graph, { disableOptimalOrderHeuristic: true });
  return Object.fromEntries(
    diagram.nodes.map((node) => {
      const { x, y } = graph.node(`n${node.id}`);
      return [node.id, [x - nodeSize.width / 2, y - nodeSize.height / 2]];
    }),
  );
}
