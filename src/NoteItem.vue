<script setup lang="ts">
import type { Op } from "./diagram/format";
import type { Note } from "./diagram/notes";

const { note } = defineProps<{
  note: Note;
  // Shows the entry's target as a link, for lists that span the whole diagram.
  labelFor?: (target: string) => string;
}>();
const emit = defineEmits<{ apply: [ops: Op[]]; select: [target: string] }>();

// Splits `code` spans out of the text so they render as code.
const segments = (text: string) =>
  text.split(/(`[^`]+`)/).map((part, index) => ({
    code: index % 2 === 1,
    text: index % 2 === 1 ? part.slice(1, -1) : part,
  }));

const resolve = (done: boolean) => emit("apply", [{ type: "resolve-note", note, done }]);
</script>

<template>
  <li class="flex gap-2 text-sm">
    <span
      v-if="note.kind === 'question'"
      class="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full text-[0.65rem] font-bold"
      :class="
        note.done
          ? 'bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-400'
          : 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200'
      "
      aria-hidden="true"
    >
      {{ note.done ? "✓" : "?" }}
    </span>
    <span v-else class="muted mt-0.5 w-4 shrink-0 text-center" aria-hidden="true">•</span>
    <div class="grid min-w-0 flex-1 gap-1">
      <p class="[overflow-wrap:anywhere]" :class="note.done && 'muted'">
        <button
          v-if="labelFor && note.target"
          type="button"
          class="link font-medium"
          @click="emit('select', note.target)"
        >
          {{ labelFor(note.target) }}
        </button>
        <span v-if="labelFor && note.target" class="muted"> · </span>
        <template v-for="(segment, index) in segments(note.text)" :key="index">
          <code v-if="segment.code" class="code">{{ segment.text }}</code>
          <template v-else>{{ segment.text }}</template>
        </template>
      </p>
      <div class="muted flex gap-3 text-xs">
        <button
          v-if="note.kind === 'question'"
          type="button"
          class="font-medium hover:text-slate-800 hover:underline dark:hover:text-slate-100"
          :title="
            note.done ? 'Move back to open questions' : 'Mark as answered; it stays in the history'
          "
          @click="resolve(!note.done)"
        >
          {{ note.done ? "Reopen" : "Resolve" }}
        </button>
        <button
          type="button"
          class="hover:text-red-600 hover:underline dark:hover:text-red-400"
          @click="emit('apply', [{ type: 'remove-note', note }])"
        >
          Delete
        </button>
      </div>
    </div>
  </li>
</template>
