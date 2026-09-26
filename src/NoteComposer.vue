<script setup lang="ts">
import { ref } from "vue";
import type { Op } from "./diagram/format";
import type { Note } from "./diagram/notes";
import TagSelect from "./TagSelect.vue";

// No target means the entry is about the whole diagram.
const { target } = defineProps<{ target?: string }>();
const emit = defineEmits<{ apply: [ops: Op[]] }>();
const kind = ref<Note["kind"]>("question");
const draft = ref("");
const tag = ref("");

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
    <TagSelect v-if="kind === 'question'" v-model="tag" />
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
