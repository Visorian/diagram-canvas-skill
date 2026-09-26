<script lang="ts">
import type { ComputedRef, InjectionKey } from "vue";
import type { QuestionTag } from "./diagram/format";

// Question tags of the open diagram, provided by the app.
export const tagsKey: InjectionKey<ComputedRef<QuestionTag[]>> = Symbol("tags");
export const tagOption = ({ name, color }: QuestionTag) => ({ value: name, label: name, color });
</script>

<script setup lang="ts">
import { computed, inject } from "vue";
import SelectMenu from "./SelectMenu.vue";

// An empty string means no tag.
const model = defineModel<string>({ required: true });
const tags = inject(tagsKey);
const options = computed(() => [
  { value: "", label: "No tag" },
  ...(tags?.value ?? []).map(tagOption),
]);
</script>

<template>
  <SelectMenu v-if="tags?.length" v-model="model" label="Question tag" :options />
</template>
