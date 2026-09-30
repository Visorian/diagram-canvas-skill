<script lang="ts">
import type { Change } from "./diagram/compare";
import type { DiagramNode } from "./diagram/format";

export interface NodeData extends DiagramNode {
  marked: boolean;
  questions: number;
  notes: number;
  // Against the compared version, while comparing.
  change?: Change;
}
</script>

<script setup lang="ts">
import { Handle, Position, type NodeProps } from "@vue-flow/core";
import KindIcon from "./KindIcon.vue";
import { changeStyles } from "./changes";
import { kindStyles } from "./kinds";

defineProps<NodeProps<NodeData>>();

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
</script>

<template>
  <div
    class="w-52 h-14 flex items-center gap-2.5 rounded-lg border bg-white px-2.5 dark:bg-[#141029]"
    :class="[
      selected
        ? 'border-[#195ed8] [box-shadow:0_0_0_1px_#195ed8] dark:border-[#529aff] dark:[box-shadow:0_0_0_1px_#529aff]'
        : data.change
          ? changeStyles[data.change].border
          : 'border-[#c6c6c6] [box-shadow:0_1px_2px_rgb(10_7_25/0.05)] dark:border-[#3e3d4b]',
      kindStyles[data.kind].dashed && 'border-dashed',
      data.marked && 'outline-4 outline-solid outline-offset-4 outline-amber-400',
    ]"
  >
    <Handle type="target" :position="Position.Top" />
    <KindIcon :kind="data.kind" />
    <span class="grid min-w-0">
      <span
        class="truncate text-sm font-medium leading-5 text-[#141029] dark:text-white"
        :class="data.change === 'removed' && 'line-through'"
      >
        {{ data.label }}
      </span>
      <span class="truncate text-xs leading-4 text-[#737375] dark:text-[#9d9d9d]">
        <template v-if="data.change">
          <span class="font-medium" :class="changeStyles[data.change].text">
            {{ changeStyles[data.change].name }}
          </span>
          <template v-if="data.kind !== 'service' || data.questions > 0 || data.notes > 0">
            ·
          </template>
        </template>
        <template v-if="data.kind !== 'service'">{{ kindStyles[data.kind].tag }}</template>
        <template v-if="data.questions > 0">
          <template v-if="data.kind !== 'service'"> · </template>
          <span
            class="mr-1 inline-block size-1.5 rounded-full bg-[#d55300] align-middle dark:bg-[#ff6900]"
          />
          <span class="font-medium text-[#ae3f00] dark:text-[#ff6900]">{{
            plural(data.questions, "question")
          }}</span>
        </template>
        <template v-if="data.notes > 0">
          <template v-if="data.kind !== 'service' || data.questions > 0"> · </template>
          {{ plural(data.notes, "note") }}
        </template>
      </span>
    </span>
    <Handle type="source" :position="Position.Bottom" />
  </div>
</template>
