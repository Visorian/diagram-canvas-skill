<script setup lang="ts">
import { computed } from "vue";
import type { Op, QuestionTag } from "./diagram/format";
import type { Note } from "./diagram/notes";
import { readOnly } from "./mode";
import SelectMenu from "./SelectMenu.vue";

const { note, tags } = defineProps<{
  note: Note;
  tags: QuestionTag[];
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
const tagColor = computed(() => tags.find(({ name }) => name === note.tag)?.color);
const tagOptions = computed(() => [
  { value: "", label: "No tag" },
  ...tags.map(({ name, color }) => ({ value: name, label: name, color })),
]);
</script>

<template>
  <li class="flex gap-2">
    <span
      v-if="note.kind === 'question'"
      class="w-4 shrink-0 text-center font-bold"
      :class="note.done ? 'muted' : 'text-amber-700 dark:text-amber-300'"
      aria-hidden="true"
    >
      {{ note.done ? "✓" : "?" }}
    </span>
    <span v-else class="muted w-4 shrink-0 text-center" aria-hidden="true">•</span>
    <div class="grid min-w-0 flex-1 gap-1">
      <p class="break-words" :class="note.done && 'muted'">
        <template v-if="labelFor">
          <button
            v-if="note.target"
            type="button"
            class="link font-medium"
            @click="emit('select', note.target)"
          >
            {{ labelFor(note.target) }}
          </button>
          <span v-else class="font-medium">Whole diagram</span>
          <span class="muted"> · </span>
        </template>
        <template v-for="(segment, index) in segments(note.text)" :key="index">
          <code v-if="segment.code" class="code">{{ segment.text }}</code>
          <template v-else>{{ segment.text }}</template>
        </template>
      </p>
      <span
        v-if="note.tag && (readOnly || tags.length === 0)"
        class="muted flex items-center gap-1.5 text-xs"
      >
        <span
          class="size-2.5 shrink-0 rounded-sm border border-slate-500/30"
          :style="{ backgroundColor: tagColor }"
          aria-hidden="true"
        />
        {{ note.tag }}
      </span>
      <div v-if="!readOnly" class="flex gap-4 text-xs">
        <SelectMenu
          v-if="note.kind === 'question' && tags.length > 0"
          class="min-w-24 max-w-36"
          label="Question tag"
          :model-value="note.tag ?? ''"
          :options="tagOptions"
          @update:model-value="
            (tag) => emit('apply', [{ type: 'tag-note', note, tag: tag || undefined }])
          "
        />
        <button
          v-if="note.kind === 'question'"
          type="button"
          class="link font-medium"
          :title="
            note.done ? 'Move back to open questions' : 'Mark as answered; it stays in the history'
          "
          @click="resolve(!note.done)"
        >
          {{ note.done ? "Reopen" : "Resolve" }}
        </button>
        <button
          type="button"
          class="muted hover:text-red-600 hover:underline dark:hover:text-red-400"
          @click="emit('apply', [{ type: 'remove-note', note }])"
        >
          Delete
        </button>
      </div>
    </div>
  </li>
</template>
