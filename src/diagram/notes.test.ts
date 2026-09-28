import assert from "node:assert/strict";
import { test } from "node:test";
import { applyNoteOp, parseNotes } from "./notes.ts";

const source = [
  "# Notes",
  "- [ ] #risk @orders Can payment retry?",
  "- [x] @gateway->auth Token TTL, gateway → auth?",
  "  → 5 min",
  "- [ ] >user #perf @orders Retry for how long?",
  "- #risk not a tag on notes → no answer on notes",
  "  → notes take no answer line",
  "- [ ] #risk",
  "",
].join("\n");

test("parses questions, answers, tags, targets and notes", () => {
  assert.deepEqual(parseNotes(source), [
    { kind: "question", text: "Can payment retry?", done: false, tag: "risk", target: "orders" },
    {
      kind: "question",
      text: "Token TTL, gateway → auth?",
      answer: "5 min",
      done: true,
      target: "gateway->auth",
    },
    {
      kind: "question",
      text: "Retry for how long?",
      done: false,
      tag: "perf",
      target: "orders",
      forUser: true,
    },
    { kind: "note", text: "#risk not a tag on notes → no answer on notes", done: false },
    { kind: "question", text: "#risk", done: false },
  ]);
});

test("adds, updates and removes entries and keeps other lines", () => {
  const [question, resolved, forUser] = parseNotes(source);
  assert.ok(question && resolved && forUser);
  let next = applyNoteOp(source, {
    type: "update-note",
    note: question,
    next: { ...question, tag: undefined, done: true },
  });
  next = applyNoteOp(next, { type: "remove-note", note: resolved });
  next = applyNoteOp(next, {
    type: "update-note",
    note: forUser,
    next: { ...forUser, answer: "Three times", done: true },
  });
  next = applyNoteOp(next, {
    type: "add-note",
    note: { kind: "question", text: "Who owns it?", done: false, tag: "perf" },
  });
  assert.equal(
    next,
    [
      "# Notes",
      "- [x] @orders Can payment retry?",
      "- [x] >user #perf @orders Retry for how long?",
      "  → Three times",
      "- #risk not a tag on notes → no answer on notes",
      "  → notes take no answer line",
      "- [ ] #risk",
      "- [ ] #perf Who owns it?",
      "",
    ].join("\n"),
  );
});
