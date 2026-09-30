<script setup lang="ts">
import {
  BaseEdge,
  getSmoothStepPath,
  useVueFlow,
  type EdgeProps,
  type GraphNode,
} from "@vue-flow/core";
import { computed } from "vue";
import { step } from "./diagram/connections";
import type { Connection } from "./diagram/layout";

// Smooth step edge that avoids nodes. In a sequence, an edge runs across its row at `step`, between
// the nodes' timelines wherever the nodes are. Elsewhere it follows the connection the auto layout
// drew for it while its ends stay where the layout placed them. Otherwise, when the plain smooth
// step would cut through a node, and for back edges to a node above, the edge leaves through the
// gap below its source, follows the nearest free vertical channel and enters its target from the
// gap above it; `offset` moves both ends sideways, which keeps parallel edges apart.
const props = defineProps<EdgeProps<{ connection?: Connection; step?: number; offset?: number }>>();
const { getEdges, getNodes } = useVueFlow();
const gap = 20;
const channelOffset = 24;
const radius = 8;

type Point = [x: number, y: number];

const centerX = ({ computedPosition: { x }, dimensions: { width } }: GraphNode) => x + width / 2;

const placedAt = ({ computedPosition: { x, y } }: GraphNode, [placedX, placedY]: Point) =>
  Math.abs(x - placedX) < 1 && Math.abs(y - placedY) < 1;

// Node boxes shrunk by a pixel, so segments that only touch a node's border don't count as hits.
// Group boxes are only a background.
const boxes = computed(() =>
  getNodes.value
    .filter((node) => node.type === "diagram")
    .map(({ computedPosition: { x, y }, dimensions: { width, height } }) => ({
      left: x + 1,
      right: x + width - 1,
      top: y + 1,
      bottom: y + height - 1,
    })),
);
const crossesNode = ([x1, y1]: Point, [x2, y2]: Point) =>
  boxes.value.some(
    (box) =>
      Math.max(x1, x2) > box.left &&
      Math.min(x1, x2) < box.right &&
      Math.max(y1, y2) > box.top &&
      Math.min(y1, y2) < box.bottom,
  );
const isClear = (points: Point[]) =>
  points.every((point, index) => index === 0 || !crossesNode(points[index - 1]!, point));

// Rounds each corner of an orthogonal polyline like the smooth step edges do.
function roundedPath(points: Point[]) {
  return points
    .map(([x, y], index) => {
      const previous = points[index - 1];
      const next = points[index + 1];
      if (!previous || !next) return `${index === 0 ? "M" : "L"}${x},${y}`;
      const r = Math.min(
        radius,
        Math.hypot(x - previous[0], y - previous[1]) / 2,
        Math.hypot(next[0] - x, next[1] - y) / 2,
      );
      const before = [x - Math.sign(x - previous[0]) * r, y - Math.sign(y - previous[1]) * r];
      const after = [x + Math.sign(next[0] - x) * r, y + Math.sign(next[1] - y) * r];
      return `L${before.join(",")} Q${x},${y} ${after.join(",")}`;
    })
    .join(" ");
}

// The auto layout's connection holds while both ends sit where it placed them and nothing moved
// into it.
const laidOut = computed(() => {
  const row = props.data?.step;
  if (row !== undefined) {
    const isLoop = props.source === props.target;
    const { points, label } = step(
      centerX(props.sourceNode),
      centerX(props.targetNode),
      row,
      String(props.label ?? ""),
      isLoop,
    );
    return { path: roundedPath(points), labelX: label[0], labelY: label[1] };
  }
  const connection = props.data?.connection;
  if (!connection) return undefined;
  const { source, target, points, label } = connection;
  if (!placedAt(props.sourceNode, source) || !placedAt(props.targetNode, target)) return undefined;
  if (!isClear(points)) return undefined;
  return { path: roundedPath(points), labelX: label[0], labelY: label[1] };
});

const drawn = computed(() => {
  if (laidOut.value) return laidOut.value;
  const offset = props.data?.offset ?? 0;
  const { sourceY, targetY } = props;
  const [sourceX, targetX] = [props.sourceX + offset, props.targetX + offset];
  const middle = (sourceY + targetY) / 2;
  if (
    targetY > sourceY &&
    isClear([
      [sourceX, sourceY],
      [sourceX, middle],
      [targetX, middle],
      [targetX, targetY],
    ])
  ) {
    const [path, labelX, labelY] = getSmoothStepPath({
      ...props,
      sourceX,
      targetX,
      borderRadius: radius,
    });
    // Parallel steps share their middle height, so their labels move apart vertically too.
    return { path, labelX, labelY: labelY + offset * 1.5 };
  }
  const below = sourceY + gap;
  const above = targetY - gap;
  const via = (x: number): Point[] => [
    [sourceX, sourceY],
    [sourceX, below],
    [x, below],
    [x, above],
    [targetX, above],
    [targetX, targetY],
  ];
  // Channels run beside the nodes in the edge's vertical range, shifted a little per edge so
  // parallel edges stay apart. The first clear one with the shortest detour wins.
  const shift = ((getEdges.value.findIndex((edge) => edge.id === props.id) % 3) - 1) * 8;
  const inRange = boxes.value.filter(
    (box) => box.top < Math.max(below, above) && box.bottom > Math.min(below, above),
  );
  const channels = [
    sourceX,
    targetX,
    ...inRange.flatMap((box) => [
      box.left - channelOffset + shift,
      box.right + channelOffset + shift,
    ]),
  ].toSorted(
    (a, b) =>
      Math.abs(sourceX - a) + Math.abs(targetX - a) - Math.abs(sourceX - b) - Math.abs(targetX - b),
  );
  const x =
    channels.find((candidate) => isClear(via(candidate))) ??
    Math.max(sourceX, targetX, ...inRange.map((box) => box.right)) + channelOffset;
  // The label sits on the last bend above the target, where it is easy to tell apart.
  return { path: roundedPath(via(x)), labelX: (x + targetX) / 2, labelY: above };
});
</script>

<template>
  <BaseEdge
    :id
    :path="drawn.path"
    :label-x="drawn.labelX"
    :label-y="drawn.labelY"
    :label
    :label-style
    :label-show-bg
    :label-bg-style
    :label-bg-padding
    :label-bg-border-radius
    :marker-start
    :marker-end
    :interaction-width
    :style
  />
</template>
