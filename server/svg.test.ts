import assert from "node:assert/strict";
import { test } from "node:test";
import type { DiagramFiles } from "../src/diagram/format.ts";
import { renderSvg } from "./svg.ts";

const files = (source: string): DiagramFiles => ({
  name: "comparison",
  source,
  layout: {},
  notes: "",
  marks: [],
});

test("shows the same visible change legend in every comparison layout", () => {
  for (const layout of ["flow", "architecture", "sequence"]) {
    const before = files(`# layout: ${layout}\na: A\nb: B\nc: C\na => b: Before\nb => c: Stable\n`);
    const after = files(`# layout: ${layout}\na: A\nb: B\nc: C\na => b: After\nb => c: Stable\n`);
    const svg = renderSvg(after, before);
    for (const label of ["Added", "Changed", "Removed", "Unchanged"])
      assert.ok(svg.includes(`class="legend-label">${label}</text>`), `${layout}: ${label}`);
    assert.match(svg, /data-edge="a-&gt;b"[^>]+stroke="#60a5fa"/);
    assert.match(svg, /data-edge="b-&gt;c"[^>]+stroke="#64748b"/);
    assert.doesNotMatch(svg, /Changed operations|data-before=|data-after=|foreignObject|<script/);
  }
});

test("separates a removed direct dependency from an added two-hop architecture chain", () => {
  const before = files(
    "# layout: architecture\napp: Application\nmigrate: Migration job\napp => migrate: Depends on\n",
  );
  const after = files(
    "# layout: architecture\napp: Application\nseed: Seed job\nmigrate: Migration job\napp => seed: Depends on\nseed => migrate: Depends on\n",
  );
  const svg = renderSvg(after, before);
  const paths = [...svg.matchAll(/<path data-edge="([^"]+)" d="([^"]+)"/g)].map((match) => ({
    id: match[1],
    points: [...match[2]!.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map((point) => [
      Number(point[1]),
      Number(point[2]),
    ]),
  }));
  const labels = [
    ...svg.matchAll(
      /<rect data-label="([^"]+)" x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/g,
    ),
  ].map((match) => ({
    id: match[1],
    x: Number(match[2]),
    y: Number(match[3]),
    width: Number(match[4]),
    height: Number(match[5]),
  }));
  assert.equal(paths.length, 3);
  assert.equal(labels.length, 3);
  for (const id of ["app-&gt;seed", "seed-&gt;migrate"]) {
    const path = paths.find((candidate) => candidate.id === id)!;
    const label = labels.find((candidate) => candidate.id === id)!;
    assert.ok(path.points.every(([, y]) => y === path.points[0]![1]));
    assert.equal(label.y + label.height / 2, path.points[0]![1]);
    assert.ok(label.x > Math.min(...path.points.map(([x]) => x!)));
    assert.ok(label.x + label.width < Math.max(...path.points.map(([x]) => x!)));
  }
  const removed = labels.find((label) => label.id === "app-&gt;migrate")!;
  for (const added of labels.filter((label) => label !== removed))
    assert.ok(removed.y >= added.y + added.height + 16);
  assert.match(svg, /data-edge="app-&gt;migrate"[^>]+stroke="#f6459d"[^>]+stroke-dasharray="5 4"/);
  assert.match(svg, /data-edge="app-&gt;seed"[^>]+stroke="#40c1ac"[^>]+class="flow"/);
  assert.match(svg, /data-edge="seed-&gt;migrate"[^>]+stroke="#40c1ac"[^>]+class="flow"/);
});
