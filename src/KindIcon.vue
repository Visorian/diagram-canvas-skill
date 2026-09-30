<script setup lang="ts">
import type { Kind } from "./diagram/format";
import { kindStyles } from "./kinds";

defineProps<{ kind: Kind }>();
</script>

<template>
  <span
    class="grid size-7 shrink-0 place-items-center rounded-md bg-[#ededed] text-[#58585f] dark:bg-[#1d1a30] dark:text-[#c6c6c6]"
  >
    <svg
      class="size-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path :d="kindStyles[kind].icon" />
    </svg>
  </span>
</template>
