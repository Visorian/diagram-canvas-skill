<script setup lang="ts" generic="_T">
// `generic` makes vue-tsc type this SFC as a functional component that createVaporApp accepts
// https://github.com/vuejs/language-tools/issues/5496
import { ref, shallowRef } from "vue";
import { Handle, Position, VueFlow, type Edge, type Node } from "@vue-flow/core";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";

const nodes = shallowRef<Node[]>([
  { id: "a", type: "input", position: { x: 0, y: 0 }, data: { label: "Input" } },
  { id: "b", type: "custom", position: { x: 200, y: 120 }, data: { label: "Custom" } },
  { id: "c", type: "output", position: { x: 0, y: 240 }, data: { label: "Output" } },
]);
const edges = shallowRef<Edge[]>([
  { id: "a-b", source: "a", target: "b", animated: true },
  { id: "b-c", source: "b", target: "c" },
]);
const clicked = ref("none");

function addNode() {
  const id = String(nodes.value.length + 1);
  nodes.value = [
    ...nodes.value,
    { id, position: { x: 200, y: 280 }, data: { label: `Node ${id}` } },
  ];
}
</script>

<template>
  <main class="h-screen flex flex-col font-sans text-slate-800">
    <header class="p-4 border-b">
      <h1 class="text-xl font-semibold">Vue Vapor playground</h1>
      <p>
        Clicked: {{ clicked }} · Nodes: {{ nodes.length }} · Edges: {{ edges.length }} · B:
        {{ nodes[1]?.position.x }},{{ nodes[1]?.position.y }}
      </p>
      <button class="rounded-md border px-3 py-1 hover:bg-slate-100" @click="addNode">
        Add node
      </button>
    </header>
    <VueFlow
      v-model:nodes="nodes"
      v-model:edges="edges"
      class="flex-1"
      fit-view-on-init
      @node-click="({ node }) => (clicked = node.id)"
      @connect="
        (connection) =>
          (edges = [...edges, { id: `${connection.source}-${connection.target}`, ...connection }])
      "
    >
      <template #node-custom="{ data }">
        <div class="rounded border bg-amber-100 px-3 py-2">
          <Handle type="target" :position="Position.Top" />
          {{ data.label }}
          <Handle type="source" :position="Position.Bottom" />
        </div>
      </template>
    </VueFlow>
  </main>
</template>
