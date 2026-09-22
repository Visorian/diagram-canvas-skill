import ELK from "elkjs/lib/elk.bundled.js";
import { edgeId, type Diagram, type Layout } from "./format";

// Matches the fixed node size in DiagramNode.vue.
export const nodeSize = { width: 176, height: 56 };

const elk = new ELK();

export async function autoLayout(diagram: Diagram): Promise<Layout> {
  const graph = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.spacing.nodeNode": "48",
      "elk.layered.spacing.nodeNodeBetweenLayers": "72",
    },
    children: diagram.nodes.map((node) => ({ id: node.id, ...nodeSize })),
    edges: diagram.edges.map((edge) => ({
      id: edgeId(edge),
      sources: [edge.source],
      targets: [edge.target],
    })),
  });
  return Object.fromEntries(
    (graph.children ?? []).map((node) => [node.id, [node.x ?? 0, node.y ?? 0]]),
  );
}
