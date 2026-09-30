<script setup lang="ts">
import { ref, watch } from "vue";
import KindIcon from "./KindIcon.vue";
import { changeStyles } from "./changes";
import { kinds } from "./diagram/format";
import { kindStyles } from "./kinds";

defineProps<{ comparing: boolean }>();

const open = ref(localStorage.getItem("legend") === "open");
watch(open, (value) => localStorage.setItem("legend", value ? "open" : "closed"));

function onToggle(event: Event) {
  if (event.target instanceof HTMLDetailsElement) open.value = event.target.open;
}

const swatch =
  "h-4 w-7 shrink-0 rounded border border-[#c6c6c6] bg-white dark:border-[#3e3d4b] dark:bg-[#141029]";
</script>

<template>
  <details
    class="popover absolute bottom-3 left-3 z-5 text-xs"
    :class="open && 'w-64'"
    :open
    @toggle="onToggle"
  >
    <summary class="disclosure px-3 py-2">Legend</summary>
    <div class="grid gap-3 px-3 pb-3">
      <div class="grid gap-1.5">
        <p class="muted">What an element is</p>
        <div v-for="kind in kinds" :key="kind" class="flex items-center gap-2">
          <KindIcon :kind />
          <span>
            <span class="font-medium">{{ kindStyles[kind].name }}</span>
            <span class="muted">
              · {{ kindStyles[kind].description
              }}{{ kindStyles[kind].dashed ? ", dashed border" : "" }}
            </span>
          </span>
        </div>
        <div class="flex items-center gap-2">
          <svg class="w-7 shrink-0" height="8" viewBox="0 0 28 8" aria-hidden="true">
            <line class="legend-flow" x1="0" y1="4" x2="28" y2="4" stroke-width="1.5" />
          </svg>
          <span>
            <span class="font-medium">Animated connection</span>
            <span class="muted"> · the main flow</span>
          </span>
        </div>
      </div>
      <div v-if="comparing" class="grid gap-1.5">
        <p class="muted">Compared with another version</p>
        <div v-for="(style, change) in changeStyles" :key="change" class="flex items-center gap-2">
          <span :class="[swatch, style.border]" />
          <span>
            <span class="font-medium" :class="style.text">{{ style.name }}</span>
            <span class="muted"> · {{ style.description }}</span>
          </span>
        </div>
      </div>
      <div class="grid gap-1.5">
        <p class="muted">Highlights: what we're discussing</p>
        <div class="flex items-center gap-2">
          <span
            :class="swatch"
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
            :class="swatch"
            class="border-[#195ed8] [box-shadow:0_0_0_1px_#195ed8] dark:border-[#529aff] dark:[box-shadow:0_0_0_1px_#529aff]"
          />
          <span>
            <span class="font-medium">Selected</span>
            <span class="muted"> · only in your browser</span>
          </span>
        </div>
        <div class="flex items-center gap-2">
          <span class="grid w-7 shrink-0 place-items-center">
            <span class="size-1.5 rounded-full bg-[#d55300] dark:bg-[#ff6900]" />
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
