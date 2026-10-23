# Using the diagram code in another app

`src/diagram/` holds the parts of the canvas that need no Vue, DOM or Node: the text format, the
grid layouts, comparisons and the scene geometry the SVG export draws. Other apps can copy it and
draw diagrams their own way, for example as SVG elements of their framework.

## What to copy

Copy these files from `src/diagram/` into one folder:

- `index.ts`: the entry point; import everything from here.
- `scene.ts`: where edges and their labels are drawn.
- `grid.ts` and `connections.ts`: grid layouts and the routes of their connections.
- `compare.ts`: two versions of a diagram as one.
- `format.ts` and `notes.ts`: the diagram types and the text format.

Add `layout.ts` for `autoLayout`, which also lays out flows without groups and needs
`@dagrejs/dagre`. Leave out `useDiagram.ts`, which is the canvas's Vue store, and the tests. The
files are TypeScript that resolves imports like a bundler (`moduleResolution: "Bundler"`).

The code is MIT licensed. Keep the [license](../LICENSE) next to the copy and note the commit you
copied from and what you changed. The scene's label placement and room-making started out in such
an adapted copy and moved back here, so improvements to a copy are welcome upstream.

## Drawing a diagram

```ts
import { architectureGrid, nodeSize, parseDiagram, roundedPath, scene } from "./diagram";

const diagram = parseDiagram(
  "# layout: architecture\napi: API\ndb: Orders DB [db]\napi -> db: SQL\n",
);
const { layout, edges } = scene(diagram, (extra) => architectureGrid(diagram, 48, extra), {
  // Optional: measure label text with your font instead of the built-in estimate.
  labelWidth: (text) => canvasContext.measureText(text).width + 12,
});
for (const [id, [x, y]] of Object.entries(layout.positions)) {
  // A node box at x, y of nodeSize.width × nodeSize.height.
}
for (const { id, points, label } of edges) {
  const d = roundedPath(points);
  // label?.text centered at label.at, label.width × labelHeight; a leader runs from label.at down
  // to label.routeY when they differ.
}
```

## API

- `scene(diagram, layout, options?)` lays the diagram out with `layout(extra)` and places every
  edge label: above a horizontal stretch of its route, beside a vertical one, or further above as
  a callout, clear of nodes, group headers, arrowheads, other labels and every other line. When a
  label finds no place, it calls `layout` again with `extra` room: the nearest column gap widens
  until the label fits across it, else the route's channel grows, up to three times; only then may
  a label go below its route. This moves nodes, so use it for read-only views; an editor where
  edits should move nothing lays out with `autoLayout` alone. Layouts without channels, like
  layered flows, don't grow, and sequences keep their labels above their steps. Returns the
  `layout` it ended with and the `edges` whose ends are drawn, each with `points` and an optional
  `label: { text, at, width, routeY }`.
- `SceneOptions`: `labelWidth(text)` for the width of a label's box, `labelLimit` (28) for the
  number of characters after which labels end in an ellipsis, `reserved` for other texts by edge
  id whose room a label keeps too, and `arrowSize` (10) for the arrowheads labels avoid. Keep the
  full label for a tooltip; `edge.label` on each scene edge is unchanged.
- `architectureGrid(diagram, gap?, extra?)`, `flowGrid(diagram, extra?)` and `sequenceGrid(diagram)`
  are the layouts; pass `extra` through from `scene`.
- `compareVersions(base, current)` is `compare` for read-only views: `undefined` when both versions
  are the same, else the `union` to draw, the `changes` by id, and `reserved`, the base labels of
  changed edges, for `SceneOptions.reserved`, so that showing either version moves nothing.
- `legendMarks(diagram, changes?)` lists what a view draws that a legend explains: the node kinds
  present, `"animated"` when an edge is, and the changes it highlights.
- `roundedPath(points)` is an SVG path through the points with rounded corners, as on the canvas.
- `shortLabel(label, limit?)`, `labelWidth(text)`, `labelHeight`, `nodeSize` and `groupHeader` are
  the measures the scene uses.
