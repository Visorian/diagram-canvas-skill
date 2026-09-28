import assert from "node:assert/strict";
import { test } from "node:test";
import { applyOps, isOps, parseDiagram } from "./format.ts";

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
    { type: "unknown" },
  ]) {
    assert.equal(isOps([op]), false, JSON.stringify(op));
  }
});
