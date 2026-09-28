import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { exportPage } from "./export.ts";

test("embeds the diagrams so that no diagram text can break out of the page", async () => {
  const dir = await mkdtemp(join(tmpdir(), "diagram-canvas-skill-export-"));
  try {
    await writeFile(join(dir, "shop.txt"), "orders: Orders\n");
    await writeFile(join(dir, "shop.notes.md"), "- @orders Ends with </script><b>bold</b>\n");
    await writeFile(join(dir, "shop.layout.json"), '{"orders": [10, 20]}\n');
    await writeFile(join(dir, "billing.txt"), "a: A\n");
    await writeFile(join(dir, "shop.handoff"), "not published\n");

    const page = "<html><head><script>/* <head> */</script></head><body></body></html>";
    const { html, names } = await exportPage(page, dir);
    assert.deepEqual(names, ["billing", "shop"]);

    const [, data] =
      /^<html><head><script type="application\/json" id="diagram-data">(.*?)<\/script><script>/.exec(
        html,
      ) ?? [];
    assert.ok(data, html);
    assert.ok(!data.includes("<"));
    assert.deepEqual(JSON.parse(data), [
      { name: "billing", source: "a: A\n", layout: {}, notes: "", marks: [] },
      {
        name: "shop",
        source: "orders: Orders\n",
        layout: { orders: [10, 20] },
        notes: "- @orders Ends with </script><b>bold</b>\n",
        marks: [],
      },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
