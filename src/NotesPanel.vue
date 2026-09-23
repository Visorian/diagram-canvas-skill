<script setup lang="ts">
import { ref } from "vue";
import type { Op } from "./diagram/format";
import type { Note } from "./diagram/notes";

const { target, form = false } = defineProps<{
  notes: Note[];
  // Target for new entries; none means the whole diagram.
  target?: string;
  form?: boolean;
  // Shows each entry's target as a link.
  labelFor?: (target: string) => string;
}>();
const emit = defineEmits<{ apply: [ops: Op[]]; select: [target: string] }>();
const draft = ref("");

function add(kind: Note["kind"]) {
  const text = draft.value.trim();
  if (!text) return;
  const note: Note = { kind, text, done: false };
  if (target) note.target = target;
  emit("apply", [{ type: "add-note", note }]);
  draft.value = "";
}
</script>

<template>
  <div class="grid gap-2">
    <ul v-if="notes.length > 0" class="grid gap-1.5 text-sm">
      <li
        v-for="note in notes"
        :key="`${note.kind} ${note.target} ${note.text}`"
        class="flex items-start gap-2"
      >
        <input
          v-if="note.kind === 'question'"
          type="checkbox"
          class="mt-1 accent-amber-600"
          :checked="note.done"
          :aria-label="note.done ? 'Reopen question' : 'Resolve question'"
          @change="emit('apply', [{ type: 'resolve-note', note, done: !note.done }])"
        />
        <span v-else class="w-3.5 text-center text-slate-400">–</span>
        <span
          class="min-w-0 flex-1 [overflow-wrap:anywhere]"
          :class="note.done && 'text-slate-400 line-through'"
        >
          <button
            v-if="labelFor && note.target"
            type="button"
            class="link font-medium"
            @click="emit('select', note.target)"
          >
            {{ labelFor(note.target) }}:
          </button>
          {{ note.text }}
        </span>
        <button
          type="button"
          class="px-1 text-slate-400 hover:text-red-600 dark:hover:text-red-400"
          aria-label="Delete entry"
          @click="emit('apply', [{ type: 'remove-note', note }])"
        >
          ×
        </button>
      </li>
    </ul>
    <form v-if="form" class="grid gap-2" @submit.prevent="add('note')">
      <input v-model="draft" class="field" placeholder="Note or question" />
      <div class="flex gap-2">
        <button class="button" :disabled="!draft.trim()">Add note</button>
        <button type="button" class="button" :disabled="!draft.trim()" @click="add('question')">
          Add question
        </button>
      </div>
    </form>
  </div>
</template>
