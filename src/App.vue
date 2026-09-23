<script setup lang="ts" generic="_T">
// `generic` makes vue-tsc type this SFC as a functional component that createVaporApp accepts
// https://github.com/vuejs/language-tools/issues/5496
import {
  MarkerType,
  VueFlow,
  type Connection,
  type Edge,
  type EdgeMouseEvent,
  type Node,
  type NodeDragEvent,
  type NodeMouseEvent,
  type VueFlowStore,
} from "@vue-flow/core";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import { computed, onMounted, onUnmounted, ref, shallowRef, useTemplateRef, watch } from "vue";
import CanvasPrompt, { type PromptRequest } from "./CanvasPrompt.vue";
import ContextMenu, { type MenuItem, type MenuRequest } from "./ContextMenu.vue";
import DiagramNodeView, { type NodeData } from "./DiagramNode.vue";
import CanvasLegend from "./CanvasLegend.vue";
import HelpPopover from "./HelpPopover.vue";
import NoteComposer from "./NoteComposer.vue";
import NoteItem from "./NoteItem.vue";
import { kindStyles } from "./kinds";
import {
  edgeId,
  isKind,
  kinds,
  type DiagramNode,
  type Layout,
  type Position,
} from "./diagram/format";
import { autoLayout, nodeSize } from "./diagram/layout";
import { parseNotes, type Note } from "./diagram/notes";
import { useDiagram } from "./diagram/useDiagram";
import { useTheme } from "./theme";

interface Point {
  x: number;
  y: number;
}

const { names, files, diagram, layout, open, apply } = useDiagram();
const { dark, toggle: toggleTheme } = useTheme();
const auto = shallowRef<{ name: string; positions: Layout }>();
const selection = ref<string>();
const flow = shallowRef<VueFlowStore>();
const canvas = useTemplateRef("canvas");
const prompt = shallowRef<PromptRequest>();
const menu = shallowRef<MenuRequest>();
// Remounts the prompt for every request so it starts with fresh text.
const promptKey = ref(0);
// Last pointer position over the canvas, used to place prompts opened by keyboard.
let pointer: Point = { x: 0, y: 0 };

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

const notes = computed(() => parseNotes(files.value?.notes ?? ""));
const marks = computed(() => new Set(files.value?.marks));
const isOpen = (note: Note) => note.kind === "question" && !note.done;
const openQuestions = computed(() => notes.value.filter(isOpen));
const resolvedQuestions = computed(() =>
  notes.value.filter((note) => note.kind === "question" && note.done),
);
const diagramNotes = computed(() =>
  notes.value.filter((note) => note.target === undefined && note.kind === "note"),
);
const notesFor = (target: string) => notes.value.filter((note) => note.target === target);
const questionsFor = (target: string, done: boolean) =>
  notesFor(target).filter((note) => note.kind === "question" && note.done === done);
const plainNotesFor = (target: string) => notesFor(target).filter((note) => note.kind === "note");

// Chat prompts that point the agent at what the user is looking at.
const agentPrompt = computed(() => {
  const file = `diagrams/${files.value?.name ?? ""}.txt`;
  const target = selection.value;
  return target
    ? `Look at "${labelFor(target)}" (${target}) in ${file}, including its notes and open questions.`
    : `Look at ${file}: check what I marked and the open questions.`;
});
const copied = ref(false);
async function copyPrompt() {
  await navigator.clipboard.writeText(agentPrompt.value);
  copied.value = true;
  setTimeout(() => (copied.value = false), 2000);
}

const ready = computed(() => files.value !== undefined && auto.value?.name === files.value.name);
const pinned = computed(() => Object.keys(layout.value).length > 0);
const findNode = (id: string) => diagram.value.nodes.find((node) => node.id === id);
const findEdge = (id: string) => diagram.value.edges.find((edge) => edgeId(edge) === id);
const selectedNode = computed(() => (selection.value ? findNode(selection.value) : undefined));
const selectedEdge = computed(() => (selection.value ? findEdge(selection.value) : undefined));
const incoming = computed(() =>
  diagram.value.edges.filter((edge) => edge.target === selectedNode.value?.id),
);
const outgoing = computed(() =>
  diagram.value.edges.filter((edge) => edge.source === selectedNode.value?.id),
);

const nodes = computed<Node<NodeData>[]>(() =>
  diagram.value.nodes.map((node) => {
    const [x, y] = layout.value[node.id] ?? auto.value?.positions[node.id] ?? [0, 0];
    const entries = notesFor(node.id);
    return {
      id: node.id,
      type: "diagram",
      position: { x, y },
      data: {
        ...node,
        marked: marks.value.has(node.id),
        questions: entries.filter(isOpen).length,
        notes: entries.filter((note) => note.kind === "note").length,
      },
      selected: selection.value === node.id,
    };
  }),
);
const edges = computed<Edge[]>(() =>
  diagram.value.edges.map((edge) => {
    const id = edgeId(edge);
    const questioned = notesFor(id).some(isOpen);
    const flowEdge = {
      id,
      source: edge.source,
      target: edge.target,
      label: questioned ? `${edge.label} ?`.trim() : edge.label,
      type: "smoothstep",
      markerEnd: { type: MarkerType.ArrowClosed, color: dark.value ? "#64748b" : "#94a3b8" },
      selected: selection.value === id,
    };
    if (!marks.value.has(id)) return flowEdge;
    return Object.assign(flowEdge, {
      style: { stroke: "#d97706", strokeWidth: 3 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#d97706", width: 12, height: 12 },
      labelStyle: { fill: dark.value ? "#fcd34d" : "#b45309", fontWeight: 600 },
    });
  }),
);

function labelFor(target: string): string {
  const node = findNode(target);
  if (node) return node.label;
  const edge = findEdge(target);
  return edge ? `${labelFor(edge.source)} → ${labelFor(edge.target)}` : target;
}

const fieldValue = (event: Event) =>
  event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement
    ? event.target.value.trim()
    : "";

const eventPoint = (event: MouseEvent | TouchEvent): Point =>
  "clientX" in event ? { x: event.clientX, y: event.clientY } : pointer;

function canvasCenter(): Point {
  const rect = canvas.value?.getBoundingClientRect();
  return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 3 } : pointer;
}

const clamp = (value: number, max: number) => Math.max(8, Math.min(value, max - 8));

// Converts a client point to canvas coordinates, keeping a popover of `size` inside the canvas.
function place({ x, y }: Point, size: { width: number; height: number }): Point {
  const rect = canvas.value?.getBoundingClientRect();
  if (!rect) return { x, y };
  return {
    x: clamp(x - rect.left, rect.width - size.width),
    y: clamp(y - rect.top, rect.height - size.height),
  };
}

function flowPosition(point: Point): Position | undefined {
  const flowPoint = flow.value?.screenToFlowCoordinate(point);
  if (!flowPoint) return undefined;
  return [
    Math.round(flowPoint.x - nodeSize.width / 2),
    Math.round(flowPoint.y - nodeSize.height / 2),
  ];
}

function uniqueId(label: string) {
  const base =
    label
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-|-$/g, "") || "node";
  let id = base;
  for (let suffix = 2; findNode(id); suffix++) id = `${base}-${suffix}`;
  return id;
}

function openPrompt(point: Point, request: Omit<PromptRequest, "x" | "y">) {
  menu.value = undefined;
  promptKey.value++;
  prompt.value = { ...place(point, { width: 288, height: 130 }), ...request };
}

function promptNote(target: string | undefined, kind: Note["kind"], point: Point) {
  openPrompt(point, {
    title: target ? labelFor(target) : "Whole diagram",
    placeholder: kind === "question" ? "What should we clarify?" : "Add a note",
    kind,
    submit: (text, chosen) => {
      if (!text) return;
      const note: Note = { kind: chosen, text, done: false };
      if (target) note.target = target;
      void apply([{ type: "add-note", note }]);
    },
  });
}

function promptRename(target: string, point: Point) {
  const node = findNode(target);
  const edge = findEdge(target);
  if (node) {
    openPrompt(point, {
      title: "Rename node",
      placeholder: node.id,
      initial: node.label,
      submit: (label) => {
        if (label) void apply([{ type: "upsert-node", node: { ...node, label } }]);
      },
    });
  } else if (edge) {
    openPrompt(point, {
      title: `Label ${labelFor(target)}`,
      placeholder: "REST, events, …",
      initial: edge.label,
      submit: (label) => void apply([{ type: "upsert-edge", edge: { ...edge, label } }]),
    });
  }
}

// Places the node at `point`, or leaves it to auto layout when nothing is pinned and `pin` is false.
function promptAddNode(point: Point, pin: boolean) {
  openPrompt(point, {
    title: "New node",
    placeholder: "Orders Service",
    submit: (label) => {
      if (!label) return;
      const node = { id: uniqueId(label), label, kind: "service" as const };
      const position = pin || pinned.value ? flowPosition(point) : undefined;
      void apply([{ type: "upsert-node", node, ...(position && { position }) }]);
      selection.value = node.id;
    },
  });
}

function updateNode(patch: Partial<DiagramNode>) {
  if (selectedNode.value) {
    void apply([{ type: "upsert-node", node: { ...selectedNode.value, ...patch } }]);
  }
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

function remove(target: string) {
  const edge = findEdge(target);
  if (findNode(target)) void apply([{ type: "remove-node", id: target }]);
  else if (edge) void apply([{ type: "remove-edge", source: edge.source, target: edge.target }]);
  if (selection.value === target) selection.value = undefined;
}

function toggleMark(target: string) {
  void apply([{ type: "mark", target, marked: !marks.value.has(target) }]);
}

// Selects an element from the sidebar and brings it into view.
function focus(target: string) {
  selection.value = target;
  const edge = findEdge(target);
  const ids = edge ? [edge.source, edge.target] : [target];
  void flow.value?.fitView({ nodes: ids, duration: 300, maxZoom: 1.2, padding: 0.4 });
}

function elementMenu(target: string, point: Point): MenuItem[] {
  const isNode = findNode(target) !== undefined;
  return [
    { label: "Add note", shortcut: "N", action: () => promptNote(target, "note", point) },
    { label: "Add question", shortcut: "Q", action: () => promptNote(target, "question", point) },
    {
      label: marks.value.has(target) ? "Unmark" : "Mark",
      shortcut: "M",
      action: () => toggleMark(target),
    },
    {
      label: isNode ? "Rename" : "Edit label",
      shortcut: "F2",
      action: () => promptRename(target, point),
    },
    {
      label: isNode ? "Delete node" : "Delete connection",
      shortcut: "Del",
      danger: true,
      action: () => remove(target),
    },
  ];
}

function paneMenu(point: Point): MenuItem[] {
  return [
    { label: "Add node here", action: () => promptAddNode(point, true) },
    { label: "Add note", shortcut: "N", action: () => promptNote(undefined, "note", point) },
    {
      label: "Add question",
      shortcut: "Q",
      action: () => promptNote(undefined, "question", point),
    },
    ...(pinned.value
      ? [{ label: "Auto layout", action: () => void apply([{ type: "reset-layout" }]) }]
      : []),
    ...(marks.value.size > 0
      ? [{ label: "Clear marks", action: () => void apply([{ type: "clear-marks" }]) }]
      : []),
  ];
}

function openMenu(event: MouseEvent | TouchEvent, items: MenuItem[]) {
  event.preventDefault();
  prompt.value = undefined;
  menu.value = { ...place(eventPoint(event), { width: 208, height: 36 * items.length }), items };
}

function onElementMenu(target: string, event: MouseEvent | TouchEvent) {
  selection.value = target;
  openMenu(event, elementMenu(target, eventPoint(event)));
}

function onElementDoubleClick({ event, ...element }: NodeMouseEvent | EdgeMouseEvent) {
  const target = "node" in element ? element.node.id : element.edge.id;
  selection.value = target;
  promptNote(target, "note", eventPoint(event));
}

function onCanvasDoubleClick(event: MouseEvent) {
  const onPane =
    event.target instanceof Element && event.target.classList.contains("vue-flow__pane");
  if (onPane) promptNote(undefined, "note", eventPoint(event));
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
  const id = edgeId({ source, target });
  selection.value = id;
  void apply([{ type: "upsert-edge", edge: { source, target, label: "" } }]).then(() =>
    promptRename(id, pointer),
  );
}

function onKeydown(event: KeyboardEvent) {
  const typing = event.target instanceof HTMLElement && event.target.closest("input, select");
  if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
  const key = event.key.toLowerCase();
  const target = selection.value;
  if (key === "escape") {
    if (menu.value || prompt.value) {
      menu.value = undefined;
      prompt.value = undefined;
    } else selection.value = undefined;
  } else if (key === "n" || key === "q") {
    event.preventDefault();
    promptNote(target, key === "q" ? "question" : "note", pointer);
  } else if (target && key === "m") toggleMark(target);
  else if (target && key === "f2") promptRename(target, pointer);
  else if (target && (key === "delete" || key === "backspace")) remove(target);
}
onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => window.removeEventListener("keydown", onKeydown));

function trackPointer(event: PointerEvent) {
  pointer = { x: event.clientX, y: event.clientY };
}

function closePopovers() {
  menu.value = undefined;
  prompt.value = undefined;
}
</script>

<template>
  <div class="h-screen flex font-sans text-slate-800 dark:bg-slate-950 dark:text-slate-100">
    <div
      ref="canvas"
      class="relative flex-1 min-w-0"
      @pointermove="trackPointer"
      @dblclick="onCanvasDoubleClick"
    >
      <VueFlow
        v-if="ready"
        :key="files?.name"
        :nodes
        :edges
        :delete-key-code="null"
        :zoom-on-double-click="false"
        :min-zoom="0.2"
        fit-view-on-init
        @init="flow = $event"
        @node-click="select($event.node.id)"
        @edge-click="select($event.edge.id)"
        @pane-click="select()"
        @node-double-click="onElementDoubleClick"
        @edge-double-click="onElementDoubleClick"
        @node-context-menu="onElementMenu($event.node.id, $event.event)"
        @edge-context-menu="onElementMenu($event.edge.id, $event.event)"
        @pane-context-menu="openMenu($event, paneMenu(eventPoint($event)))"
        @move-start="closePopovers"
        @node-drag-stop="onDragStop"
        @connect="onConnect"
      >
        <template #node-diagram="props">
          <DiagramNodeView v-bind="props" />
        </template>
      </VueFlow>
      <p v-else-if="names.length === 0" class="muted p-6">
        Create <code>diagrams/&lt;name&gt;.txt</code> to start.
      </p>
      <CanvasLegend v-if="ready" />
      <ContextMenu v-if="menu" :request="menu" @close="menu = undefined" />
      <CanvasPrompt v-if="prompt" :key="promptKey" :request="prompt" @close="prompt = undefined" />
    </div>

    <aside
      class="w-80 shrink-0 flex flex-col gap-5 overflow-y-auto border-l border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900"
    >
      <div class="grid gap-1">
        <div class="flex items-end gap-2">
          <label class="grid flex-1 gap-1 text-sm font-medium">
            Diagram
            <select class="field" :value="files?.name" @change="open(fieldValue($event))">
              <option v-for="name in names" :key="name" :value="name">{{ name }}</option>
            </select>
          </label>
          <HelpPopover />
          <button
            type="button"
            class="button size-9 px-0"
            :aria-label="dark ? 'Switch to light mode' : 'Switch to dark mode'"
            :title="dark ? 'Light mode' : 'Dark mode'"
            @click="toggleTheme"
          >
            <svg
              class="mx-auto size-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <template v-if="dark">
                <circle cx="12" cy="12" r="4" />
                <path
                  d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
                />
              </template>
              <path v-else d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
            </svg>
          </button>
        </div>
        <span class="muted text-xs">diagrams/{{ files?.name }}.txt</span>
      </div>

      <template v-if="selection && (selectedNode || selectedEdge)">
        <button
          type="button"
          class="link justify-self-start text-left text-sm"
          @click="selection = undefined"
        >
          ← Overview
          <span class="muted"
            >({{ marks.size }} marked, {{ openQuestions.length }} open questions)</span
          >
        </button>

        <section :key="selection" class="grid gap-6">
          <header class="grid gap-3">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <h2 class="text-lg font-semibold [overflow-wrap:anywhere]">
                  {{ labelFor(selection) }}
                </h2>
                <p class="muted text-xs">
                  {{ selectedNode ? kindStyles[selectedNode.kind].name : "Connection" }} ·
                  <code class="code">{{ selection }}</code>
                </p>
              </div>
              <button
                type="button"
                class="button shrink-0"
                :class="
                  marks.has(selection) &&
                  'border-amber-500 bg-amber-50 dark:border-amber-500 dark:bg-amber-950'
                "
                :aria-pressed="marks.has(selection)"
                title="Marks highlight elements for you and the agent. Press M on the canvas."
                @click="toggleMark(selection)"
              >
                {{ marks.has(selection) ? "Marked" : "Mark" }}
              </button>
            </div>
            <button type="button" class="link justify-self-start text-xs" @click="copyPrompt">
              {{
                copied ? "Copied, paste it into the chat" : "Copy a prompt about this for the agent"
              }}
            </button>
          </header>

          <div class="grid gap-2">
            <h3 class="font-semibold">
              Open questions ({{ questionsFor(selection, false).length }})
            </h3>
            <ul v-if="questionsFor(selection, false).length > 0" class="grid gap-3">
              <NoteItem
                v-for="note in questionsFor(selection, false)"
                :key="note.text"
                :note
                @apply="apply"
              />
            </ul>
            <p v-else class="muted text-sm">Nothing to clarify here yet.</p>
            <details v-if="questionsFor(selection, true).length > 0" class="text-sm">
              <summary class="muted cursor-pointer">
                Resolved ({{ questionsFor(selection, true).length }})
              </summary>
              <ul class="mt-2 grid gap-3">
                <NoteItem
                  v-for="note in questionsFor(selection, true)"
                  :key="note.text"
                  :note
                  @apply="apply"
                />
              </ul>
            </details>
          </div>

          <div class="grid gap-2">
            <h3 class="font-semibold">Notes ({{ plainNotesFor(selection).length }})</h3>
            <ul v-if="plainNotesFor(selection).length > 0" class="grid gap-3">
              <NoteItem
                v-for="note in plainNotesFor(selection)"
                :key="note.text"
                :note
                @apply="apply"
              />
            </ul>
            <p v-else class="muted text-sm">No notes yet.</p>
          </div>

          <NoteComposer :target="selection" @apply="apply" />

          <div class="grid gap-2 border-t border-slate-200 pt-4 text-sm dark:border-slate-800">
            <h3 class="muted font-medium">Connections</h3>
            <template v-if="selectedNode">
              <p v-if="incoming.length + outgoing.length === 0" class="muted">None yet.</p>
              <ul class="grid gap-1">
                <li v-for="edge in incoming" :key="edgeId(edge)" class="flex gap-1.5">
                  <span class="muted" aria-label="from">←</span>
                  <button type="button" class="link text-left" @click="focus(edge.source)">
                    {{ labelFor(edge.source) }}
                  </button>
                  <button
                    v-if="edge.label"
                    type="button"
                    class="muted hover:underline"
                    @click="focus(edgeId(edge))"
                  >
                    {{ edge.label }}
                  </button>
                </li>
                <li v-for="edge in outgoing" :key="edgeId(edge)" class="flex gap-1.5">
                  <span class="muted" aria-label="to">→</span>
                  <button type="button" class="link text-left" @click="focus(edge.target)">
                    {{ labelFor(edge.target) }}
                  </button>
                  <button
                    v-if="edge.label"
                    type="button"
                    class="muted hover:underline"
                    @click="focus(edgeId(edge))"
                  >
                    {{ edge.label }}
                  </button>
                </li>
              </ul>
            </template>
            <p v-else-if="selectedEdge">
              <button type="button" class="link" @click="focus(selectedEdge.source)">
                {{ labelFor(selectedEdge.source) }}
              </button>
              <span class="muted"> → </span>
              <button type="button" class="link" @click="focus(selectedEdge.target)">
                {{ labelFor(selectedEdge.target) }}
              </button>
            </p>
          </div>

          <details class="text-sm">
            <summary class="muted cursor-pointer font-medium">Edit details</summary>
            <div class="mt-3 grid gap-3">
              <div v-if="selectedNode" class="grid grid-cols-[1fr_auto] gap-2">
                <input
                  class="field"
                  aria-label="Label"
                  :value="selectedNode.label"
                  @change="fieldValue($event) && updateNode({ label: fieldValue($event) })"
                />
                <select
                  class="field w-auto"
                  aria-label="Kind"
                  :value="selectedNode.kind"
                  @change="updateKind"
                >
                  <option v-for="kind in kinds" :key="kind" :value="kind">
                    {{ kindStyles[kind].name }}
                  </option>
                </select>
              </div>
              <input
                v-else-if="selectedEdge"
                class="field"
                aria-label="Label"
                placeholder="Label"
                :value="selectedEdge.label"
                @change="updateEdgeLabel"
              />
              <button
                type="button"
                class="justify-self-start text-red-600 hover:underline dark:text-red-400"
                @click="remove(selection)"
              >
                {{ selectedNode ? "Delete node" : "Delete connection" }}
              </button>
            </div>
          </details>
        </section>
      </template>

      <template v-else-if="files">
        <section
          class="grid gap-2 rounded-lg border border-slate-200 bg-white p-3 text-sm dark:border-slate-700 dark:bg-slate-800"
        >
          <h2 class="font-semibold">Working with the agent</h2>
          <p class="muted">
            Mark elements and add questions or notes here. They're saved to files the agent reads,
            so in the chat you only need to point at them, for example "look at what I marked".
          </p>
          <button type="button" class="button justify-self-start" @click="copyPrompt">
            {{ copied ? "Copied, paste it into the chat" : "Copy prompt" }}
          </button>
        </section>

        <section class="grid gap-2">
          <div class="flex items-baseline justify-between">
            <h2 class="font-semibold">Marked ({{ marks.size }})</h2>
            <button
              v-if="marks.size > 0"
              type="button"
              class="link text-sm"
              @click="apply([{ type: 'clear-marks' }])"
            >
              Clear
            </button>
          </div>
          <ul v-if="marks.size > 0" class="grid gap-1 text-sm">
            <li v-for="mark in marks" :key="mark">
              <button type="button" class="link text-left" @click="focus(mark)">
                {{ labelFor(mark) }}
              </button>
            </li>
          </ul>
          <p v-else class="muted text-sm">Select an element and press M to point at it.</p>
        </section>

        <section class="grid gap-2">
          <h2 class="font-semibold">Open questions ({{ openQuestions.length }})</h2>
          <ul v-if="openQuestions.length > 0" class="grid gap-3">
            <NoteItem
              v-for="note in openQuestions"
              :key="`${note.target} ${note.text}`"
              :note
              :label-for="labelFor"
              @apply="apply"
              @select="focus"
            />
          </ul>
          <p v-else class="muted text-sm">Nothing to clarify yet.</p>
          <details v-if="resolvedQuestions.length > 0" class="text-sm">
            <summary class="muted cursor-pointer">
              Resolved ({{ resolvedQuestions.length }})
            </summary>
            <ul class="mt-2 grid gap-3">
              <NoteItem
                v-for="note in resolvedQuestions"
                :key="`${note.target} ${note.text}`"
                :note
                :label-for="labelFor"
                @apply="apply"
                @select="focus"
              />
            </ul>
          </details>
        </section>

        <section class="grid gap-2">
          <h2 class="font-semibold">Whole diagram</h2>
          <p class="muted -mt-1 text-xs">
            Notes and questions that aren't about one element. Its questions appear above.
          </p>
          <ul v-if="diagramNotes.length > 0" class="grid gap-3">
            <NoteItem v-for="note in diagramNotes" :key="note.text" :note @apply="apply" />
          </ul>
          <NoteComposer @apply="apply" />
        </section>
      </template>

      <ul
        v-if="diagram.errors.length > 0"
        class="grid gap-1 text-sm text-red-700 dark:text-red-400"
      >
        <li v-for="error in diagram.errors" :key="error">{{ error }}</li>
      </ul>

      <div class="mt-auto flex gap-2">
        <button
          class="button"
          type="button"
          :disabled="!files"
          @click="promptAddNode(canvasCenter(), false)"
        >
          Add node
        </button>
        <button
          class="button"
          type="button"
          :disabled="!pinned"
          title="Drop manual positions and lay out automatically"
          @click="apply([{ type: 'reset-layout' }])"
        >
          Auto layout
        </button>
      </div>
    </aside>
  </div>
</template>
