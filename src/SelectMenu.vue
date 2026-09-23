<script setup lang="ts" generic="T extends string">
// In-page dropdown: native <select> popups render outside the page and open offset in embedded previews.
import { computed, nextTick, ref, useId, useTemplateRef } from "vue";

const model = defineModel<T>({ required: true });
const { options, label } = defineProps<{
  options: readonly { value: T; label: string }[];
  label: string;
}>();

const id = useId();
const open = ref(false);
const active = ref(0);
const root = useTemplateRef("root");
const button = useTemplateRef("button");
const list = useTemplateRef("list");
const current = computed(
  () => options.find((option) => option.value === model.value)?.label ?? model.value,
);

async function show() {
  active.value = Math.max(
    0,
    options.findIndex((option) => option.value === model.value),
  );
  open.value = true;
  await nextTick();
  list.value?.focus();
}

function choose(value: T) {
  model.value = value;
  open.value = false;
  button.value?.focus();
}

function onKeydown(event: KeyboardEvent) {
  const last = options.length - 1;
  const moves: Record<string, number> = {
    ArrowDown: Math.min(active.value + 1, last),
    ArrowUp: Math.max(active.value - 1, 0),
    Home: 0,
    End: last,
  };
  const option = options[active.value];
  if (event.key in moves) active.value = moves[event.key] ?? active.value;
  else if ((event.key === "Enter" || event.key === " ") && option) choose(option.value);
  else if (event.key === "Escape" || event.key === "Tab") {
    open.value = false;
    if (event.key === "Escape") button.value?.focus();
    return;
  } else return;
  event.preventDefault();
}

function onFocusout(event: FocusEvent) {
  const next = event.relatedTarget;
  if (!(next instanceof Node && root.value?.contains(next))) open.value = false;
}
</script>

<template>
  <div ref="root" class="relative" @focusout="onFocusout">
    <button
      ref="button"
      type="button"
      class="field flex items-center justify-between gap-2 text-left"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-label="label"
      @click="open ? (open = false) : show()"
      @keydown.down.prevent="show"
    >
      <span class="truncate">{{ current }}</span>
      <svg
        class="muted size-4 shrink-0"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>
    <ul
      v-if="open"
      ref="list"
      role="listbox"
      tabindex="-1"
      class="popover absolute inset-x-0 top-full z-20 mt-1 max-h-64 overflow-y-auto py-1 outline-none"
      :aria-label="label"
      :aria-activedescendant="`${id}-${active}`"
      @keydown="onKeydown"
    >
      <li
        v-for="(option, index) in options"
        :id="`${id}-${index}`"
        :key="option.value"
        role="option"
        class="flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5"
        :class="index === active && 'bg-slate-100 dark:bg-slate-700'"
        :aria-selected="option.value === model"
        @mousemove="active = index"
        @mousedown.prevent
        @click="choose(option.value)"
      >
        <span class="truncate">{{ option.label }}</span>
        <svg
          v-if="option.value === model"
          class="size-4 shrink-0 text-indigo-600 dark:text-indigo-300"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </li>
    </ul>
  </div>
</template>
