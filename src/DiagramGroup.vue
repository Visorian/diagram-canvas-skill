<script lang="ts">
import type { Change } from "./diagram/compare";

export interface GroupData {
  label: string;
  outer: boolean;
  // Against the compared version, while comparing.
  change?: Change;
}
</script>

<script setup lang="ts">
import { Handle, Position, type NodeProps } from "@vue-flow/core";
import { changeStyles } from "./changes";

defineProps<NodeProps<GroupData>>();
</script>

<template>
  <!-- A background box; the header height matches `groupHeader` in diagram/grid.ts. An outer group
  has a stronger border and a plain header, a group inside it a tinted one. -->
  <div
    class="size-full rounded-xl border"
    :class="
      data.change
        ? changeStyles[data.change].border
        : data.outer
          ? 'border-[#c6c6c6] dark:border-[#3e3d4b]'
          : 'border-[#dcdcdc] dark:border-[#262437]'
    "
  >
    <!-- Connections to the group attach here; it can't be connected by dragging. -->
    <Handle type="target" :position="Position.Top" />
    <div
      class="flex h-10 items-center px-4"
      :class="
        !data.outer &&
        'rounded-t-xl border-b border-[#dcdcdc] bg-[#f6f6f6] dark:border-[#262437] dark:bg-[#0a0719]'
      "
    >
      <span
        class="truncate font-semibold text-[#141029] dark:text-white"
        :class="data.outer ? 'text-sm' : 'text-[13px]'"
      >
        {{ data.label }}
      </span>
      <span
        v-if="data.change"
        class="ml-2 text-xs font-medium"
        :class="changeStyles[data.change].text"
      >
        {{ changeStyles[data.change].name }}
      </span>
    </div>
    <Handle type="source" :position="Position.Bottom" />
  </div>
</template>
