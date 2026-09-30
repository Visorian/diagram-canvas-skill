import assert from "node:assert/strict";
import { test } from "node:test";
import { edgeId, parseDiagram, type Position } from "./format.ts";
import { autoLayout, nodeSize, type Box } from "./layout.ts";

const positions = (source: string) => {
  const layout = autoLayout(parseDiagram(source)).positions;
  return (id: string) => {
    const position = layout[id];
    assert.ok(position, id);
    return { x: position[0], y: position[1] };
  };
};

test("in a cycle, edges to earlier nodes are back edges; other edges point down", () => {
  const at = positions("a: A\nb: B\nc: C\nd: D\ne: E\na -> c\nc -> b\nb -> a\ne -> d\n");
  assert.ok(at("a").y < at("b").y && at("b").y < at("c").y);
  assert.ok(at("e").y < at("d").y, "e -> d closes no cycle, so d goes below e");
  const entered = positions("x: X\na: A\nb: B\nx -> b\nb -> a\na -> b\n");
  assert.ok(entered("a").y < entered("b").y, "only b -> a is a back edge");
});

test("nodes in a layer keep the file order, also with numeric ids", () => {
  const at = positions("20: Twenty\n10: Ten\nroot: Root\ny: Y\nx: X\nroot -> x\nroot -> y\n");
  assert.ok(at("20").x < at("10").x);
  assert.ok(at("x").x < at("y").x, "siblings follow the order of their edges");
});

// Asserts the connection runs orthogonally from the bottom center of `source` to the top center of
// `target` without entering any node box.
function assertClearConnection(source: string, text: string, from: string, to: string) {
  const { positions: placed, connections } = autoLayout(parseDiagram(source));
  const connection = connections[`${from}->${to}`];
  assert.ok(connection, `${from} -> ${to} has a connection`);
  const { width, height } = nodeSize;
  const [first, last] = [connection.points[0]!, connection.points.at(-1)!];
  assert.deepEqual(first, [placed[from]![0] + width / 2, placed[from]![1] + height]);
  assert.deepEqual(last, [placed[to]![0] + width / 2, placed[to]![1]]);
  connection.points.slice(1).forEach(([x2, y2], index) => {
    const [x1, y1] = connection.points[index]!;
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

test("a long edge keeps the x of its dummy nodes beside the nodes it passes", () => {
  assertClearConnection(`${chain}a -> d\n`, "long edge", "a", "d");
  assert.equal(
    autoLayout(parseDiagram(chain)).connections["a->b"],
    undefined,
    "neighbors get a step",
  );
});

test("a back edge across layers leaves below its source and enters its target from above", () => {
  assertClearConnection(`${chain}d -> a\n`, "back edge", "d", "a");
  const twoWay = `${chain}a -> d\nd -> a\n`;
  assertClearConnection(twoWay, "one way", "a", "d");
  assertClearConnection(twoWay, "the other way", "d", "a");
  const { connections } = autoLayout(parseDiagram(twoWay));
  assert.notDeepEqual(connections["a->d"]!.points, connections["d->a"]!.points.toReversed());
});

const grouped = [
  "entry: Entry",
  "[edge: Edge]",
  "gateway: Gateway",
  "auth: Auth",
  "[core: Core]",
  "orders: Orders",
  "payments: Payments",
  "stock: Stock",
  "[data: Data]",
  "db: DB [db]",
  "bus: Bus [queue]",
  "entry => gateway",
  "gateway -> auth: token",
  "gateway -> orders: REST",
  "orders -> db: SQL",
  "orders => bus: placed",
  "bus -> payments",
  "bus -> stock",
  "payments -> orders: paid",
  "entry -> db: skips rows",
  "",
].join("\n");

const inside = (inner: Box, outer: Box) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

test("groups are columns in file order, each around its nodes", () => {
  const diagram = parseDiagram(grouped);
  const { positions: placed, groups } = autoLayout(diagram);
  assert.deepEqual(
    groups.map(({ id }) => id),
    ["edge", "core", "data"],
  );
  groups.slice(1).forEach(({ box }, index) => {
    const before = groups[index]!.box;
    assert.ok(before.x + before.width < box.x, "columns don't overlap");
  });
  for (const node of diagram.nodes) {
    const [x, y] = placed[node.id]!;
    const box = { x, y, ...nodeSize };
    const group = groups.find(({ id }) => id === node.group);
    if (group) assert.ok(inside(box, group.box), `${node.id} is inside ${group.id}`);
    else assert.ok(x + nodeSize.width < groups[0]!.box.x, `${node.id} is left of the groups`);
  }
});

test("what one group holds doesn't move the nodes of the others", () => {
  const before = autoLayout(parseDiagram(grouped)).positions;
  const after = autoLayout(
    parseDiagram(grouped.replace("auth: Auth", "auth: Auth\ncache: A much longer label [db]")),
  ).positions;
  for (const id of ["orders", "payments", "stock", "db", "bus"])
    assert.deepEqual(after[id], before[id], id);
});

// Asserts every connection runs orthogonally from the border of its source, a node or a group, to
// the border of its target without entering a node, and returns the connections.
function assertClearConnections(source: string) {
  const { positions: placed, connections, groups } = autoLayout(parseDiagram(source));
  const nodes = Object.entries(placed).map(([id, [x, y]]) => ({
    id,
    x,
    y,
    width: nodeSize.width,
    height: nodeSize.height,
  }));
  const ends = [
    ...nodes,
    ...groups.map(({ id, box: { x, y, width, height } }) => ({ id, x, y, width, height })),
  ];
  const onBorder = ([px, py]: Position, id: string) => {
    const { x, y, width, height } = ends.find((box) => box.id === id)!;
    const alongX = px >= x && px <= x + width && (py === y || py === y + height);
    const alongY = py >= y && py <= y + height && (px === x || px === x + width);
    return alongX || alongY;
  };
  for (const [id, { points }] of Object.entries(connections)) {
    const [from = "", to = ""] = id.replace(/#\d+$/, "").split("->");
    assert.ok(onBorder(points[0]!, from), `${id} starts on ${from}`);
    assert.ok(onBorder(points.at(-1)!, to), `${id} ends on ${to}`);
    points.slice(1).forEach(([x2, y2], index) => {
      const [x1, y1] = points[index]!;
      assert.ok(x1 === x2 || y1 === y2, `${id}: segment ${index} is orthogonal`);
      for (const box of nodes) {
        const enters =
          Math.max(x1, x2) > box.x + 1 &&
          Math.min(x1, x2) < box.x + box.width - 1 &&
          Math.max(y1, y2) > box.y + 1 &&
          Math.min(y1, y2) < box.y + box.height - 1;
        assert.ok(!enters, `${id}: segment ${index} enters ${box.id}`);
      }
    });
  }
  return connections;
}

test("with groups, every edge runs orthogonally from border to border without entering a node", () => {
  const connections = assertClearConnections(grouped);
  assert.equal(Object.keys(connections).length, parseDiagram(grouped).edges.length);
});

test("with groups, the edge that closes a cycle along the edges is the back edge", () => {
  const at = positions("[x]\na: A\nc: C\n[y]\nb: B\na -> b\nb -> c\nc -> a\n");
  assert.ok(at("a").y < at("b").y && at("b").y < at("c").y);
});

test("in a flow, an outer group's box holds its own nodes and the boxes of its groups", () => {
  const source = "[[region: Region]]\nlogs: Logs\n[hub: Hub]\na: A\n[spoke: Spoke]\nb: B\na -> b\n";
  const { positions: placed, groups } = autoLayout(parseDiagram(source));
  const box = (id: string) => groups.find((group) => group.id === id)!.box;
  assert.deepEqual(
    groups.map(({ id }) => id),
    ["region", "hub", "spoke"],
    "outer groups come first",
  );
  assert.ok(inside(box("hub"), box("region")) && inside(box("spoke"), box("region")));
  const [x, y] = placed.logs!;
  assert.ok(inside({ x, y, ...nodeSize }, box("region")));
});

const architecture = [
  "# layout: architecture",
  "[[region-a: Region A]]",
  "logs-a: Logs A [db]",
  "[hub-a: Hub A]",
  "bastion-a: Bastion A",
  "firewall-a: Firewall A",
  "[spoke-a: Spoke A]",
  "aks-a: AKS A",
  "lb-a: LB A",
  "gw-a: Gateway A",
  "[[region-b: Region B]]",
  "[hub-b: Hub B]",
  "bastion-b: Bastion B",
  "[spoke-b: Spoke B]",
  "aks-b: AKS B",
  "[[shared: Shared]]",
  "acr: Registry",
  "door: Front Door",
  "fleet: Fleet",
  "monitor: Monitor [db]",
  "hub-a -> spoke-a: peering",
  "hub-b -> spoke-b: peering",
  "door => gw-a",
  "gw-a -> lb-a",
  "lb-a -> aks-a",
  "aks-a -> acr: pull",
  "aks-b -> acr: pull",
  "aks-a -> monitor",
  "monitor -> region-a: logs",
  "",
].join("\n");

test("an architecture diagram nests groups in bands, stacked in file order", () => {
  const diagram = parseDiagram(architecture);
  const { positions: placed, groups } = autoLayout(diagram);
  const box = (id: string) => groups.find((group) => group.id === id)!.box;
  for (const group of diagram.groups.filter(({ parent }) => parent))
    assert.ok(inside(box(group.id), box(group.parent!)), `${group.id} is inside ${group.parent}`);
  for (const node of diagram.nodes) {
    const [x, y] = placed[node.id]!;
    assert.ok(inside({ x, y, ...nodeSize }, box(node.group!)), `${node.id} is in ${node.group}`);
  }
  const bottom = (id: string) => box(id).y + box(id).height;
  assert.ok(bottom("region-a") < box("region-b").y && bottom("region-b") < box("shared").y);
  assert.ok(box("hub-a").x + box("hub-a").width < box("spoke-a").x, "groups side by side");
});

test("in an architecture diagram, edges move nothing", () => {
  const without = architecture
    .split("\n")
    .filter((line) => !line.includes("->") && !line.includes("=>"))
    .join("\n");
  assert.deepEqual(
    autoLayout(parseDiagram(without)).positions,
    autoLayout(parseDiagram(architecture)).positions,
  );
});

test("in an architecture diagram, connections go the direct way, also to and from groups", () => {
  const connections = assertClearConnections(architecture);
  assert.equal(Object.keys(connections).length, parseDiagram(architecture).edges.length);
  const peering = connections["hub-a->spoke-a"]!.points;
  assert.equal(peering.length, 2, "neighboring groups connect in a straight line");
  assert.equal(peering[0]![1], peering[1]![1]);
});

const sequence = [
  "# layout: sequence",
  "router: Router Plugin",
  "[runtime: Runtime]",
  "composables: Composables",
  "router -> composables: read key",
  "router -> composables: register key",
  "router -> composables: dispose scope",
  "composables -> composables: verify ownership",
  "",
].join("\n");

test("a sequence puts nodes in columns and every edge in its own row, in file order", () => {
  const diagram = parseDiagram(sequence);
  const { positions: placed, steps, timelines, connections, groups } = autoLayout(diagram);
  assert.ok(placed.router![0] < placed.composables![0], "columns follow the file");
  assert.equal(placed.router![1], placed.composables![1], "nodes share the first row");
  const rows = diagram.edges.map((edge) => steps![edgeId(edge)]!);
  assert.deepEqual(
    rows,
    rows.toSorted((a, b) => a - b),
    "rows follow the file",
  );
  assert.equal(new Set(rows).size, rows.length, "parallel edges get rows of their own");
  const [first, last] = [rows[0]!, rows.at(-1)!];
  assert.ok(first > placed.router![1] + nodeSize.height, "rows are below the nodes");
  assert.ok(
    placed.router![1] + nodeSize.height + timelines!.router! > last,
    "timelines reach every row",
  );
  const loop = connections["composables->composables"]!.points;
  const center = placed.composables![0] + nodeSize.width / 2;
  assert.ok(
    loop.every(([x]) => x >= center) && loop.some(([x]) => x > center),
    "a loop turns right",
  );
  const runtime = groups.find(({ id }) => id === "runtime")!.box;
  assert.ok(
    inside({ x: placed.composables![0], y: last, width: nodeSize.width, height: 1 }, runtime),
  );
});

test("every layout draws a loop beside its node", () => {
  for (const source of [
    "a: A\nb: B\na -> b\na -> a: retry\n",
    "[g]\na: A\na -> a\n",
    "# layout: architecture\na: A\na -> a\n",
  ]) {
    const { positions: placed, connections } = autoLayout(parseDiagram(source));
    const loop = connections["a->a"];
    assert.ok(loop, source);
    const [x, y] = placed.a!;
    const right = x + nodeSize.width;
    assert.ok(
      loop.points.every(([px, py]) => px >= right && py > y && py < y + nodeSize.height),
      source,
    );
  }
});

// Whether two ranges overlap by more than a pixel.
const overlap = (a: number, b: number, c: number, d: number) =>
  Math.min(Math.max(a, b), Math.max(c, d)) - Math.max(Math.min(a, b), Math.min(c, d)) > 1;

test("parallel edges run apart", () => {
  for (const layout of ["", "# layout: architecture\n"]) {
    const source = `${layout}[g]\na: A\n[h]\nb: B\na -> b: read\na -> b: write\n`;
    const connections = assertClearConnections(source);
    const [read, write] = [connections["a->b"]!.points, connections["a->b#2"]!.points];
    const shared = read.slice(1).some(([x2, y2], index) => {
      const [x1, y1] = read[index]!;
      return write.slice(1).some(([x4, y4], other) => {
        const [x3, y3] = write[other]!;
        const vertical = x1 === x2 && x3 === x4 && x1 === x3;
        const horizontal = y1 === y2 && y3 === y4 && y1 === y3;
        return (vertical && overlap(y1, y2, y3, y4)) || (horizontal && overlap(x1, x2, x3, x4));
      });
    });
    assert.ok(!shared, `${layout || "flow"}: parallel edges share no stretch`);
  }
});
