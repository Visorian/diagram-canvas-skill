<script setup lang="ts">
import { Handle, Position, type NodeProps } from "@vue-flow/core";
import type { DiagramNode, Kind } from "./diagram/format";

defineProps<NodeProps<DiagramNode>>();

const kindClass: Record<Kind, string> = {
  service: "bg-white border-slate-400",
  db: "bg-emerald-50 border-emerald-600",
  queue: "bg-amber-50 border-amber-600",
  ext: "bg-slate-100 border-slate-400 border-dashed",
  ui: "bg-sky-50 border-sky-600",
};
</script>

<template>
  <div
    class="w-44 h-14 flex flex-col justify-center rounded-lg border-2 px-3 text-slate-800"
    :class="[kindClass[data.kind], selected && 'ring-2 ring-offset-2 ring-indigo-500']"
  >
    <Handle type="target" :position="Position.Top" />
    <span class="truncate text-sm font-medium">{{ data.label }}</span>
    <span v-if="data.kind !== 'service'" class="text-xs text-slate-500">{{ data.kind }}</span>
    <Handle type="source" :position="Position.Bottom" />
  </div>
</template>
