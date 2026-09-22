<script lang="ts">
export interface MenuItem {
  label: string;
  shortcut?: string;
  danger?: boolean;
  action: () => void;
}

export interface MenuRequest {
  x: number;
  y: number;
  items: MenuItem[];
}
</script>

<script setup lang="ts">
import { onMounted, useTemplateRef } from "vue";

defineProps<{ request: MenuRequest }>();
const emit = defineEmits<{ close: [] }>();
const root = useTemplateRef("root");

onMounted(() => root.value?.focus());

function run(item: MenuItem) {
  emit("close");
  item.action();
}
</script>

<template>
  <div
    ref="root"
    tabindex="-1"
    role="menu"
    class="popover absolute z-10 min-w-52 py-1 outline-none"
    :style="{ left: `${request.x}px`, top: `${request.y}px` }"
    @focusout="emit('close')"
    @keydown.esc="emit('close')"
  >
    <!-- mousedown.prevent keeps focus in the menu so focusout doesn't close it before click. -->
    <button
      v-for="item in request.items"
      :key="item.label"
      type="button"
      role="menuitem"
      class="flex w-full items-center justify-between gap-6 px-3 py-1.5 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-700"
      :class="item.danger && 'text-red-600 dark:text-red-400'"
      @mousedown.prevent
      @click="run(item)"
    >
      <span>{{ item.label }}</span>
      <kbd v-if="item.shortcut" class="muted font-sans text-xs">{{ item.shortcut }}</kbd>
    </button>
  </div>
</template>
