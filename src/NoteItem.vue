<script setup lang="ts">
import { computed, inject, nextTick, ref, useTemplateRef } from "vue";
import type { Op } from "./diagram/format";
import type { Note } from "./diagram/notes";
import { readOnly } from "./mode";
import TagSelect, { tagsKey } from "./TagSelect.vue";

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

const update = (patch: Partial<Note>) =>
  emit("apply", [{ type: "update-note", note, next: { ...note, ...patch } }]);
const tags = inject(tagsKey);
const tagColor = computed(() => tags?.value.find(({ name }) => name === note.tag)?.color);

// Answering resolves the question; an empty answer just resolves it.
const answering = ref(false);
const draft = ref("");
const answerInput = useTemplateRef("answerInput");

async function startAnswer() {
  draft.value = note.answer ?? "";
  answering.value = true;
  await nextTick();
  answerInput.value?.focus();
}

function saveAnswer() {
  answering.value = false;
  update({ answer: draft.value.trim() || undefined, done: true });
}
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
      <p
        v-if="note.answer"
        class="border-l-2 border-slate-300 pl-2 break-words dark:border-slate-600"
        :class="note.done && 'muted'"
      >
        {{ note.answer }}
      </p>
      <span v-if="note.forUser" class="muted text-xs">Asked by the agent</span>
      <form v-if="answering" @submit.prevent="saveAnswer">
        <input
          ref="answerInput"
          v-model="draft"
          class="field"
          aria-label="Answer"
          placeholder="Answer, or empty to just resolve"
          @keydown.esc="answering = false"
        />
      </form>
      <span
        v-if="note.tag && (readOnly || !tags?.length)"
        class="muted flex items-center gap-1.5 text-xs"
      >
        <span class="swatch" :style="{ backgroundColor: tagColor }" aria-hidden="true" />
        {{ note.tag }}
      </span>
      <div v-if="!readOnly" class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <TagSelect
          v-if="note.kind === 'question'"
          class="min-w-24 max-w-36"
          :model-value="note.tag ?? ''"
          @update:model-value="(tag) => update({ tag: tag || undefined })"
        />
        <button
          v-if="note.kind === 'question' && !note.done && !answering"
          type="button"
          class="link font-medium"
          title="Answer and resolve; leave the answer empty to just resolve"
          @click="startAnswer"
        >
          Answer
        </button>
        <button
          v-if="note.kind === 'question' && note.done"
          type="button"
          class="link font-medium"
          title="Move back to open questions"
          @click="update({ done: false })"
        >
          Reopen
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
