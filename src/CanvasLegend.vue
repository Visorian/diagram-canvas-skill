<script setup lang="ts">
import { ref, watch } from "vue";
import { kinds } from "./diagram/format";
import { kindStyles } from "./kinds";

const open = ref(localStorage.getItem("legend") !== "closed");
watch(open, (value) => localStorage.setItem("legend", value ? "open" : "closed"));

function onToggle(event: Event) {
  if (event.target instanceof HTMLDetailsElement) open.value = event.target.open;
}

const swatch = "h-4 w-7 shrink-0 rounded border-2";
</script>

<template>
  <details class="popover absolute bottom-3 left-3 z-5 w-64 text-xs" :open @toggle="onToggle">
    <summary class="disclosure px-3 py-2">Legend</summary>
    <div class="grid gap-3 px-3 pb-3">
      <div class="grid gap-1.5">
        <p class="muted">Fill and border: what an element is</p>
        <div v-for="kind in kinds" :key="kind" class="flex items-center gap-2">
          <span :class="[swatch, kindStyles[kind].className]" />
          <span>
            <span class="font-medium">{{ kindStyles[kind].name }}</span>
            <span class="muted"> · {{ kindStyles[kind].description }}</span>
          </span>
        </div>
      </div>
      <div class="grid gap-1.5">
        <p class="muted">Highlights: what we're discussing</p>
        <div class="flex items-center gap-2">
          <span
            :class="[swatch, kindStyles.service.className]"
            class="outline-2 outline-solid outline-offset-2 outline-amber-400"
          />
          <span>
            <span class="font-medium">Marked</span>
            <span class="muted"> · shared pointer, on any element</span>
          </span>
        </div>
        <div class="flex items-center gap-2">
          <svg class="w-7 shrink-0" height="8" viewBox="0 0 28 8" aria-hidden="true">
            <line x1="0" y1="4" x2="28" y2="4" stroke="#d97706" stroke-width="3" />
          </svg>
          <span class="font-medium">Marked connection</span>
        </div>
        <div class="flex items-center gap-2">
          <span
            :class="[swatch, kindStyles.service.className]"
            class="[box-shadow:0_0_0_2px_#fff,0_0_0_4px_#6366f1] dark:[box-shadow:0_0_0_2px_#1e293b,0_0_0_4px_#818cf8]"
          />
          <span>
            <span class="font-medium">Selected</span>
            <span class="muted"> · only in your browser</span>
          </span>
        </div>
        <div class="flex items-center gap-2">
          <span class="w-7 shrink-0 text-center font-bold text-amber-700 dark:text-amber-300">
            ?
          </span>
          <span>
            <span class="font-medium">Open questions</span>
            <span class="muted"> · counted on nodes, "?" on connections</span>
          </span>
        </div>
      </div>
    </div>
  </details>
</template>
