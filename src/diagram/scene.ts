// Scene: where a laid-out diagram draws its edges and their labels, for read-only views such as the
// SVG export and comparisons. A label goes just above a horizontal stretch of its route, beside a
// vertical one, or further above as a callout, clear of nodes, group headers, arrowheads, other
// labels and every line but its own. Where a grid has no such place, the grid makes room. That moves
// nodes, so the canvas only uses a scene while it compares, where nothing is edited.
// Nothing here needs Vue, a DOM or Node, and `labelWidth` measures label text.
import { compare, type Change, type Comparison } from "./compare";
import { labelWidth as estimatedWidth } from "./connections";
import {
  edgeId,
  kinds,
  type Diagram,
  type DiagramEdge,
  type Kind,
  type Layout,
  type Position,
} from "./format";
import {
  groupHeader,
  nodeSize,
  trackClearance,
  type AutoLayout,
  type Box,
  type Channel,
  type Extra,
} from "./grid";

export interface SceneOptions {
  // The width of a label's box for its text; by default an estimate for 11px sans-serif text.
  labelWidth?: (text: string) => number;
  // Labels longer than this many characters are shortened and end in an ellipsis.
  labelLimit?: number;
  // Other texts by edge id whose room a label keeps too, such as its other version's.
  reserved?: ReadonlyMap<string, string>;
  // The length and width of an arrowhead, which labels keep clear of.
  arrowSize?: number;
}

export interface EdgeLabel {
  // The shortened label in a box `width` wide and `labelHeight` high, centered at `at`.
  text: string;
  at: Position;
  width: number;
  // Where its leader meets the route; the label's own height when it has no leader.
  routeY: number;
}

export interface SceneEdge {
  id: string;
  edge: DiagramEdge;
  points: Position[];
  label?: EdgeLabel;
}

export interface Scene {
  // The layout the scene is drawn on, which may have more room than the first one.
  layout: AutoLayout;
  // The edges whose ends are drawn, in diagram order.
  edges: SceneEdge[];
}

export const labelHeight = 20;
export const labelLimit = 28;
const radius = 8;
// Gaps of a label to the line it sits above or beside, and to nodes, lines and other labels.
const aboveGap = 3;
const besideGap = 8;
const nodeClearance = 4;
const lineClearance = 6;
const labelClearance = 4;
// Callouts step this far from their line, up to `calloutReach` away; a crowded channel grows by
// `step` at a time, at most `maxGrowth` times.
const step = 24;
const calloutReach = aboveGap + labelHeight / 2 + 4 * step;
const maxGrowth = 3;
// A sequence's labels sit this far above their steps, which move down as far to leave them room.
const sequenceLift = 16;

export function shortLabel(label: string, limit = labelLimit) {
  const characters = Array.from(label);
  return characters.length <= limit
    ? label
    : `${characters
        .slice(0, limit - 1)
        .join("")
        .trimEnd()}…`;
}

const round = (value: number) => Number(value.toFixed(2));

// An SVG path through an orthogonal polyline, with each corner rounded like a smooth step edge.
export function roundedPath(points: Position[]) {
  return points
    .map(([x, y], index) => {
      const previous = points[index - 1];
      const next = points[index + 1];
      if (!previous || !next) return `${index === 0 ? "M" : "L"}${round(x)},${round(y)}`;
      const r = Math.min(
        radius,
        Math.hypot(x - previous[0], y - previous[1]) / 2,
        Math.hypot(next[0] - x, next[1] - y) / 2,
      );
      const before = [x - Math.sign(x - previous[0]) * r, y - Math.sign(y - previous[1]) * r];
      const after = [x + Math.sign(next[0] - x) * r, y + Math.sign(next[1] - y) * r];
      return `L${before.map(round).join(",")} Q${round(x)},${round(y)} ${after.map(round).join(",")}`;
    })
    .join(" ");
}

export interface VersionComparison extends Comparison {
  // The base's labels of changed edges, for `SceneOptions.reserved`.
  reserved: Map<string, string>;
}

// Like `compare`, but two versions that don't differ are no comparison. A changed edge's label keeps
// room for its label in the base too, so that showing either version moves nothing.
export function compareVersions(
  base: { diagram: Diagram; layout: Layout },
  current: { diagram: Diagram; layout: Layout },
): VersionComparison | undefined {
  const comparison = compare(base, current);
  if (comparison.changes.size === 0) return undefined;
  const reserved = new Map(
    base.diagram.edges.flatMap((edge): [string, string][] => {
      const id = edgeId(edge);
      return comparison.changes.get(id) === "changed" ? [[id, edge.label]] : [];
    }),
  );
  return { ...comparison, reserved };
}

export type LegendMark = Kind | "animated" | Change;

// What a view of `diagram` draws that a legend explains, so it lists only those: the kinds of its
// nodes, animated edges, and the changes it highlights.
export function legendMarks(
  diagram: Diagram,
  changes: ReadonlyMap<string, Change> = new Map(),
): LegendMark[] {
  const highlighted = new Set(changes.values());
  return [
    ...kinds.filter((kind) => diagram.nodes.some((node) => node.kind === kind)),
    ...(diagram.edges.some((edge) => edge.animated) ? (["animated"] as const) : []),
    ...(["added", "changed", "removed"] as const).filter((change) => highlighted.has(change)),
  ];
}

type Segment = [Position, Position];

interface Placement {
  at: Position;
  routeY: number;
  box: Box;
  // The segment the label belongs to; only it may touch the label and its leader.
  anchor: Segment;
}

// Where a crowded label needs room: the horizontal channel its stretch belongs to, and the column
// gap it sits in when that gap is narrower than the label and the stretch runs down it or between
// neighbors in a row.
interface Room {
  channel: number;
  gap?: number;
}

const intersects = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const widened = (box: Box, by: number): Box => ({
  x: box.x - by,
  y: box.y - by,
  width: box.width + 2 * by,
  height: box.height + 2 * by,
});

const spanOf = ([[x1, y1], [x2, y2]]: Segment): Box => ({
  x: Math.min(x1, x2),
  y: Math.min(y1, y2),
  width: Math.abs(x2 - x1),
  height: Math.abs(y2 - y1),
});

const lengthOf = ([[x1, y1], [x2, y2]]: Segment) => Math.abs(x2 - x1) + Math.abs(y2 - y1);

// The box of the arrowhead where a route ends.
function arrowOf(route: Segment[], size: number): Box {
  const [[x1, y1], [x2, y2]] = route.at(-1)!;
  const [dx, dy] = [Math.sign(x2 - x1), Math.sign(y2 - y1)];
  return {
    x: Math.min(x2, x2 - dx * size) - (dx === 0 ? size / 2 : 0),
    y: Math.min(y2, y2 - dy * size) - (dy === 0 ? size / 2 : 0),
    width: size,
    height: size,
  };
}

// The vertical line from a label to its route, as a box without width.
function leaderOf({ at: [x], routeY, box }: Placement): Box | undefined {
  const bottom = box.y + box.height;
  if (routeY > bottom) return { x, y: bottom, width: 0, height: routeY - bottom };
  if (routeY < box.y) return { x, y: routeY, width: 0, height: box.y - routeY };
  return undefined;
}

// Centers for a label of `size` along `[low, high]`, the middle first and then outward. A label
// longer than the stretch overhangs it; its center then moves along the stretch in fine steps,
// which lets it slip past lines next to a narrow gap.
const fineStep = 4;
function stops(low: number, high: number, size: number): number[] {
  const middle = (low + high) / 2;
  const fits = high - low > size;
  const from = fits ? low + size / 2 : low + fineStep;
  const to = fits ? high - size / 2 : high - fineStep;
  if (to <= from) return [middle];
  const count = Math.min(fits ? 8 : 16, Math.ceil((to - from) / (fits ? step : fineStep)));
  return [
    middle,
    ...Array.from({ length: count + 1 }, (_, index) => from + ((to - from) * index) / count),
  ].toSorted((a, b) => Math.abs(a - middle) - Math.abs(b - middle));
}

// Stretches of a segment no other route runs along, so a label there names a single edge.
function ownPieces(segment: Segment, others: Segment[]): [number, number][] {
  const axis = segment[0][1] === segment[1][1] ? 0 : 1;
  const extent = ([a, b]: Segment): [number, number] =>
    a[axis] < b[axis] ? [a[axis], b[axis]] : [b[axis], a[axis]];
  const covered = others
    .filter(([a, b]) => a[1 - axis] === segment[0][1 - axis] && b[1 - axis] === a[1 - axis])
    .map(extent)
    .toSorted((a, b) => a[0] - b[0]);
  const [low, high] = extent(segment);
  const pieces: [number, number][] = [];
  let from = low;
  for (const [start, end] of covered) {
    if (start > from) pieces.push([from, Math.min(start, high)]);
    from = Math.max(from, end);
  }
  if (from < high) pieces.push([from, high]);
  return pieces.filter(([start, end]) => end > start);
}

// Where a label may go, best first: just above a horizontal stretch of its route, beside a
// vertical one, then as a callout further above. Below its route only when `below` allows.
function candidates(
  route: Segment[],
  others: Segment[],
  width: number,
  obstacles: Box[],
  below: boolean,
) {
  const segments = route.toSorted((a, b) => lengthOf(b) - lengthOf(a));
  const horizontal = segments.filter(([[x1, y1], [x2, y2]]) => y1 === y2 && x1 !== x2);
  const vertical = segments.filter(([[x1, y1], [x2, y2]]) => x1 === x2 && y1 !== y2);
  const place = (anchor: Segment, x: number, y: number, routeY: number): Placement => ({
    at: [x, y],
    routeY,
    box: { x: x - width / 2, y: y - labelHeight / 2, width, height: labelHeight },
    anchor,
  });
  const nearest = aboveGap + labelHeight / 2;
  // Distances of a label's center from its line: next to it, in steps, and just past obstacles.
  const distances = (line: number, direction: -1 | 1) =>
    [
      ...[1, 2, 3, 4].map((count) => nearest + count * step),
      ...obstacles.map((box) =>
        direction < 0
          ? line - (box.y - nodeClearance - labelHeight / 2)
          : box.y + box.height + nodeClearance + labelHeight / 2 - line,
      ),
    ]
      .filter((distance) => distance > nearest && distance <= calloutReach)
      .toSorted((a, b) => a - b);
  const across = (direction: -1 | 1, callouts: boolean) =>
    horizontal
      .flatMap((anchor) => {
        const line = anchor[0][1];
        const xs = ownPieces(anchor, others).flatMap(([low, high]) => stops(low, high, width));
        return (callouts ? distances(line, direction) : [nearest]).flatMap((distance) =>
          xs.map((x) => ({
            distance,
            placement: place(anchor, x, line + direction * distance, line),
          })),
        );
      })
      .toSorted((a, b) => a.distance - b.distance)
      .map(({ placement }) => placement);
  const beside = vertical.flatMap((anchor) => {
    const line = anchor[0][0];
    const ys = ownPieces(anchor, others).flatMap(([low, high]) => stops(low, high, labelHeight));
    return ys.flatMap((y) =>
      [1, -1].map((side) => place(anchor, line + side * (besideGap + width / 2), y, y)),
    );
  });
  const preferred = [...across(-1, false), ...beside, ...across(-1, true)];
  // A route without length still gets its label, at its start.
  const [x, y] = route[0]?.[0] ?? [0, 0];
  return {
    preferred:
      preferred.length > 0
        ? preferred
        : [
            place(
              route[0] ?? [
                [x, y],
                [x, y],
              ],
              x,
              y,
              y,
            ),
          ],
    fallback: below ? [...across(1, false), ...across(1, true)] : [],
  };
}

// The extent of a channel between what borders it.
const extentOf = ({ at, room }: Channel): [number, number] => [
  at - room / 2 - trackClearance,
  at + room / 2 + trackClearance,
];

function roomFor(
  [[x1, y1], [x2, y2]]: Segment,
  width: number,
  { vertical, horizontal }: NonNullable<AutoLayout["channels"]>,
): Room {
  const y = (y1 + y2) / 2;
  // The channel the stretch runs in, or, in a row, the one above it.
  const channel = Math.max(
    0,
    horizontal.findLastIndex((at) => extentOf(at)[0] <= y),
  );
  const inChannel = horizontal.some((at) => {
    const [top, bottom] = extentOf(at);
    return top <= y && y <= bottom;
  });
  if (x1 !== x2 && inChannel) return { channel };
  // The nearest gap between two columns; the outer ones separate nothing.
  const gap = vertical
    .map((at, index) => ({
      index,
      extent: extentOf(at),
      distance: Math.abs(at.at - (x1 + x2) / 2),
    }))
    .slice(1, -1)
    .toSorted((a, b) => a.distance - b.distance)[0];
  return gap && gap.extent[1] - gap.extent[0] < width + 2 * nodeClearance
    ? { channel, gap: gap.index }
    : { channel };
}

interface Settings {
  measure: (text: string) => number;
  limit: number;
  reserved: ReadonlyMap<string, string>;
  arrowSize: number;
}

// In a sequence, the steps, timelines and group boxes move down to leave the labels room.
const lift = (values: Record<string, number> = {}) =>
  Object.fromEntries(Object.entries(values).map(([id, value]) => [id, value + sequenceLift]));

function lifted(auto: AutoLayout): AutoLayout {
  return {
    ...auto,
    connections: Object.fromEntries(
      Object.entries(auto.connections).map(([id, connection]) => [
        id,
        {
          ...connection,
          points: connection.points.map(([x, y]): Position => [x, y + sequenceLift]),
          label: [connection.label[0], connection.label[1] + sequenceLift],
        },
      ]),
    ),
    groups: auto.groups.map(({ id, box }) => ({
      id,
      box: { ...box, height: box.height + sequenceLift },
    })),
    steps: lift(auto.steps),
    timelines: lift(auto.timelines),
  };
}

// Places every label on one layout; `below` lists the edges whose labels may go below their routes,
// or all when true. `crowded` holds the edges whose labels found no place, with the room that would
// help them in a grid.
function placeAll(
  diagram: Diagram,
  auto: AutoLayout,
  settings: Settings,
  below: ReadonlySet<string> | true,
) {
  const sequence = auto.steps !== undefined;
  const nodeBoxes = diagram.nodes.flatMap((node) => {
    const position = auto.positions[node.id];
    return position ? [{ x: position[0], y: position[1], ...nodeSize }] : [];
  });
  const headers = auto.groups.map(({ box }) => ({ ...box, height: groupHeader }));
  const boxOf = (id: string): Box | undefined => {
    const position = auto.positions[id];
    return position
      ? { x: position[0], y: position[1], ...nodeSize }
      : auto.groups.find((group) => group.id === id)?.box;
  };
  const routed = diagram.edges.flatMap((edge) => {
    const source = boxOf(edge.source);
    const target = boxOf(edge.target);
    if (!source || !target) return [];
    const id = edgeId(edge);
    // Without a connection, a plain step from the bottom of the source to the top of a node.
    const sx = source.x + source.width / 2;
    const sy = source.y + source.height;
    const tx = target.x + target.width / 2;
    const ty = target.y + target.height - nodeSize.height;
    const points: Position[] = auto.connections[id]?.points ?? [
      [sx, sy],
      [sx, (sy + ty) / 2],
      [tx, (sy + ty) / 2],
      [tx, ty],
    ];
    return [{ id, edge, points }];
  });
  const segmented = routed.map(({ points }) =>
    points.slice(1).map((to, index): Segment => [points[index]!, to]),
  );
  const lines = segmented.flat();
  const blocked: Box[] = [
    ...nodeBoxes.map((box) => widened(box, nodeClearance)),
    ...headers,
    ...segmented
      .filter((route) => route.length > 0)
      .map((route) => arrowOf(route, settings.arrowSize)),
  ];
  // A label clears nodes, headers, arrowheads, other labels and their leaders, and every line but
  // the one it sits on; its leader does too.
  const clear = (placement: Placement) => {
    const leader = leaderOf(placement);
    return (leader ? [placement.box, leader] : [placement.box]).every(
      (part) =>
        !blocked.some((box) => intersects(part, box)) &&
        !lines.some(
          (line) =>
            line !== placement.anchor && intersects(part, widened(spanOf(line), lineClearance)),
        ),
    );
  };
  const crowded = new Map<string, Room | undefined>();
  const edges = routed.map(({ id, edge, points }, index): SceneEdge => {
    if (!edge.label) return { id, edge, points };
    const text = shortLabel(edge.label, settings.limit);
    const reserved = settings.reserved.get(id);
    const width = Math.max(
      settings.measure(text),
      reserved === undefined ? 0 : settings.measure(shortLabel(reserved, settings.limit)),
    );
    if (sequence) {
      // A step's label sits above it, a loop's beside its turn.
      const [x, y] = auto.connections[id]?.label ?? points[0]!;
      const at: Position =
        edge.source === edge.target
          ? [Math.max(...points.map(([px]) => px)) + 14 + width / 2, y]
          : [x, y - sequenceLift];
      return { id, edge, points, label: { text, at, width, routeY: at[1] } };
    }
    const route = segmented[index]!;
    const { preferred, fallback } = candidates(
      route,
      lines.filter((line) => !route.includes(line)),
      width,
      [...nodeBoxes, ...headers],
      below === true || below.has(id),
    );
    let placement = preferred.find(clear) ?? fallback.find(clear);
    if (!placement) {
      placement = preferred[0]!;
      crowded.set(id, auto.channels && roomFor(placement.anchor, width, auto.channels));
    }
    const leader = leaderOf(placement);
    for (const part of leader ? [placement.box, leader] : [placement.box])
      blocked.push(widened(part, labelClearance));
    return { id, edge, points, label: { text, at: placement.at, width, routeY: placement.routeY } };
  });
  return { edges, crowded };
}

// Lays the diagram out with `layout` and places every label. Where a label finds no place near its
// route, the grid repeats with more room: the column gap the label sits in widens until the label
// fits across it, else the channel its route runs in grows, up to three times. Nothing runs above
// the first row, so a label there may go below its route instead, and when growing stops helping,
// any label may. Layouts without channels don't grow, and a sequence keeps its labels above its
// steps.
export function scene(
  diagram: Diagram,
  layout: (extra: Extra) => AutoLayout,
  options: SceneOptions = {},
): Scene {
  const settings: Settings = {
    measure: options.labelWidth ?? estimatedWidth,
    limit: options.labelLimit ?? labelLimit,
    reserved: options.reserved ?? new Map(),
    arrowSize: options.arrowSize ?? 10,
  };
  const extra = { vertical: [] as number[], horizontal: [] as number[] };
  const below = new Set<string>();
  for (;;) {
    const laid = layout(extra);
    const auto = laid.steps ? lifted(laid) : laid;
    const { edges, crowded } = placeAll(diagram, auto, settings, below);
    const widening = new Set<number>();
    const growing = new Set<number>();
    for (const [id, room] of crowded) {
      if (!room) continue;
      const { channel, gap } = room;
      if (gap !== undefined) {
        widening.add(gap);
        continue;
      }
      if (channel === 0) below.add(id);
      const index = Math.max(channel, 1);
      if ((extra.horizontal[index] ?? 0) < maxGrowth * step) growing.add(index);
    }
    if (widening.size === 0 && growing.size === 0) {
      return {
        layout: auto,
        edges: crowded.size === 0 ? edges : placeAll(diagram, auto, settings, true).edges,
      };
    }
    for (const index of widening) extra.vertical[index] = (extra.vertical[index] ?? 0) + step;
    for (const index of growing) extra.horizontal[index] = (extra.horizontal[index] ?? 0) + step;
  }
}
