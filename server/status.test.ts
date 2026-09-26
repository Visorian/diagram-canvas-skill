import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { diagramStatus } from "./status.ts";

test("reports questions, marks and unknown references, and fails only on invalid lines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "diagram-canvas-skill-status-"));
  try {
    assert.deepEqual(await diagramStatus(dir), {
      text: `No diagrams in ${dir} yet.`,
      failed: false,
    });

    await writeFile(join(dir, "shop.txt"), "# tag: risk #d97706\norders: Orders\n");
    await writeFile(join(dir, "shop.marks"), "orders\nghost\n");
    await writeFile(
      join(dir, "shop.notes.md"),
      "- [ ] #risk @orders Retry?\n- [ ] #gone @missing Who?\n- [x] Done?\n- A note\n",
    );
    assert.deepEqual(await diagramStatus(dir), {
      text: [
        "shop: 1 nodes, 0 edges, 2 open questions, 2 other notes",
        "  marked: orders (Orders), ghost",
        "  ? #risk @orders (Orders) Retry?",
        "  ? #gone @missing Who?",
        "  unknown target: missing",
        "  unknown target: ghost",
        "  unknown tag: gone",
      ].join("\n"),
      failed: false,
    });

    await writeFile(join(dir, "shop.txt"), "orders: Orders [blob]\n");
    assert.equal((await diagramStatus(dir)).failed, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
