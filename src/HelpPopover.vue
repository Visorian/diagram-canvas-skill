<script setup lang="ts">
import { nextTick, ref, useTemplateRef } from "vue";

const open = ref(false);
const panel = useTemplateRef("panel");

const gestures = [
  ["Double-click", "Add a note"],
  ["Right-click", "More actions"],
  ["Drag from a dot", "Connect"],
  ["N / Q", "Note / question"],
  ["M", "Mark or unmark"],
  ["F2", "Rename or label"],
  ["Del", "Delete"],
  ["Esc", "Close or deselect"],
] as const;

async function toggle() {
  open.value = !open.value;
  if (open.value) {
    await nextTick();
    panel.value?.focus();
  }
}
</script>

<template>
  <div class="relative">
    <button
      type="button"
      class="button grid size-9 place-items-center px-0"
      aria-label="Shortcuts"
      title="Shortcuts"
      :aria-expanded="open"
      @mousedown.prevent
      @click="toggle"
    >
      <svg
        class="size-5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01" />
      </svg>
    </button>
    <div
      v-if="open"
      ref="panel"
      tabindex="-1"
      class="popover absolute right-0 top-11 z-20 grid w-64 gap-1.5 p-3 text-sm outline-none"
      @focusout="open = false"
      @keydown.esc="open = false"
    >
      <div v-for="[keys, action] in gestures" :key="keys" class="flex justify-between gap-4">
        <kbd class="font-sans font-medium">{{ keys }}</kbd>
        <span class="muted">{{ action }}</span>
      </div>
    </div>
  </div>
</template>
