<script setup lang="ts">
import { computed, ref } from "vue";
import type { Op } from "./diagram/format";
import type { Note } from "./diagram/notes";

// No target means the entry is about the whole diagram.
const { target } = defineProps<{ target?: string }>();
const emit = defineEmits<{ apply: [ops: Op[]] }>();
const kind = ref<Note["kind"]>("question");
const draft = ref("");

const copy = computed(() =>
  kind.value === "question"
    ? { placeholder: "What should we clarify or decide?", hint: "Stays open until you resolve it." }
    : { placeholder: "What should we remember?", hint: "A fact or decision worth keeping." },
);

function add() {
  const text = draft.value.trim();
  if (!text) return;
  const note: Note = { kind: kind.value, text, done: false };
  if (target) note.target = target;
  emit("apply", [{ type: "add-note", note }]);
  draft.value = "";
}
</script>

<template>
  <form class="grid gap-2" @submit.prevent="add">
    <div
      class="flex justify-self-start overflow-hidden rounded-md border border-slate-300 text-sm dark:border-slate-600"
      role="radiogroup"
      aria-label="Entry type"
    >
      <button
        v-for="option in ['note', 'question'] as const"
        :key="option"
        type="button"
        role="radio"
        class="px-3 py-1 capitalize"
        :class="kind === option ? 'bg-slate-200 font-medium dark:bg-slate-600' : 'muted'"
        :aria-checked="kind === option"
        @click="kind = option"
      >
        {{ option }}
      </button>
    </div>
    <input v-model="draft" class="field" :placeholder="copy.placeholder" />
    <div class="flex items-center justify-between gap-2">
      <span class="muted text-xs">{{ copy.hint }}</span>
      <button class="button shrink-0" :disabled="!draft.trim()">Add {{ kind }}</button>
    </div>
  </form>
</template>
