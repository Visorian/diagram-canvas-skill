<script lang="ts">
import type { DiagramNode, Kind } from "./diagram/format";

export interface NodeData extends DiagramNode {
  marked: boolean;
  questions: number;
  notes: number;
}
</script>

<script setup lang="ts">
import { Handle, Position, type NodeProps } from "@vue-flow/core";

defineProps<NodeProps<NodeData>>();

const kindClass: Record<Kind, string> = {
  service: "bg-white border-slate-400 dark:bg-slate-800 dark:border-slate-500",
  db: "bg-emerald-50 border-emerald-600 dark:bg-emerald-950 dark:border-emerald-500",
  queue: "bg-amber-50 border-amber-600 dark:bg-amber-950 dark:border-amber-500",
  ext: "bg-slate-100 border-slate-400 border-dashed dark:bg-slate-900 dark:border-slate-500",
  ui: "bg-sky-50 border-sky-600 dark:bg-sky-950 dark:border-sky-500",
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
</script>

<template>
  <div
    class="w-44 h-14 flex flex-col justify-center rounded-lg border-2 px-3 text-slate-800 dark:text-slate-100"
    :class="[
      kindClass[data.kind],
      selected &&
        '[box-shadow:0_0_0_2px_#fff,0_0_0_4px_#6366f1] dark:[box-shadow:0_0_0_2px_#020617,0_0_0_4px_#818cf8]',
      data.marked && 'outline-4 outline-solid outline-offset-4 outline-amber-400',
    ]"
  >
    <Handle type="target" :position="Position.Top" />
    <span class="truncate text-sm font-medium">{{ data.label }}</span>
    <span class="muted truncate text-xs">
      <template v-if="data.kind !== 'service'">{{ data.kind }}</template>
      <template v-if="data.questions > 0">
        <template v-if="data.kind !== 'service'"> · </template>
        <span class="font-medium text-amber-700 dark:text-amber-300">{{
          plural(data.questions, "question")
        }}</span>
      </template>
      <template v-if="data.notes > 0">
        <template v-if="data.kind !== 'service' || data.questions > 0"> · </template>
        {{ plural(data.notes, "note") }}
      </template>
    </span>
    <Handle type="source" :position="Position.Bottom" />
  </div>
</template>
