<script setup lang="ts">
import {
  BaseEdge,
  getSmoothStepPath,
  useVueFlow,
  type EdgeProps,
  type GraphNode,
} from "@vue-flow/core";
import { computed } from "vue";
import type { EdgeRoute } from "./diagram/layout";

// Smooth step edge that avoids nodes. An edge across several rows follows the route the auto layout
// kept free for it. Otherwise, when the plain smooth step would cut through a node, and for
// loop-backs to a node above, the edge leaves through the gap below its source, follows the nearest
// free vertical corridor and enters its target from the gap above it.
const props = defineProps<EdgeProps<{ route?: EdgeRoute }>>();
const { getEdges, getNodes } = useVueFlow();
const gap = 20;
const lane = 24;
const radius = 5;

type Point = [x: number, y: number];

// Edges leave a node at its bottom center and enter one at its top center.
const exitPoint = ({
  computedPosition: { x, y },
  dimensions: { width, height },
}: GraphNode): Point => [x + width / 2, y + height];
const entryPoint = ({ computedPosition: { x, y }, dimensions: { width } }: GraphNode): Point => [
  x + width / 2,
  y,
];
const samePoint = (point: Point, other: Point | undefined) =>
  other !== undefined && Math.abs(point[0] - other[0]) < 1 && Math.abs(point[1] - other[1]) < 1;

// Node boxes shrunk by a pixel, so segments that only touch a node's border don't count as hits.
const boxes = computed(() =>
  getNodes.value.map(({ computedPosition: { x, y }, dimensions: { width, height } }) => ({
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

// The auto layout's route holds while both ends sit where it placed them and nothing moved into it.
const laidOut = computed(() => {
  const route = props.data?.route;
  if (!route) return undefined;
  if (!samePoint(exitPoint(props.sourceNode), route.points[0])) return undefined;
  if (!samePoint(entryPoint(props.targetNode), route.points.at(-1))) return undefined;
  const { sourceX, sourceY, targetX, targetY } = props;
  const points: Point[] = [[sourceX, sourceY], ...route.points.slice(1, -1), [targetX, targetY]];
  if (!isClear(points)) return undefined;
  return { path: roundedPath(points), labelX: route.label[0], labelY: route.label[1] };
});

const route = computed(() => {
  if (laidOut.value) return laidOut.value;
  const { sourceX, sourceY, targetX, targetY } = props;
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
    const [path, labelX, labelY] = getSmoothStepPath(props);
    return { path, labelX, labelY };
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
  // Corridors run beside the nodes in the edge's vertical range, shifted a little per edge so
  // parallel edges stay apart. The first clear one with the shortest detour wins.
  const shift = ((getEdges.value.findIndex((edge) => edge.id === props.id) % 3) - 1) * 8;
  const inRange = boxes.value.filter(
    (box) => box.top < Math.max(below, above) && box.bottom > Math.min(below, above),
  );
  const corridors = [
    sourceX,
    targetX,
    ...inRange.flatMap((box) => [box.left - lane + shift, box.right + lane + shift]),
  ].toSorted(
    (a, b) =>
      Math.abs(sourceX - a) + Math.abs(targetX - a) - Math.abs(sourceX - b) - Math.abs(targetX - b),
  );
  const x =
    corridors.find((candidate) => isClear(via(candidate))) ??
    Math.max(sourceX, targetX, ...inRange.map((box) => box.right)) + lane;
  // The label sits on the last bend above the target, where it is easy to tell apart.
  return { path: roundedPath(via(x)), labelX: (x + targetX) / 2, labelY: above };
});
</script>

<template>
  <BaseEdge
    :id
    :path="route.path"
    :label-x="route.labelX"
    :label-y="route.labelY"
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
