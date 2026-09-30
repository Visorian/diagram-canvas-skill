import assert from "node:assert/strict";
import { test } from "node:test";
import { applyOps, edgeId, isOps, parseDiagram } from "./format.ts";
import { parseNotes } from "./notes.ts";

test("parses nodes, edges, tags and reports invalid lines", () => {
  const diagram = parseDiagram(
    [
      "# tag: risk #d97706",
      "# tag: broken",
      "# plain comment",
      "api: API",
      "db: Orders DB [db]",
      "api -> db: SQL",
      "api -> cache",
      "x: X [blob]",
      "not a statement",
      "api: Again",
      "# tag: risk #000000",
    ].join("\n"),
  );
  assert.deepEqual(diagram.nodes, [
    { id: "api", label: "Again", kind: "service" },
    { id: "db", label: "Orders DB", kind: "db" },
    { id: "x", label: "X", kind: "service" },
    { id: "cache", label: "cache", kind: "service" },
  ]);
  assert.deepEqual(diagram.edges, [
    { source: "api", target: "db", label: "SQL" },
    { source: "api", target: "cache", label: "" },
  ]);
  assert.deepEqual(diagram.tags, [{ name: "risk", color: "#000000" }]);
  assert.deepEqual(diagram.errors, [
    "line 2: invalid tag definition",
    'line 8: unknown kind "blob"',
    'line 9: cannot parse "not a statement"',
    'duplicate node "api"',
    'duplicate tag "risk"',
  ]);
});

test("edits the model in place and keeps comments and order", () => {
  const state = {
    source: "# services\na: A\nb: B\n\n# flows\na -> b\n",
    layout: { a: [0, 0] as [number, number], b: [0, 100] as [number, number] },
    notes: "",
    marks: ["b", "a->b"],
  };
  const next = applyOps(state, [
    { type: "upsert-node", node: { id: "c", label: "C", kind: "queue" }, position: [5, 5] },
    { type: "upsert-edge", edge: { source: "c", target: "a", label: "poll" } },
    { type: "upsert-node", node: { id: "a", label: "Renamed", kind: "service" } },
    { type: "remove-node", id: "b" },
  ]);
  assert.deepEqual(next, {
    source: "# services\na: Renamed\nc: C [queue]\n\n# flows\nc -> a: poll\n",
    layout: { a: [0, 0], c: [5, 5] },
    notes: "",
    marks: [],
  });
});

test("parses groups and animated edges", () => {
  const diagram = parseDiagram(
    ["a: A", "[api: API layer]", "b: B", "[data]", "c: C [db]", "a => b: calls", "b -> c"].join(
      "\n",
    ),
  );
  assert.deepEqual(diagram.nodes, [
    { id: "a", label: "A", kind: "service" },
    { id: "b", label: "B", kind: "service", group: "api" },
    { id: "c", label: "C", kind: "db", group: "data" },
  ]);
  assert.deepEqual(diagram.groups, [
    { id: "api", label: "API layer" },
    { id: "data", label: "data" },
  ]);
  assert.deepEqual(diagram.edges, [
    { source: "a", target: "b", label: "calls", animated: true },
    { source: "b", target: "c", label: "" },
  ]);
  assert.deepEqual(parseDiagram("[api]\n[api: Again]\n").errors, ['duplicate group "api"']);
});

test("puts nodes below their group line and moves them between groups", () => {
  const state = {
    source: "# shop\na: A\n[api: API]\nb: B\n\n[data: Data]\nc: C [db]\n\na -> b\n",
    layout: { b: [0, 0] as [number, number], c: [0, 100] as [number, number] },
    notes: "",
    marks: [],
  };
  const next = applyOps(state, [
    { type: "upsert-node", node: { id: "d", label: "D", kind: "service", group: "api" } },
    { type: "upsert-node", node: { id: "e", label: "E", kind: "service" } },
    { type: "upsert-node", node: { id: "c", label: "C", kind: "db", group: "api" } },
    { type: "upsert-node", node: { id: "f", label: "F", kind: "service", group: "queue" } },
    { type: "upsert-edge", edge: { source: "a", target: "b", label: "", animated: true } },
  ]);
  assert.equal(
    next.source,
    "# shop\na: A\ne: E\n[api: API]\nb: B\nd: D\nc: C [db]\n\n[data: Data]\n\na => b\n\n[queue]\nf: F\n",
  );
  assert.deepEqual(next.layout, { b: [0, 0] }, "a node moved to another group loses its position");
});

test("parses outer groups, the layout and edges between groups", () => {
  const diagram = parseDiagram(
    [
      "# layout: architecture",
      "[edge: Edge]",
      "gw: Gateway",
      "[[region: Region A]]",
      "logs: Logs",
      "[hub: Hub]",
      "fw: Firewall",
      "[[shared]]",
      "acr: Registry",
      "hub -> region: peering",
      "fw -> acr",
    ].join("\n"),
  );
  assert.equal(diagram.layout, "architecture");
  assert.deepEqual(diagram.groups, [
    { id: "edge", label: "Edge" },
    { id: "region", label: "Region A", outer: true },
    { id: "hub", label: "Hub", parent: "region" },
    { id: "shared", label: "shared", outer: true },
  ]);
  assert.deepEqual(
    diagram.nodes.map(({ id, group }) => [id, group]),
    [
      ["gw", "edge"],
      ["logs", "region"],
      ["fw", "hub"],
      ["acr", "shared"],
    ],
    "a group id at an end of an edge doesn't become a node",
  );
  assert.equal(parseDiagram("a: A\n").layout, "flow");
  assert.deepEqual(parseDiagram("# layout: grid\n[a]\na: A\n").errors, [
    "line 1: unknown layout, use flow, architecture or sequence",
    '"a" is both a node and a group',
  ]);
});

test("puts a node of an outer group above its groups", () => {
  const source = "[[region: Region]]\nlogs: Logs\n[hub: Hub]\nfw: Firewall\n";
  const next = applyOps({ source, layout: {}, notes: "", marks: [] }, [
    { type: "upsert-node", node: { id: "kv", label: "Vault", kind: "service", group: "region" } },
    { type: "upsert-node", node: { id: "vpn", label: "VPN", kind: "service", group: "hub" } },
  ]);
  assert.equal(
    next.source,
    "[[region: Region]]\nlogs: Logs\nkv: Vault\n[hub: Hub]\nfw: Firewall\nvpn: VPN\n",
  );
});

test("counts parallel edges in file order and keeps loops", () => {
  const diagram = parseDiagram("a -> b: read\na -> b: write\nb -> a\na -> a: retry\na -> b\n");
  assert.deepEqual(diagram.edges.map(edgeId), ["a->b", "a->b#2", "b->a", "a->a", "a->b#3"]);
  assert.deepEqual(diagram.errors, []);
  assert.deepEqual(parseNotes("- @a->b#2 Only writes\n")[0]?.target, "a->b#2");
});

test("edits and removes a parallel edge by its ordinal", () => {
  const state = { source: "a -> b: read\na -> b: write\n", layout: {}, notes: "", marks: [] };
  const next = applyOps(state, [
    { type: "upsert-edge", edge: { source: "a", target: "b", label: "save", ordinal: 2 } },
    { type: "upsert-edge", edge: { source: "a", target: "b", label: "close", ordinal: 3 } },
    { type: "remove-edge", source: "a", target: "b" },
  ]);
  assert.equal(next.source, "a -> b: save\na -> b: close\n");
});

test("rejects ops that would corrupt the files", () => {
  const note = { kind: "question", text: "Why?", done: false };
  assert.ok(isOps([{ type: "add-note", note: { ...note, tag: "risk", target: "a->b" } }]));
  assert.ok(isOps([{ type: "update-note", note, next: { ...note, answer: "Yes", done: true } }]));
  assert.ok(isOps([{ type: "add-note", note: { ...note, text: "a → b?", forUser: true } }]));
  assert.ok(isOps([{ type: "handoff", text: "@a Split this?" }, { type: "handoff" }]));
  for (const op of [
    { type: "add-note", note: { ...note, kind: "note", tag: "risk" } },
    { type: "add-note", note: { ...note, tag: "two words" } },
    { type: "add-note", note: { ...note, text: "line\nbreak" } },
    { type: "add-note", note: { ...note, kind: "note", answer: "Yes" } },
    { type: "add-note", note: { ...note, kind: "note", forUser: true } },
    { type: "handoff", text: "two\nlines" },
    { type: "upsert-node", node: { id: "a b", label: "A", kind: "service" } },
    { type: "upsert-node", node: { id: "a", label: "A", kind: "blob" } },
    { type: "upsert-node", node: { id: "a", label: "A", kind: "service", group: "two words" } },
    { type: "upsert-edge", edge: { source: "a", target: "b", label: "", animated: "yes" } },
    { type: "upsert-edge", edge: { source: "a", target: "b", label: "", ordinal: 0 } },
    { type: "remove-edge", source: "a", target: "b", ordinal: 1.5 },
    { type: "unknown" },
  ]) {
    assert.equal(isOps([op]), false, JSON.stringify(op));
  }
});
