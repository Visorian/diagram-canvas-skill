import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { exportPage, exportSvg } from "./export.ts";

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

test("exports an animated SVG comparison with escaped text and stationary removed edges", async () => {
  const dir = await mkdtemp(join(tmpdir(), "diagram-canvas-skill-svg-"));
  try {
    await writeFile(
      join(dir, "before.txt"),
      "# layout: sequence\na: A\nb: B\na => b: old\nc: C <script>\nc -> c: direct apply\n",
    );
    await writeFile(
      join(dir, "after.txt"),
      "# layout: sequence\na: A\nb: B\nc: C <script>\na => c: new & checked\nc => c: validate\nc -> c: apply\n",
    );
    await writeFile(
      join(dir, "after.notes.md"),
      "- @c </title><script>alert(1)</script>\u0000\uD800🚀\n",
    );
    const svg = await exportSvg(dir, "after", "before");
    assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    assert.match(svg, /C &lt;script&gt;/);
    assert.match(svg, /&lt;\/title&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.ok(!svg.includes("<script"));
    assert.ok(!svg.includes("foreignObject"));
    assert.match(svg, /new &amp; checked/);
    assert.match(svg, /class="legend-label">Added<\/text>/);
    assert.match(svg, /class="legend-label">Changed<\/text>/);
    assert.match(svg, /class="legend-label">Removed<\/text>/);
    assert.match(svg, /class="legend-label">Unchanged<\/text>/);
    assert.doesNotMatch(svg, /Changed operations|data-before=|data-after=/);
    assert.doesNotMatch(svg, /Added:|Changed:|Was:/);
    const loops = [...svg.matchAll(/<path data-edge="(c-&gt;c(?:#\d+)?)" d="([^"]+)"/g)];
    assert.equal(loops.length, 2);
    for (const loop of loops) {
      const xs = [...loop[2]!.matchAll(/[ML](-?[\d.]+),/g)].map((point) => Number(point[1]));
      const label = [
        ...svg.matchAll(/<rect data-label="([^"]+)" x="([^"]+)"[^>]*fill="([^"]+)"/g),
      ].find((candidate) => candidate[1] === loop[1]);
      assert.ok(label);
      assert.ok(Number(label[2]) > Math.max(...xs), "Self-loop label covers the arrow's turn");
      assert.equal(label[3], "none", "Sequence label must not erase an arrow");
    }
    assert.match(svg, /data-edge="a-&gt;c"[^>]+class="flow"/);
    assert.match(svg, /data-edge="c-&gt;c#2"[^>]+class="flow"/);
    assert.match(svg, /data-edge="a-&gt;b"[^>]+stroke-dasharray="5 4"/);
    assert.doesNotMatch(svg, /data-edge="a-&gt;b"[^>]+class="flow"/);
    assert.doesNotMatch(svg, /<animateMotion|<circle class="signal"/);
    assert.match(
      svg,
      /class="dotted-flow sequence-trail"[^>]+stroke-linecap="round" stroke-dasharray="1 8 1 8 1 8 1 /,
    );
    assert.match(svg, /<animate attributeName="stroke-dashoffset" values="28;-/);
    assert.match(svg, /<animate attributeName="opacity"/);
    const timing = [
      ...svg.matchAll(/<animate attributeName="opacity"[^>]+keyTimes="([^"]+)"/g),
    ].map((match) => match[1]);
    assert.deepEqual(timing, ["0;0.333333;1", "0;0.333333;0.666667;1", "0;0.666667;1"]);
    assert.match(svg, /🚀/);
    assert.ok(!svg.includes("\u0000"));
    assert.ok(!svg.includes("\uD800"));
    assert.match(svg, /prefers-reduced-motion/);
    assert.match(svg, /fill="#020617"/);
    assert.ok(!svg.includes("NaN"));
    await assert.rejects(exportSvg(dir), /needs --diagram/);
    await assert.rejects(exportSvg(dir, "missing"), /No diagram found/);
    await assert.rejects(exportSvg(dir, "after", "missing"), /No comparison diagram found/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("exports the single diagram and refuses invalid models", async () => {
  const dir = await mkdtemp(join(tmpdir(), "diagram-canvas-skill-svg-"));
  try {
    await writeFile(join(dir, "only.txt"), "a: A\nb: B\na => b: calls\n");
    await writeFile(
      join(dir, "only.notes.md"),
      "- Whole diagram <context>\n- [ ] Confirm & review\n",
    );
    const svg = await exportSvg(dir);
    assert.match(
      svg,
      /<title id="diagram-title">only\nWhole diagram &lt;context&gt;\nConfirm &amp; review<\/title>/,
    );
    assert.match(svg, /data-edge="a-&gt;b"[^>]+class="flow"/);
    assert.match(svg, /class="dotted-flow"[^>]+stroke-dasharray="1 8"/);
    assert.match(svg, /<animate attributeName="stroke-dashoffset" from="0" to="-18"/);
    await writeFile(join(dir, "only.txt"), "not a diagram statement\n");
    await assert.rejects(exportSvg(dir));
    await writeFile(join(dir, "only.txt"), "");
    await assert.rejects(exportSvg(dir), /Cannot export an empty diagram/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("exports architecture diagrams containing only groups and their connections", async () => {
  const dir = await mkdtemp(join(tmpdir(), "diagram-canvas-skill-svg-"));
  try {
    await writeFile(
      join(dir, "only.txt"),
      "# layout: architecture\n[a: Area A]\n[b: Area B]\na => b: calls\n",
    );
    const svg = await exportSvg(dir);
    assert.match(svg, /Area A/);
    assert.match(svg, /Area B/);
    assert.match(svg, /data-edge="a-&gt;b"/);
    assert.doesNotMatch(svg, /NaN|Infinity/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("keeps connection labels clear of nodes and retains full clipped titles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "diagram-canvas-skill-svg-"));
  try {
    const label = "A very long component name that must stay inside its card";
    await writeFile(
      join(dir, "only.txt"),
      `# layout: architecture\n[area: A very long group title with extra context]\na: ${label}\nb: B\na => b: Organization Azure credential\n`,
    );
    const svg = await exportSvg(dir);
    const rectangles = [...svg.matchAll(/<rect\s+([^>]+)\/>/g)].map((match) => {
      const attributes = Object.fromEntries(
        [...match[1]!.matchAll(/([\w-]+)="([^"]+)"/g)].map((attribute) => [
          attribute[1],
          attribute[2],
        ]),
      );
      return {
        x: Number(attributes.x),
        y: Number(attributes.y),
        width: Number(attributes.width),
        height: Number(attributes.height),
        fill: attributes.fill,
        node: attributes["data-node"],
      };
    });
    const nodes = rectangles.filter((rect) => rect.node !== undefined);
    const caption = rectangles.find((rect) => rect.fill === "#020617" && rect.height === 20)!;
    assert.equal(nodes.length, 2);
    for (const node of nodes)
      assert.ok(
        caption.x + caption.width <= node.x ||
          node.x + node.width <= caption.x ||
          caption.y + caption.height <= node.y ||
          node.y + node.height <= caption.y,
        "Connection label overlaps a node",
      );
    assert.ok(svg.includes(`<title>${label}</title>`));
    assert.match(svg, /clip-path="url\(#node-label-a\)"/);
    assert.match(svg, /clip-path="url\(#group-label-area\)"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("skips connections to empty groups as the canvas does", async () => {
  const dir = await mkdtemp(join(tmpdir(), "diagram-canvas-skill-svg-"));
  try {
    await writeFile(join(dir, "only.txt"), "[empty]\n[full]\na: A\na => empty\n");
    const svg = await exportSvg(dir);
    assert.match(svg, /<title>A<\/title>/);
    assert.ok(!svg.includes('data-edge="a-&gt;empty"'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
