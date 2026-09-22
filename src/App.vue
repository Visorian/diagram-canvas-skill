<script setup lang="ts" generic="_T">
// `generic` makes vue-tsc type this SFC as a functional component that createVaporApp accepts
// https://github.com/vuejs/language-tools/issues/5496
import { VueFlow } from "@vue-flow/core";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import { edges, nodes } from "./diagram";
</script>

<template>
  <VueFlow :nodes="nodes" :edges="edges" class="h-screen" fit-view-on-init />
</template>
