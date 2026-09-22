<script setup lang="ts" generic="_T">
// `generic` makes vue-tsc type this SFC as a functional component that createVaporApp accepts
// https://github.com/vuejs/language-tools/issues/5496
import {
  MarkerType,
  VueFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeDragEvent,
  type VueFlowStore,
} from "@vue-flow/core";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import { computed, onMounted, onUnmounted, ref, shallowRef, useTemplateRef, watch } from "vue";
import DiagramNodeView from "./DiagramNode.vue";
import {
  edgeId,
  isKind,
  kinds,
  type DiagramNode,
  type Kind,
  type Layout,
  type Position,
} from "./diagram/format";
import { autoLayout, nodeSize } from "./diagram/layout";
import { useDiagram } from "./diagram/useDiagram";

const { names, files, diagram, layout, open, apply } = useDiagram();
const auto = shallowRef<{ name: string; positions: Layout }>();
const selection = ref<string>();
const flow = shallowRef<VueFlowStore>();
const canvas = useTemplateRef("canvas");
const draftLabel = ref("");
const draftKind = ref<Kind>("service");

// Re-run ELK only when the graph structure changes, not on label edits or moves.
const structure = computed(() =>
  JSON.stringify([diagram.value.nodes.map((node) => node.id), diagram.value.edges.map(edgeId)]),
);
watch(
  [structure, () => files.value?.name],
  async ([, name], _, onCleanup) => {
    let cancelled = false;
    onCleanup(() => (cancelled = true));
    const positions = await autoLayout(diagram.value);
    if (!cancelled && name) auto.value = { name, positions };
  },
  { immediate: true },
);

const ready = computed(() => files.value !== undefined && auto.value?.name === files.value.name);
const pinned = computed(() => Object.keys(layout.value).length > 0);
const selectedNode = computed(() =>
  diagram.value.nodes.find((node) => node.id === selection.value),
);
const selectedEdge = computed(() =>
  diagram.value.edges.find((edge) => edgeId(edge) === selection.value),
);

const nodes = computed<Node<DiagramNode>[]>(() =>
  diagram.value.nodes.map((node) => {
    const [x, y] = layout.value[node.id] ?? auto.value?.positions[node.id] ?? [0, 0];
    return {
      id: node.id,
      type: "diagram",
      position: { x, y },
      data: node,
      selected: selection.value === node.id,
    };
  }),
);
const edges = computed<Edge[]>(() =>
  diagram.value.edges.map((edge) => ({
    id: edgeId(edge),
    source: edge.source,
    target: edge.target,
    label: edge.label,
    type: "smoothstep",
    markerEnd: MarkerType.ArrowClosed,
    selected: selection.value === edgeId(edge),
  })),
);

const fieldValue = (event: Event) =>
  event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement
    ? event.target.value.trim()
    : "";

function uniqueId(label: string) {
  const base =
    label
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-|-$/g, "") || "node";
  let id = base;
  for (let suffix = 2; diagram.value.nodes.some((node) => node.id === id); suffix++) {
    id = `${base}-${suffix}`;
  }
  return id;
}

function viewportCenter(): Position | undefined {
  const rect = canvas.value?.getBoundingClientRect();
  if (!rect || !flow.value) return undefined;
  const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  const point = flow.value.screenToFlowCoordinate(center);
  return [Math.round(point.x - nodeSize.width / 2), Math.round(point.y - nodeSize.height / 2)];
}

function addNode() {
  const label = draftLabel.value.trim();
  if (!label) return;
  const node = { id: uniqueId(label), label, kind: draftKind.value };
  // With pinned nodes around, pin the new one in view; otherwise auto layout places it.
  const position = pinned.value ? viewportCenter() : undefined;
  void apply([{ type: "upsert-node", node, ...(position && { position }) }]);
  selection.value = node.id;
  draftLabel.value = "";
}

function updateNode(patch: Partial<DiagramNode>) {
  if (selectedNode.value)
    void apply([{ type: "upsert-node", node: { ...selectedNode.value, ...patch } }]);
}

function updateKind(event: Event) {
  const kind = fieldValue(event);
  if (isKind(kind)) updateNode({ kind });
}

function updateEdgeLabel(event: Event) {
  if (selectedEdge.value) {
    void apply([
      { type: "upsert-edge", edge: { ...selectedEdge.value, label: fieldValue(event) } },
    ]);
  }
}

function removeSelection() {
  if (selectedNode.value) void apply([{ type: "remove-node", id: selectedNode.value.id }]);
  if (selectedEdge.value) {
    const { source, target } = selectedEdge.value;
    void apply([{ type: "remove-edge", source, target }]);
  }
  selection.value = undefined;
}

function onDragStop({ nodes: moved }: NodeDragEvent) {
  void apply(
    moved.map((node) => ({
      type: "move",
      id: node.id,
      position: [Math.round(node.position.x), Math.round(node.position.y)],
    })),
  );
}

// The click that ends a connection drag lands on the pane; keep the new edge selected.
let connected = false;

function select(id?: string) {
  const skip = id === undefined && connected;
  connected = false;
  if (!skip) selection.value = id;
}

function onConnect({ source, target }: Connection) {
  connected = true;
  selection.value = edgeId({ source, target });
  void apply([{ type: "upsert-edge", edge: { source, target, label: "" } }]);
}

function onKeydown(event: KeyboardEvent) {
  const typing = event.target instanceof HTMLElement && event.target.closest("input, select");
  if ((event.key === "Delete" || event.key === "Backspace") && !typing) removeSelection();
}
onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="h-screen flex font-sans text-slate-800">
    <div ref="canvas" class="flex-1 min-w-0">
      <VueFlow
        v-if="ready"
        :key="files?.name"
        :nodes
        :edges
        :delete-key-code="null"
        fit-view-on-init
        @init="flow = $event"
        @node-click="select($event.node.id)"
        @edge-click="select($event.edge.id)"
        @pane-click="select()"
        @node-drag-stop="onDragStop"
        @connect="onConnect"
      >
        <template #node-diagram="props">
          <DiagramNodeView v-bind="props" />
        </template>
      </VueFlow>
      <p v-else-if="names.length === 0" class="p-6 text-slate-500">
        Create <code>diagrams/&lt;name&gt;.txt</code> to start.
      </p>
    </div>

    <aside
      class="w-80 shrink-0 flex flex-col gap-5 overflow-y-auto border-l border-slate-200 bg-slate-50 p-4"
    >
      <label class="grid gap-1 text-sm font-medium">
        Diagram
        <select class="field" :value="files?.name" @change="open(fieldValue($event))">
          <option v-for="name in names" :key="name" :value="name">{{ name }}</option>
        </select>
        <span class="text-xs font-normal text-slate-500">diagrams/{{ files?.name }}.txt</span>
      </label>

      <form v-if="selectedNode" :key="selectedNode.id" class="grid gap-3" @submit.prevent>
        <h2 class="font-semibold">Node {{ selectedNode.id }}</h2>
        <label class="grid gap-1 text-sm">
          Label
          <input
            class="field"
            :value="selectedNode.label"
            @change="fieldValue($event) && updateNode({ label: fieldValue($event) })"
          />
        </label>
        <label class="grid gap-1 text-sm">
          Kind
          <select class="field" :value="selectedNode.kind" @change="updateKind">
            <option v-for="kind in kinds" :key="kind" :value="kind">{{ kind }}</option>
          </select>
        </label>
        <button class="button justify-self-start" type="button" @click="removeSelection">
          Delete node
        </button>
      </form>

      <form v-else-if="selectedEdge" :key="selection" class="grid gap-3" @submit.prevent>
        <h2 class="font-semibold">{{ selectedEdge.source }} → {{ selectedEdge.target }}</h2>
        <label class="grid gap-1 text-sm">
          Label
          <input class="field" :value="selectedEdge.label" @change="updateEdgeLabel" />
        </label>
        <button class="button justify-self-start" type="button" @click="removeSelection">
          Delete connection
        </button>
      </form>

      <form v-else-if="files" class="grid gap-3" @submit.prevent="addNode">
        <h2 class="font-semibold">Add node</h2>
        <label class="grid gap-1 text-sm">
          Label
          <input v-model="draftLabel" class="field" placeholder="Orders Service" />
        </label>
        <label class="grid gap-1 text-sm">
          Kind
          <select v-model="draftKind" class="field">
            <option v-for="kind in kinds" :key="kind" :value="kind">{{ kind }}</option>
          </select>
        </label>
        <button class="button justify-self-start" :disabled="!draftLabel.trim()">Add</button>
      </form>

      <ul v-if="diagram.errors.length > 0" class="grid gap-1 text-sm text-red-700">
        <li v-for="error in diagram.errors" :key="error">{{ error }}</li>
      </ul>

      <div class="mt-auto grid gap-3 text-xs text-slate-500">
        <p>
          Drag from a node's bottom handle to connect. Delete removes the selection. Moved nodes
          stay where you put them until you run auto layout.
        </p>
        <button
          class="button justify-self-start"
          :disabled="!pinned"
          @click="apply([{ type: 'reset-layout' }])"
        >
          Auto layout
        </button>
      </div>
    </aside>
  </div>
</template>
