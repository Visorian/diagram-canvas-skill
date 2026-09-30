// Two versions of a diagram as one: every node, group and edge of either. They can be an earlier and
// a later state, or two plans for the same thing. Laid out together, both can be shown in turn
// without anything moving. Whatever differs has a change against the base: added in the current
// version, removed from it, or changed.
import {
  edgeId,
  type Diagram,
  type DiagramEdge,
  type DiagramGroup,
  type DiagramNode,
  type Layout,
} from "./format";

export type Change = "added" | "removed" | "changed";

export interface Comparison {
  // Both versions in one, with the current one's details where they differ.
  union: Diagram;
  // By node, group and edge id.
  changes: Map<string, Change>;
  // Pinned positions: the current ones, and those of the base for removed nodes.
  layout: Layout;
}

export function compare(
  base: { diagram: Diagram; layout: Layout },
  current: { diagram: Diagram; layout: Layout },
): Comparison {
  const changes = new Map<string, Change>();
  const merge = <T>(
    currentItems: T[],
    baseItems: T[],
    key: (item: T) => string,
    differs: (a: T, b: T) => boolean,
  ) => {
    const baseByKey = new Map(baseItems.map((item) => [key(item), item]));
    const currentKeys = new Set(currentItems.map(key));
    for (const item of currentItems) {
      const before = baseByKey.get(key(item));
      if (!before) changes.set(key(item), "added");
      else if (differs(before, item)) changes.set(key(item), "changed");
    }
    // In the current order, and what only the base has right after what comes before it there, so
    // it shows up where it is in the base.
    const merged = [...currentItems];
    baseItems.forEach((item, index) => {
      if (currentKeys.has(key(item))) return;
      changes.set(key(item), "removed");
      const previous = baseItems[index - 1];
      const at =
        previous === undefined ? 0 : merged.findIndex((other) => key(other) === key(previous)) + 1;
      merged.splice(at, 0, item);
    });
    return merged;
  };

  const nodes = merge<DiagramNode>(
    current.diagram.nodes,
    base.diagram.nodes,
    (node) => node.id,
    (a, b) => a.label !== b.label || a.kind !== b.kind || a.group !== b.group,
  );
  const groups = merge<DiagramGroup>(
    current.diagram.groups,
    base.diagram.groups,
    (group) => group.id,
    (a, b) => a.label !== b.label || Boolean(a.outer) !== Boolean(b.outer) || a.parent !== b.parent,
  );
  const edges = merge<DiagramEdge>(
    current.diagram.edges,
    base.diagram.edges,
    edgeId,
    (a, b) => a.label !== b.label || Boolean(a.animated) !== Boolean(b.animated),
  );
  const removedPins = Object.entries(base.layout).filter(([id]) => changes.get(id) === "removed");
  return {
    union: { ...current.diagram, nodes, groups, edges, errors: [] },
    changes,
    layout: { ...Object.fromEntries(removedPins), ...current.layout },
  };
}
