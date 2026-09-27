import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDiagram } from "./format.ts";
import { autoLayout } from "./layout.ts";

const positions = (source: string) => {
  const layout = autoLayout(parseDiagram(source));
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
