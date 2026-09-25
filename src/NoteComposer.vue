<script setup lang="ts">
import { ref, watch } from "vue";
import type { Op, QuestionTag } from "./diagram/format";
import type { Note } from "./diagram/notes";
import SelectMenu from "./SelectMenu.vue";

// No target means the entry is about the whole diagram.
const { target, tags } = defineProps<{ target?: string; tags: QuestionTag[] }>();
const emit = defineEmits<{ apply: [ops: Op[]] }>();
const kind = ref<Note["kind"]>("question");
const draft = ref("");
const tag = ref("");
watch(
  () => tags,
  (available) => {
    if (tag.value && !available.some(({ name }) => name === tag.value)) tag.value = "";
  },
);
const tagOptions = () => [
  { value: "", label: "No tag" },
  ...tags.map(({ name, color }) => ({ value: name, label: name, color })),
];

const placeholders = {
  question: "What should we clarify or decide?",
  note: "What should we remember?",
};

function add() {
  const text = draft.value.trim();
  if (!text) return;
  const note: Note = { kind: kind.value, text, done: false };
  if (target) note.target = target;
  if (kind.value === "question" && tag.value) note.tag = tag.value;
  emit("apply", [{ type: "add-note", note }]);
  draft.value = "";
}
</script>

<template>
  <form class="grid gap-2" @submit.prevent="add">
    <input v-model="draft" class="field" :placeholder="placeholders[kind]" />
    <SelectMenu
      v-if="kind === 'question' && tags.length > 0"
      v-model="tag"
      label="Question tag"
      :options="tagOptions()"
    />
    <div class="flex items-center justify-between gap-2">
      <div class="segmented" role="radiogroup" aria-label="Entry type">
        <button
          v-for="option in ['note', 'question'] as const"
          :key="option"
          type="button"
          role="radio"
          class="px-3 py-1 capitalize"
          :class="kind === option ? 'segment-on' : 'segment-off'"
          :aria-checked="kind === option"
          @click="kind = option"
        >
          {{ option }}
        </button>
      </div>
      <button class="button" :disabled="!draft.trim()">Add {{ kind }}</button>
    </div>
  </form>
</template>
