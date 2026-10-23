import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  architectureGrid,
  compareVersions,
  groupHeader,
  labelHeight,
  legendMarks,
  nodeSize,
  parseDiagram,
  scene,
  shortLabel,
  type Box,
  type Diagram,
  type Position,
  type Scene,
  type SceneOptions,
} from "./index.ts";
import { autoLayout } from "./layout.ts";

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const segmentsOf = (points: Position[]): Box[] =>
  points.slice(1).map(([x2, y2], index) => {
    const [x1, y1] = points[index]!;
    return {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    };
  });

// A label's box and the leader that joins it to a horizontal stretch of its route.
function labelParts({ at: [x, y], width, routeY }: NonNullable<Scene["edges"][number]["label"]>) {
  const box = { x: x - width / 2, y: y - labelHeight / 2, width, height: labelHeight };
  const bottom = box.y + box.height;
  const [from, to] = routeY > bottom ? [bottom, routeY] : [routeY, box.y];
  return to > from ? [box, { x, y: from, width: 0, height: to - from }] : [box];
}

// Every label is attached to its own route and covers no node, group header, arrowhead, line or
// other label; neither does its leader. A label may touch only the stretch it sits on.
function assertLegible({ layout, edges }: Scene, arrow = 10) {
  const nodes = Object.values(layout.positions).map(([x, y]): Box => ({
    x,
    y,
    width: nodeSize.width,
    height: nodeSize.height,
  }));
  const headers = layout.groups.map(({ box: { x, y, width } }) => ({
    x,
    y,
    width,
    height: groupHeader,
  }));
  for (const edge of edges) {
    if (!edge.label) continue;
    const { at, routeY } = edge.label;
    const own = segmentsOf(edge.points);
    const attached = own.some((line) =>
      line.height === 0
        ? line.y === routeY && at[0] >= line.x && at[0] <= line.x + line.width
        : routeY === at[1] && at[1] >= line.y && at[1] <= line.y + line.height,
    );
    assert.ok(attached, `${edge.id}: label is attached to its route`);
    const obstacles = [
      ...nodes,
      ...headers,
      ...edges.flatMap((other) => {
        const [x, y] = other.points.at(-1)!;
        const tip = { x: x - arrow / 2, y: y - arrow / 2, width: arrow, height: arrow };
        const lines = segmentsOf(other.points);
        return other === edge
          ? [...lines.filter((line) => line.height !== 0 || line.y !== routeY), tip]
          : [...lines, tip, ...(other.label ? labelParts(other.label) : [])];
      }),
    ];
    for (const part of labelParts(edge.label))
      assert.deepEqual(
        obstacles.filter((obstacle) => overlaps(part, obstacle)),
        [],
        `${edge.id}: label is clear`,
      );
  }
}

const grid = (diagram: Diagram, options?: SceneOptions) =>
  scene(diagram, (extra) => autoLayout(diagram, extra), options);

const architecture = (nodes: string[], edges: string[]) =>
  parseDiagram(["# layout: architecture", ...nodes, ...edges, ""].join("\n"));

const versions = (before: Diagram, after: Diagram) =>
  compareVersions({ diagram: before, layout: {} }, { diagram: after, layout: {} });

const compared = (before: Diagram, after: Diagram) => {
  const comparison = versions(before, after)!;
  return grid(comparison.union, { reserved: comparison.reserved });
};

test("labels clear nodes, headers, arrowheads, lines and each other in dense diagrams", () => {
  const dir = new URL("../../diagrams/", import.meta.url);
  const read = (name: string) => parseDiagram(readFileSync(new URL(`${name}.txt`, dir), "utf8"));
  for (const name of ["platform", "checkout-plan-a", "checkout-plan-b", "hosting-plan-b"])
    assertLegible(grid(read(name)));
  assertLegible(compared(read("checkout-plan-a"), read("checkout-plan-b")));
  assertLegible(compared(read("hosting-plan-a"), read("hosting-plan-b")));

  const nodes = ["a: Component A", "b: Component B", "c: Component C"];
  const cyclic = architecture(
    [...nodes, "d: Component D", "e: Component E", "f: Component F"],
    ["a -> b: Read", "a -> b: Read again", "b -> b: Retry", "f -> a: Return", "c -> e"],
  );
  assertLegible(grid(cyclic));
  assertLegible(
    compared(cyclic, architecture(["x: X", "y: Y", "z: Z", "w: W"], ["x -> w: replaced"])),
  );
  assertLegible(
    compared(
      architecture(
        ["ci: Platform Kind workflow", "harness: Kind upgrade harness"],
        ["ci -> harness: upgrades predecessor to candidate"],
      ),
      architecture(
        ["ci: Platform Kind workflow", "derive: Rollback fixture derive", "harness: Kind harness"],
        [
          "ci -> derive: derives rollback release",
          "ci -> harness: upgrades predecessor to target",
          "derive -> harness: supplies rollback release",
        ],
      ),
    ),
  );
  assertLegible(
    grid(
      architecture(
        [
          "lock: Catalog lock",
          "cblock: Cluster-base lock",
          "gen: Generator",
          "support: Support declaration",
          "devenv: Devenv declaration",
        ],
        [
          "lock -> gen: supplies image inventory",
          "cblock -> gen: supplies Dapr version",
          "gen -> support: writes Radius release",
          "gen -> devenv: writes Dapr version",
        ],
      ),
    ),
  );
  const five = ["n0: N0", "n1: N1", "n2: N2", "n3: N3", "n4: N4"];
  for (const edges of [
    ["n4 -> n3: publishes events", "n1 -> n3: supplies image inventory", "n3 -> n4: writes it"],
    [
      "n3 -> n0: supplies image inventory",
      "n0 -> n4: derives rollback release",
      "n4 -> n2: reads config",
      "n0 -> n2: calls",
    ],
  ])
    assertLegible(grid(architecture(five, edges)));
});

const labeled = (from: string, to: string) => [
  `n3 -> n0: ${from}`,
  `n0 -> n4: ${to}`,
  "n4 -> n2: reads config",
  "n0 -> n2: calls",
];

test("a grid widens the column gap a label has no room in, and only then", () => {
  const nodes = ["n0: N0", "n1: N1", "n2: N2", "n3: N3", "n4: N4"];
  const gap = (diagram: Diagram) => {
    const { positions } = grid(diagram).layout;
    return positions.n1![0] - positions.n0![0] - nodeSize.width;
  };
  const crowded = architecture(
    nodes,
    labeled("supplies image inventory", "derives rollback release"),
  );
  assert.equal(gap(architecture(nodes, labeled("supplies", "derives"))), 48);
  assert.ok(gap(crowded) > 48);
  assertLegible(grid(crowded));
});

test("switching versions moves nothing, also when a label gets longer", () => {
  const nodes = ["a: A", "b: B", "c: C", "d: D"];
  const before = architecture(nodes, ["a -> b: ok", "c -> d: calls"]);
  const after = architecture(nodes, ["a -> b: supplies image inventory", "c -> d: calls"]);
  const forward = compared(before, after);
  const backward = compared(after, before);
  assert.deepEqual(forward.layout.positions, backward.layout.positions);
  assert.deepEqual(
    forward.edges.map(({ points, label }) => [points, label?.at, label?.width]),
    backward.edges.map(({ points, label }) => [points, label?.at, label?.width]),
  );
  assert.equal(forward.edges[0]!.label!.text, "supplies image inventory");
  assert.equal(backward.edges[0]!.label!.text, "ok");
  assertLegible(forward);
});

test("long labels are shortened with an ellipsis, by a limit and width of the caller's choice", () => {
  const label = "replicates every order to the reporting warehouse";
  assert.equal(shortLabel(label), "replicates every order to t…");
  assert.equal(Array.from(shortLabel(label)).length, 28);
  assert.equal(shortLabel("short"), "short");
  const diagram = architecture(["a: A", "b: B"], [`a -> b: ${label}`]);
  const [edge] = scene(diagram, (extra) => architectureGrid(diagram, 48, extra), {
    labelLimit: 12,
    labelWidth: (text) => text.length * 10,
  }).edges;
  assert.equal(edge!.label!.text, "replicates…");
  assert.equal(edge!.label!.width, 110);
  assert.equal(edge!.edge.label, label);
});

test("two identical versions are no comparison", () => {
  const diagram = architecture(["a: A", "b: B"], ["a -> b: calls"]);
  assert.equal(versions(diagram, diagram), undefined);
  assert.ok(versions(diagram, architecture(["a: A", "b: B"], ["a -> b: reads"])));
});

test("a legend lists only the marks a view draws", () => {
  const before = parseDiagram("a: A\nb: B [db]\na -> b\n");
  const after = parseDiagram("a: A\nb: B [db]\nc: C [ext]\na => b\na -> c\n");
  assert.deepEqual(legendMarks(before), ["service", "db"]);
  const { union, changes } = versions(before, after)!;
  assert.deepEqual(legendMarks(union, changes), [
    "service",
    "db",
    "ext",
    "animated",
    "added",
    "changed",
  ]);
});
