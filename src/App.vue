<script setup lang="ts" generic="_T">
// `generic` makes vue-tsc type this SFC as a functional component that createVaporApp accepts
// https://github.com/vuejs/language-tools/issues/5496
import { ref } from "vue";

const count = ref(0);
</script>

<template>
  <main class="min-h-screen grid place-content-center gap-4 font-sans text-slate-800">
    <h1 class="text-2xl font-semibold">Vue Vapor playground</h1>
    <button class="rounded-md border px-4 py-2 hover:bg-slate-100" @click="count++">
      Count: {{ count }}
    </button>
  </main>
</template>
