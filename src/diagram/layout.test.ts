import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDiagram } from "./format.ts";
import { autoLayout, nodeSize } from "./layout.ts";

const positions = (source: string) => {
  const layout = autoLayout(parseDiagram(source)).positions;
  return (id: string) => {
    const position = layout[id];
    assert.ok(position, id);
    return { x: position[0], y: position[1] };
  };
};

test("in a cycle, edges to earlier nodes are loop-backs; other edges point down", () => {
  const at = positions("a: A\nb: B\nc: C\nd: D\ne: E\na -> c\nc -> b\nb -> a\ne -> d\n");
  assert.ok(at("a").y < at("b").y && at("b").y < at("c").y);
  assert.ok(at("e").y < at("d").y, "e -> d closes no cycle, so d goes below e");
  const entered = positions("x: X\na: A\nb: B\nx -> b\nb -> a\na -> b\n");
  assert.ok(entered("a").y < entered("b").y, "only b -> a is the loop-back");
});

test("nodes in a layer keep the file order, also with numeric ids", () => {
  const at = positions("20: Twenty\n10: Ten\nroot: Root\ny: Y\nx: X\nroot -> x\nroot -> y\n");
  assert.ok(at("20").x < at("10").x);
  assert.ok(at("x").x < at("y").x, "siblings follow the order of their edges");
});

// Asserts the route runs orthogonally from the bottom center of `source` to the top center of
// `target` without entering any node box.
function assertClearRoute(source: string, text: string, from: string, to: string) {
  const { positions: placed, routes } = autoLayout(parseDiagram(source));
  const route = routes[`${from}->${to}`];
  assert.ok(route, `${from} -> ${to} has a route`);
  const { width, height } = nodeSize;
  const [first, last] = [route.points[0]!, route.points.at(-1)!];
  assert.deepEqual(first, [placed[from]![0] + width / 2, placed[from]![1] + height]);
  assert.deepEqual(last, [placed[to]![0] + width / 2, placed[to]![1]]);
  route.points.slice(1).forEach(([x2, y2], index) => {
    const [x1, y1] = route.points[index]!;
    assert.ok(x1 === x2 || y1 === y2, `${text}: segment ${index} is orthogonal`);
    for (const [id, [left, top]] of Object.entries(placed)) {
      const enters =
        Math.max(x1, x2) > left + 1 &&
        Math.min(x1, x2) < left + width - 1 &&
        Math.max(y1, y2) > top + 1 &&
        Math.min(y1, y2) < top + height - 1;
      assert.ok(!enters, `${text}: segment ${index} enters ${id}`);
    }
  });
}

const chain = "a: A\nb: B\nc: C\nd: D\na -> b\nb -> c\nc -> d\n";

test("an edge across rows follows a lane beside the nodes it passes", () => {
  assertClearRoute(`${chain}a -> d\n`, "long edge", "a", "d");
  assert.equal(autoLayout(parseDiagram(chain)).routes["a->b"], undefined, "neighbors get a step");
});

test("a loop-back across rows leaves below its source and enters its target from above", () => {
  assertClearRoute(`${chain}d -> a\n`, "loop-back", "d", "a");
  const twoWay = autoLayout(parseDiagram(`${chain}a -> d\nd -> a\n`)).routes;
  assert.deepEqual(Object.keys(twoWay), ["a->d"], "a two-way pair shares one lane");
});
