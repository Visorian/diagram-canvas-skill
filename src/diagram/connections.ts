// Connections: the drawn paths of the edges on a grid layout (see grid.ts). They run in the
// channels between cells, horizontal ones between rows and vertical ones between columns, and bend
// only there. Legs that share a channel get their own tracks, and the ports where connections meet
// a node or group spread along its side, so parallel connections stay apart.
import { edgeId, type DiagramEdge, type Position } from "./format";
import type { Channel, Slot } from "./grid";
import type { Box, Connection } from "./layout";

// A node or group a connection can end at: its box and the rows and columns of cells it covers.
export interface Terminal {
  box: Box;
  rows: [number, number];
  columns: [number, number];
  // Where a node sits in its row of the column: alone in the middle, or the left or right of two.
  slot: Slot;
}

export interface Grid {
  terminals: Map<string, Terminal>;
  // Node boxes, which connections go around; group boxes they cross.
  obstacles: Box[];
  // Group headers by group id, which labels keep clear of and legs of other groups' connections too.
  headers: Map<string, Box>;
  // Horizontal channel i runs above row i and vertical channel i left of column i; the last ones
  // below the last row and right of the last column.
  horizontal: Channel[];
  vertical: Channel[];
  // In a flow, edges point down, and one pointing up is a back edge that loops around the side of
  // its target. Otherwise connections take the direct way in any direction.
  flow: boolean;
}

type Side = "top" | "bottom" | "left" | "right";
type ChannelRef = { horizontal: number } | { vertical: number };

// The path of a connection: it leaves the source through a port on `sourceSide`, takes turns
// between vertical and horizontal legs, and enters the target through a port on `targetSide`. Each
// bend is where a leg ends: on a track in a channel, in line with the target's port, or midway
// between both ports.
interface Path {
  edge: DiagramEdge;
  id: string;
  sourceSide: Side;
  targetSide: Side;
  bends: (ChannelRef | { target: true } | { midway: true })[];
  // Where along their sides the ports would like to be; the target's depends on the source port.
  sourceToward?: number;
  targetToward: (source: Position) => number;
}

// Ports on the top or bottom of a box keep this far apart and this far from its corners.
const portPitch = 16;
const portInset = 16;
// The same on its left and right.
const sidePortPitch = 12;
const sidePortInset = 14;
const trackPitch = 10;
// Legs in one channel that end at least this far apart can share a track.
const trackGap = 8;
// Distance of a straight leg from the nodes it passes.
const passClearance = 12;
// Estimate of an edge label's box: 11px text plus the padding of its background.
const labelCharWidth = 6.2;
const labelPadding = 12;
const labelHeight = 18;
// Half the width the canvas lets a click on a connection hit it.
const lineClearance = 6;

export function gridConnections(edges: DiagramEdge[], grid: Grid): Record<string, Connection> {
  const loops = edges.filter(
    ({ source, target }) => source === target && grid.terminals.has(source),
  );
  const blocked = ({ points }: { points: Position[] }) => crossesNode(points, grid.obstacles);
  let drawn = drawAll(edges, grid, new Set());
  // Spread ports can bring a straight leg too close to a node; those connections take a channel.
  const retry = drawn.filter(blocked).map(({ id }) => id);
  if (retry.length > 0) drawn = drawAll(edges, grid, new Set(retry));
  // What still meets a node is left to the canvas.
  drawn = drawn.filter((connection) => !blocked(connection));
  const labels = placeLabels(drawn, grid);
  const corner = (id: string): Position => {
    const { x, y } = grid.terminals.get(id)!.box;
    return [x, y];
  };
  const connections: Record<string, Connection> = Object.fromEntries(
    drawn.map(({ id, edge, points }) => [
      id,
      { points, label: labels.get(id)!, source: corner(edge.source), target: corner(edge.target) },
    ]),
  );
  // A loop goes out on the side facing a channel: the left one of two nodes in a row turns left.
  for (const edge of loops) {
    const { box, slot } = grid.terminals.get(edge.source)!;
    connections[edgeId(edge)] = {
      ...loop(box, slot === "left" ? "left" : "right", edge.label),
      source: corner(edge.source),
      target: corner(edge.source),
    };
  }
  return connections;
}

// How far a loop reaches out from its node and how far apart its ends are.
const loopReach = 36;
const loopSpan = 20;

export const labelWidth = (label: string) =>
  Math.max(label.length, 1) * labelCharWidth + labelPadding;

// A loop leaves the side of a box and comes back to it a little lower, with its label beside it.
export function loop(box: Box, side: "left" | "right", label: string) {
  const x = side === "right" ? box.x + box.width : box.x;
  const out = side === "right" ? x + loopReach : x - loopReach;
  const y = Math.round(box.y + box.height / 2);
  const beside = out + Math.sign(out - x) * (6 + labelWidth(label) / 2);
  return loopAt(x, out, y, beside);
}

const loopAt = (x: number, out: number, y: number, labelX: number) => ({
  points: [
    [x, y - loopSpan / 2],
    [out, y - loopSpan / 2],
    [out, y + loopSpan / 2],
    [x, y + loopSpan / 2],
  ] as Position[],
  label: [Math.round(labelX), y] as Position,
});

// A step of a sequence: straight across its row at `y` from the source's column to the target's,
// or, for a loop, out to the right of the column and back.
export function step(sourceX: number, targetX: number, y: number, label: string, isLoop: boolean) {
  if (isLoop) {
    const out = sourceX + loopReach;
    return loopAt(sourceX, out, y, out + 6 + labelWidth(label) / 2);
  }
  return {
    points: [
      [sourceX, y],
      [targetX, y],
    ] as Position[],
    label: [Math.round((sourceX + targetX) / 2), y] as Position,
  };
}

function drawAll(edges: DiagramEdge[], grid: Grid, viaChannel: Set<string>) {
  const paths = edges.flatMap((edge) => {
    const path = planPath(edge, grid, viaChannel.has(edgeId(edge)));
    return path ? [path] : [];
  });
  const ports = placePorts(paths, grid);
  const walkWith = (path: Path, at: (channel: ChannelRef, index: number) => number) =>
    walk(path, ports.get(`${path.id} source`)!, ports.get(`${path.id} target`)!, at);
  const tracks = assignTracks(
    paths,
    (path) => walkWith(path, (ref) => channel(grid, ref).at),
    grid,
  );
  return paths.map((path) => ({
    id: path.id,
    edge: path.edge,
    points: withoutStraightBends(
      walkWith(
        path,
        (ref, index) => tracks.get(trackKey(path, ref, index)) ?? channel(grid, ref).at,
      ),
    ),
  }));
}

const channel = (grid: Grid, ref: ChannelRef) =>
  "horizontal" in ref ? grid.horizontal[ref.horizontal]! : grid.vertical[ref.vertical]!;

const bottomOf = (box: Box) => box.y + box.height;

const encloses = (outer: Box, inner: Box) =>
  outer.x <= inner.x &&
  outer.y <= inner.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  bottomOf(inner) <= bottomOf(outer);

// The shape of a path, from the rows and columns its ends cover.
function planPath(edge: DiagramEdge, grid: Grid, viaChannel: boolean): Path | undefined {
  const { source, target } = edge;
  const from = grid.terminals.get(source);
  const to = grid.terminals.get(target);
  // A group and what it holds are drawn around each other, not connected.
  if (!from || !to || source === target) return undefined;
  if (encloses(from.box, to.box) || encloses(to.box, from.box)) return undefined;
  const id = edgeId(edge);
  const fromX = from.box.x + from.box.width / 2;
  const toX = to.box.x + to.box.width / 2;
  const toY = to.box.y + to.box.height / 2;
  const path = (
    sourceSide: Side,
    targetSide: Side,
    bends: Path["bends"],
    targetToward: Path["targetToward"] = ([x]) => x,
  ): Path => ({ edge, id, sourceSide, targetSide, bends, targetToward });
  // A vertical leg at `x` between two heights that keeps clear of every node.
  // Headers of groups the path neither starts nor ends in, which a leg shouldn't cross.
  const holds = (group: string, box: Box) => {
    const outer = grid.terminals.get(group)?.box;
    return outer !== undefined && encloses(outer, box);
  };
  const blockers = [
    ...grid.obstacles,
    ...[...grid.headers]
      .filter(([group]) => !holds(group, from.box) && !holds(group, to.box))
      .map(([, header]) => header),
  ];
  const passes = (x: number, top: number, bottom: number) =>
    blockers.every(
      (box) =>
        bottomOf(box) <= top ||
        box.y >= bottom ||
        x <= box.x - passClearance ||
        x >= box.x + box.width + passClearance,
    );
  const inLine = Math.min(
    Math.max(fromX, to.box.x + portInset),
    to.box.x + to.box.width - portInset,
  );
  const byDetour = grid.vertical
    .map(({ at }, index) => ({ at, index, detour: Math.abs(at - fromX) + Math.abs(at - toX) }))
    .toSorted((a, b) => a.detour - b.detour);

  // Past the rows in between: straight down (or up) from the source or into the target where
  // nothing is in the way, else through the vertical channel with the shortest detour that is.
  const across = (
    sourceSide: Side,
    targetSide: Side,
    leaving: number,
    entering: number,
    [top, bottom]: [number, number],
  ) => {
    if (leaving === entering)
      return path(sourceSide, targetSide, [{ horizontal: entering }, { target: true }]);
    if (!viaChannel && passes(fromX, top, bottom))
      return path(sourceSide, targetSide, [{ horizontal: entering }, { target: true }]);
    if (!viaChannel && passes(inLine, top, bottom))
      return path(sourceSide, targetSide, [{ horizontal: leaving }, { target: true }]);
    const { at, index } =
      byDetour.find((candidate) => passes(candidate.at, top, bottom)) ?? byDetour[0]!;
    return path(
      sourceSide,
      targetSide,
      [{ horizontal: leaving }, { vertical: index }, { horizontal: entering }, { target: true }],
      () => at,
    );
  };

  if (to.rows[0] > from.rows[1]) {
    return across("bottom", "top", from.rows[1] + 1, to.rows[0], [bottomOf(from.box), to.box.y]);
  }
  if (to.rows[1] < from.rows[0] && !grid.flow) {
    return across("top", "bottom", from.rows[0], to.rows[1] + 1, [bottomOf(to.box), from.box.y]);
  }
  if (to.rows[1] < from.rows[0]) {
    // A back edge: out below the source, up the vertical channel beside the target and into its
    // side. Of two nodes in a row, each is entered from its outer side, a single one from the
    // source's side.
    const side = to.slot === "single" ? (fromX < toX ? "left" : "right") : to.slot;
    const beside = side === "left" ? to.columns[0] : to.columns[1] + 1;
    return path(
      "bottom",
      side,
      [{ horizontal: from.rows[1] + 1 }, { vertical: beside }, { target: true }],
      () => toY,
    );
  }
  // Rows in common: side by side at the middle of the heights they share when no node is between
  // them, else below both.
  const [left, right] = fromX < toX ? [from.box, to.box] : [to.box, from.box];
  const y = Math.round(
    (Math.max(from.box.y, to.box.y) + Math.min(bottomOf(from.box), bottomOf(to.box))) / 2,
  );
  const between = grid.obstacles.some(
    (box) =>
      box.x >= left.x + left.width &&
      box.x + box.width <= right.x &&
      box.y < y + passClearance &&
      bottomOf(box) > y - passClearance,
  );
  if (left.x + left.width <= right.x && !between) {
    return {
      ...path(fromX < toX ? "right" : "left", fromX < toX ? "left" : "right", [
        { midway: true },
        { target: true },
      ]),
      sourceToward: y,
      targetToward: ([, sourceY]) => sourceY,
    };
  }
  return path("bottom", "bottom", [
    { horizontal: Math.max(from.rows[1], to.rows[1]) + 1 },
    { target: true },
  ]);
}

// The points of a path: its source port, the end of every leg, and its target port. `at` places a
// leg in a channel.
function walk(
  path: Path,
  start: Position,
  end: Position,
  at: (channel: ChannelRef, index: number) => number,
): Position[] {
  const points: Position[] = [start];
  let [x, y] = start;
  let vertical = along(path.sourceSide) === 0;
  path.bends.forEach((bend, index) => {
    const value =
      "target" in bend
        ? end[vertical ? 1 : 0]
        : "midway" in bend
          ? Math.round((start[0] + end[0]) / 2)
          : at(bend, index);
    if (vertical) y = value;
    else x = value;
    points.push([x, y]);
    vertical = !vertical;
  });
  points.push(end);
  return points;
}

// The coordinate ports move along on a side: x on the top and bottom, y on the left and right.
const along = (side: Side) => (side === "top" || side === "bottom" ? 0 : 1);

function sideSpan(box: Box, side: Side): [number, number] {
  return along(side) === 0
    ? [box.x + portInset, box.x + box.width - portInset]
    : [box.y + sidePortInset, bottomOf(box) - sidePortInset];
}

function onSide(box: Box, side: Side, position: number): Position {
  if (side === "top") return [position, box.y];
  if (side === "bottom") return [position, bottomOf(box)];
  if (side === "left") return [box.x, position];
  return [box.x + box.width, position];
}

// Ports of every path, keyed `<id> source` and `<id> target`. Paths that fan out share one port
// (see `fansOut`). Every other port gets its own place, as close as its neighbors allow to where
// its path comes from, which keeps paths straight.
function placePorts(paths: Path[], grid: Grid) {
  const sourceSlot = (path: Path) =>
    fansOut(path) ? `${path.edge.source} ${path.sourceSide}` : `${path.id} source`;
  const box = (id: string) => grid.terminals.get(id)!.box;
  const sourceDemands = (toward: (path: Path) => number) =>
    paths.map((path, order) => ({
      slot: sourceSlot(path),
      terminal: path.edge.source,
      box: box(path.edge.source),
      side: path.sourceSide,
      toward: toward(path),
      order,
    }));
  const middle = (path: Path) => {
    const [low, high] = sideSpan(box(path.edge.source), path.sourceSide);
    return path.sourceToward ?? (low + high) / 2;
  };
  const sources = spreadPorts(sourceDemands(middle));
  const sourcePort = (path: Path) =>
    onSide(box(path.edge.source), path.sourceSide, sources.get(sourceSlot(path))!);
  const placed = spreadPorts([
    ...sourceDemands((path) => sources.get(sourceSlot(path))!),
    ...paths.map((path, order) => ({
      slot: `${path.id} target`,
      terminal: path.edge.target,
      box: box(path.edge.target),
      side: path.targetSide,
      toward: path.targetToward(sourcePort(path)),
      order,
    })),
  ]);
  return new Map(
    paths.flatMap((path): [string, Position][] => [
      [
        `${path.id} source`,
        onSide(box(path.edge.source), path.sourceSide, placed.get(sourceSlot(path))!),
      ],
      [
        `${path.id} target`,
        onSide(box(path.edge.target), path.targetSide, placed.get(`${path.id} target`)!),
      ],
    ]),
  );
}

interface PortDemand {
  slot: string;
  terminal: string;
  box: Box;
  side: Side;
  toward: number;
  order: number;
}

// Places the ports of each side in the order their paths head to, each as close to `toward` as
// the pitch between them allows.
function spreadPorts(demands: PortDemand[]) {
  const positions = new Map<string, number>();
  const bySide = Map.groupBy(demands, ({ terminal, side }) => `${terminal} ${side}`);
  for (const sideDemands of bySide.values()) {
    const slots = [
      ...new Map(sideDemands.map((demand) => [demand.slot, demand])).values(),
    ].toSorted((a, b) => a.toward - b.toward || a.order - b.order);
    const { box, side } = slots[0]!;
    const [low, high] = sideSpan(box, side);
    const pitch = along(side) === 0 ? portPitch : sidePortPitch;
    const spacing = slots.length > 1 ? Math.min(pitch, (high - low) / (slots.length - 1)) : 0;
    const placed = slots.map(({ toward }) => Math.min(Math.max(toward, low), high));
    for (let index = 1; index < placed.length; index++)
      placed[index] = Math.max(placed[index]!, placed[index - 1]! + spacing);
    placed[placed.length - 1] = Math.min(placed.at(-1)!, high);
    for (let index = placed.length - 2; index >= 0; index--)
      placed[index] = Math.min(placed[index]!, placed[index + 1]! - spacing);
    slots.forEach(({ slot }, index) => positions.set(slot, Math.round(placed[index]!)));
  }
  return positions;
}

// Paths leaving through the top or bottom of a box share one port and the track of their first
// channel, so they fan out from a common line. A parallel edge keeps its own, so it runs apart from
// the first edge between the same nodes.
const fansOut = (path: Path) => along(path.sourceSide) === 0 && (path.edge.ordinal ?? 1) === 1;

// Paths that share a port also share the track of their first channel.
function trackKey(path: Path, ref: ChannelRef, index: number) {
  const name = "horizontal" in ref ? `horizontal ${ref.horizontal}` : `vertical ${ref.vertical}`;
  const shared = index === 0 && fansOut(path);
  return `${name} ${shared ? `${path.edge.source} ${path.sourceSide}` : `${path.id} ${index}`}`;
}

// Gives every leg in a channel a track: legs that overlap get different ones, spread around the
// middle of the channel. `centers` are the points of a path with every leg in the middle of its
// channel.
function assignTracks(paths: Path[], centers: (path: Path) => Position[], grid: Grid) {
  const legs = new Map<string, Map<string, { low: number; high: number; order: number }>>();
  paths.forEach((path, order) => {
    const points = centers(path);
    path.bends.forEach((bend, index) => {
      if ("target" in bend || "midway" in bend) return;
      // The leg in the channel is the one after the bend into it: along x in a horizontal channel,
      // along y in a vertical one.
      const axis = "horizontal" in bend ? 0 : 1;
      const [a, b] = [points[index + 1]![axis], points[index + 2]![axis]];
      if (Math.abs(a - b) < 1) return;
      const key = trackKey(path, bend, index);
      const name = key.split(" ", 2).join(" ");
      const inChannel = legs.get(name) ?? new Map();
      const known = inChannel.get(key);
      inChannel.set(key, {
        low: Math.min(a, b, known?.low ?? Infinity),
        high: Math.max(a, b, known?.high ?? -Infinity),
        order: known?.order ?? order,
      });
      legs.set(name, inChannel);
    });
  });
  const tracks = new Map<string, number>();
  for (const [name, inChannel] of legs) {
    const [kind, index] = name.split(" ");
    const { at, room } = channel(
      grid,
      kind === "horizontal" ? { horizontal: Number(index) } : { vertical: Number(index) },
    );
    const ends: number[] = [];
    const trackOf = new Map<string, number>();
    for (const [key, leg] of [...inChannel].toSorted(
      ([, a], [, b]) => a.low - b.low || a.order - b.order,
    )) {
      let track = ends.findIndex((end) => end + trackGap <= leg.low);
      if (track === -1) track = ends.push(leg.high) - 1;
      else ends[track] = leg.high;
      trackOf.set(key, track);
    }
    const count = ends.length;
    const pitch = count > 1 ? Math.min(trackPitch, Math.max(0, room) / (count - 1)) : 0;
    for (const [key, track] of trackOf)
      tracks.set(key, Math.round(at + (track - (count - 1) / 2) * pitch));
  }
  return tracks;
}

// Whether a segment enters a node box shrunk by a pixel, so ports on its border don't count.
function crossesNode(points: Position[], obstacles: Box[]) {
  return points.slice(1).some(([x2, y2], index) => {
    const [x1, y1] = points[index]!;
    return obstacles.some(
      (box) =>
        Math.max(x1, x2) > box.x + 1 &&
        Math.min(x1, x2) < box.x + box.width - 1 &&
        Math.max(y1, y2) > box.y + 1 &&
        Math.min(y1, y2) < bottomOf(box) - 1,
    );
  });
}

interface Segment {
  id: string;
  from: Position;
  to: Position;
}

// The coordinate that changes along a segment: y for a vertical one, x for a horizontal one.
const axisOf = ({ from, to }: Segment) => (from[0] === to[0] ? 1 : 0);

function extent(segment: Segment, axis: 0 | 1): [number, number] {
  const [a, b] = [segment.from[axis], segment.to[axis]];
  return a < b ? [a, b] : [b, a];
}

// Parts of `[low, high]` outside all of `covered`.
function uncovered([low, high]: [number, number], covered: [number, number][]) {
  const pieces: [number, number][] = [];
  let from = low;
  for (const [start, end] of covered.toSorted((a, b) => a[0] - b[0])) {
    if (start > from) pieces.push([from, Math.min(start, high)]);
    from = Math.max(from, end);
  }
  if (from < high) pieces.push([from, high]);
  return pieces.filter(([start, end]) => end - start > 1);
}

const intersects = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < bottomOf(b) && b.y < bottomOf(a);

// Puts each label in the middle of a stretch of its connection: preferably one no other connection
// runs along, long enough for the label, clear of nodes, group headers and the labels placed before,
// and clear of the lines of other connections.
function placeLabels(drawn: { id: string; edge: DiagramEdge; points: Position[] }[], grid: Grid) {
  const segments = drawn.flatMap(({ id, points }) =>
    points.slice(1).map((to, index): Segment => ({ id, from: points[index]!, to })),
  );
  const taken = [
    ...grid.obstacles.map((box) => ({
      x: box.x - 4,
      y: box.y - 4,
      width: box.width + 8,
      height: box.height + 8,
    })),
    ...grid.headers.values(),
  ];
  // Other connections' segments, widened to where clicking a label would hit them instead.
  const lines = (id: string) =>
    segments
      .filter((segment) => segment.id !== id)
      .map(({ from, to }) => ({
        x: Math.min(from[0], to[0]) - lineClearance,
        y: Math.min(from[1], to[1]) - lineClearance,
        width: Math.abs(to[0] - from[0]) + 2 * lineClearance,
        height: Math.abs(to[1] - from[1]) + 2 * lineClearance,
      }));
  const labels = new Map<string, Position>();
  for (const { id, edge } of drawn) {
    const width = labelWidth(edge.label);
    const around = ([x, y]: Position): Box => ({
      x: x - width / 2,
      y: y - labelHeight / 2,
      width,
      height: labelHeight,
    });
    const candidates = segments
      .filter((segment) => segment.id === id)
      .flatMap((segment) => {
        const axis = axisOf(segment);
        const line = segment.from[1 - axis]!;
        const at = (value: number): Position =>
          axis === 1 ? [line, Math.round(value)] : [Math.round(value), line];
        const covered = segments
          .filter(
            (other) => other.id !== id && axisOf(other) === axis && other.from[1 - axis] === line,
          )
          .map((other) => extent(other, axis));
        const room = axis === 1 ? labelHeight + 16 : width + 8;
        const whole = extent(segment, axis);
        return [
          ...uncovered(whole, covered).map((piece) => ({ piece, own: true })),
          { piece: whole, own: false },
        ].map(({ piece: [start, end], own }) => ({
          middle: at((start + end) / 2),
          own,
          fits: end - start >= room,
          length: end - start,
        }));
      })
      .toSorted(
        (a, b) =>
          Number(b.own) - Number(a.own) || Number(b.fits) - Number(a.fits) || b.length - a.length,
      );
    const free = candidates.filter(
      ({ middle }) => !taken.some((box) => intersects(box, around(middle))),
    );
    const apart = free.find(
      ({ middle }) => !lines(id).some((box) => intersects(box, around(middle))),
    );
    const label = (apart ?? free[0] ?? candidates[0]!).middle;
    labels.set(id, label);
    taken.push(around(label));
  }
  return labels;
}

// Drops repeated points and points that don't change the direction, so only real bends are drawn.
export function withoutStraightBends(points: Position[]): Position[] {
  const kept: Position[] = [];
  for (const point of points) {
    const last = kept.at(-1);
    if (last && last[0] === point[0] && last[1] === point[1]) continue;
    const before = kept.at(-2);
    const straight =
      before &&
      last &&
      ((before[0] === last[0] && last[0] === point[0]) ||
        (before[1] === last[1] && last[1] === point[1]));
    if (straight) kept.pop();
    kept.push(point);
  }
  return kept;
}
