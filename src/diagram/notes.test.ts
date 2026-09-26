import assert from "node:assert/strict";
import { test } from "node:test";
import { applyNoteOp, parseNotes } from "./notes.ts";

const source = [
  "# Notes",
  "- [ ] #risk @orders Can payment retry?",
  "- [x] @gateway->auth Token TTL?",
  "- #risk not a tag on notes",
  "- [ ] #risk",
  "",
].join("\n");

test("parses questions, tags, targets and notes", () => {
  assert.deepEqual(parseNotes(source), [
    { kind: "question", text: "Can payment retry?", done: false, tag: "risk", target: "orders" },
    { kind: "question", text: "Token TTL?", done: true, target: "gateway->auth" },
    { kind: "note", text: "#risk not a tag on notes", done: false },
    { kind: "question", text: "#risk", done: false },
  ]);
});

test("adds, updates and removes entries and keeps other lines", () => {
  const [question, resolved] = parseNotes(source);
  assert.ok(question && resolved);
  let next = applyNoteOp(source, {
    type: "update-note",
    note: question,
    next: { ...question, tag: undefined, done: true },
  });
  next = applyNoteOp(next, { type: "remove-note", note: resolved });
  next = applyNoteOp(next, {
    type: "add-note",
    note: { kind: "question", text: "Who owns it?", done: false, tag: "perf" },
  });
  assert.equal(
    next,
    [
      "# Notes",
      "- [x] @orders Can payment retry?",
      "- #risk not a tag on notes",
      "- [ ] #risk",
      "- [ ] #perf Who owns it?",
      "",
    ].join("\n"),
  );
});
