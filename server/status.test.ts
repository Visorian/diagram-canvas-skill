import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { diagramStatus } from "./status.ts";

async function withDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "diagram-canvas-skill-status-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("reports questions, marks and unknown references, and fails only on invalid lines", () =>
  withDir(async (dir) => {
    assert.equal((await diagramStatus(dir)).text, `No diagrams in ${dir} yet.`);

    await writeFile(join(dir, "shop.txt"), "# tag: risk #d97706\norders: Orders\n");
    await writeFile(join(dir, "shop.marks"), "orders\nghost\n");
    await writeFile(
      join(dir, "shop.notes.md"),
      [
        "- [ ] #risk @orders Retry?",
        "- [ ] >user #gone @missing Who?",
        "- [x] Done?",
        "  → Yes",
        "- A note",
        "",
      ].join("\n"),
    );
    const status = await diagramStatus(dir);
    assert.equal(
      status.text,
      [
        "shop: 1 nodes, 0 edges, 2 open questions (1 for the user), 1 resolved, 1 notes",
        "  marked: orders (Orders), ghost",
        "  ? #risk @orders (Orders) Retry?",
        "  ? >user #gone @missing Who?",
        "  unknown target: missing",
        "  unknown target: ghost",
        "  unknown tag: gone",
      ].join("\n"),
    );
    assert.equal(status.failed, false);

    await writeFile(join(dir, "shop.txt"), "orders: Orders [blob]\n");
    assert.equal((await diagramStatus(dir)).failed, true);
  }));

test("lists what changed since the previous status", () =>
  withDir(async (dir) => {
    await writeFile(join(dir, "shop.txt"), "api: API\ndb: DB [db]\napi -> db\n");
    await writeFile(join(dir, "shop.notes.md"), "- [ ] >user @db Which engine?\n- Old note\n");
    await writeFile(join(dir, "old.txt"), "a: A\n");
    const { snapshot } = await diagramStatus(dir);

    await writeFile(
      join(dir, "shop.txt"),
      "api: Gateway\ndb: DB [db]\napi -> db: SQL\nq: Q [queue]\n",
    );
    await writeFile(join(dir, "shop.notes.md"), "- [x] >user @db Which engine?\n  → Postgres\n");
    await writeFile(join(dir, "shop.marks"), "q\n");
    await writeFile(join(dir, "billing.txt"), "a: A\n");
    await rm(join(dir, "old.txt"));

    assert.equal(
      (await diagramStatus(dir, snapshot)).text,
      [
        "billing: 1 nodes, 0 edges, 0 open questions, 0 resolved, 0 notes",
        "  changed since the last status:",
        "    + new diagram",
        "shop: 3 nodes, 1 edges, 0 open questions, 1 resolved, 0 notes",
        "  marked: q (Q)",
        "  changed since the last status:",
        "    ~ node api: Gateway",
        "    + node q: Q [queue]",
        "    ~ edge api -> db: SQL",
        "    ~ ✓ >user @db (DB) Which engine? → Postgres",
        "    - note Old note",
        "    + mark q (Q)",
        "old: removed since the last status",
      ].join("\n"),
    );
  }));
