<script lang="ts">
import type { Note } from "./diagram/notes";

// Small inline form on the canvas; `kind` adds the note/question toggle.
export interface PromptRequest {
  x: number;
  y: number;
  title: string;
  placeholder: string;
  initial?: string;
  kind?: Note["kind"];
  // What Enter does, "save" by default.
  action?: string;
  submit: (text: string, kind: Note["kind"], tag: string) => void;
}
</script>

<script setup lang="ts">
import { onMounted, ref, useTemplateRef } from "vue";
import TagSelect from "./TagSelect.vue";

const { request } = defineProps<{ request: PromptRequest }>();
const emit = defineEmits<{ close: [] }>();
const text = ref(request.initial ?? "");
const kind = ref<Note["kind"]>(request.kind ?? "note");
const tag = ref("");
const root = useTemplateRef("root");
const input = useTemplateRef("input");

onMounted(() => input.value?.select());

function submit() {
  request.submit(text.value.trim(), kind.value, tag.value);
  emit("close");
}

function setKind(next: Note["kind"]) {
  kind.value = next;
  input.value?.focus();
}

function onFocusout(event: FocusEvent) {
  const next = event.relatedTarget;
  if (!(next instanceof Node && root.value?.contains(next))) emit("close");
}
</script>

<template>
  <form
    ref="root"
    class="popover absolute z-10 grid w-72 gap-2 p-3"
    :style="{ left: `${request.x}px`, top: `${request.y}px` }"
    @submit.prevent="submit"
    @focusout="onFocusout"
    @keydown.esc="emit('close')"
  >
    <p class="muted truncate text-xs">{{ request.title }}</p>
    <input ref="input" v-model="text" class="field" :placeholder="request.placeholder" />
    <TagSelect v-if="request.kind && kind === 'question'" v-model="tag" />
    <div class="flex items-center justify-between gap-2">
      <div v-if="request.kind" class="segmented shrink-0" role="radiogroup">
        <button
          v-for="option in ['note', 'question'] as const"
          :key="option"
          type="button"
          role="radio"
          class="px-3 py-1 capitalize"
          :class="kind === option ? 'segment-on' : 'segment-off'"
          :aria-checked="kind === option"
          @click="setKind(option)"
        >
          {{ option }}
        </button>
      </div>
      <span class="muted ml-auto whitespace-nowrap text-xs"
        >Enter to {{ request.action ?? "save" }}</span
      >
    </div>
  </form>
</template>
