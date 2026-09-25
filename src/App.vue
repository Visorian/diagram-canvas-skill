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
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  shallowRef,
  useTemplateRef,
  watch,
} from "vue";
import CanvasPrompt, { type PromptRequest } from "./CanvasPrompt.vue";
import ContextMenu, { type MenuItem, type MenuRequest } from "./ContextMenu.vue";
import DiagramNodeView, { type NodeData } from "./DiagramNode.vue";
import CanvasLegend from "./CanvasLegend.vue";
import HelpPopover from "./HelpPopover.vue";
import NoteComposer from "./NoteComposer.vue";
import NoteItem from "./NoteItem.vue";
import SelectMenu from "./SelectMenu.vue";
import { kindStyles } from "./kinds";
import { edgeId, kinds, type DiagramNode, type Layout, type Position } from "./diagram/format";
import { autoLayout, nodeSize } from "./diagram/layout";
import { parseNotes, type Note } from "./diagram/notes";
import { useDiagram } from "./diagram/useDiagram";
import { readOnly } from "./mode";
import { useTheme } from "./theme";

interface Point {
  x: number;
  y: number;
}

const { names, files, diagram, layout, open, apply, load } = useDiagram();
const { dark, toggle: toggleTheme } = useTheme();

// Below `md` the sidebar is a bottom sheet over the canvas, closed by default.
const small = matchMedia("(max-width: 767px)");
const storedSidebar = localStorage.getItem("sidebar");
const sidebarOpen = ref(storedSidebar ? storedSidebar === "open" : !small.matches);
function setSidebar(visible: boolean) {
  sidebarOpen.value = visible;
  localStorage.setItem("sidebar", visible ? "open" : "closed");
}
const auto = shallowRef<{ name: string; positions: Layout }>();
const selection = ref<string>();
const flow = shallowRef<VueFlowStore>();
const canvas = useTemplateRef("canvas");
const fileInput = useTemplateRef("fileInput");
const sidebar = useTemplateRef("sidebar");
const sidebarWidth = ref(320);

function resizeSidebar(width: number) {
  sidebarWidth.value = Math.max(256, Math.min(640, width));
}

function onResizeStart(event: PointerEvent) {
  if (event.button === 0 && event.currentTarget instanceof Element)
    event.currentTarget.setPointerCapture(event.pointerId);
}

function onResizeMove(event: PointerEvent) {
  if (
    event.currentTarget instanceof Element &&
    event.currentTarget.hasPointerCapture(event.pointerId) &&
    sidebar.value
  )
    resizeSidebar(sidebar.value.getBoundingClientRect().right - event.clientX);
}

const prompt = shallowRef<PromptRequest>();
const menu = shallowRef<MenuRequest>();
// Remounts the prompt for every request so it starts with fresh text.
const promptKey = ref(0);
// Last pointer position over the canvas, used to place prompts opened by keyboard.
let pointer: Point = { x: 0, y: 0 };

// On small screens, tapping an element opens the sheet and keeps the element visible above it.
// Waits out a possible double tap first, which opens the note prompt instead of the sheet.
let sheetTimer: ReturnType<typeof setTimeout> | undefined;
watch(selection, (target) => {
  sidebar.value?.scrollTo({ top: 0 });
  clearTimeout(sheetTimer);
  if (!target || !small.matches) return;
  sheetTimer = setTimeout(async () => {
    sidebarOpen.value = true;
    await nextTick();
    revealAboveSheet(target);
  }, 350);
});

// Mobile sheet: half or full height; the grab bar drags it (down closes, up expands).
const sheetFull = ref(false);
const sheetOffset = ref(0);
let dragStart: number | undefined;

function onGrabStart(event: PointerEvent) {
  if (event.target instanceof Element && event.target.closest("button")) return;
  dragStart = event.clientY;
  if (event.currentTarget instanceof Element)
    event.currentTarget.setPointerCapture(event.pointerId);
}

function onGrabMove(event: PointerEvent) {
  if (dragStart !== undefined) sheetOffset.value = event.clientY - dragStart;
}

function onGrabEnd() {
  if (dragStart === undefined) return;
  const offset = sheetOffset.value;
  dragStart = undefined;
  sheetOffset.value = 0;
  if (offset > 80) {
    if (sheetFull.value) sheetFull.value = false;
    else setSidebar(false);
  } else if (offset < -60) sheetFull.value = true;
}

function revealAboveSheet(target: string) {
  const store = flow.value;
  const node = store?.findNode(findEdge(target)?.source ?? target);
  const sheetTop = sidebar.value?.getBoundingClientRect().top;
  if (!store || !node || sheetTop === undefined) return;
  const element = canvas.value?.querySelector(`.vue-flow__node[data-id="${node.id}"]`);
  const rect = element?.getBoundingClientRect();
  if (rect && rect.top >= 0 && rect.bottom <= sheetTop) return;
  const zoom = Math.max(store.viewport.value.zoom, 0.8);
  const sheetHeight = window.innerHeight - sheetTop;
  void store.setCenter(
    node.position.x + node.dimensions.width / 2,
    node.position.y + node.dimensions.height / 2 + sheetHeight / 2 / zoom,
    { zoom, duration: 300 },
  );
}

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
const tagFilter = ref("");
const tagOptions = computed(() => [
  { value: "", label: "All tags" },
  { value: "#", label: "Untagged" },
  ...diagram.value.tags.map(({ name, color }) => ({ value: name, label: name, color })),
]);
watch(
  () => diagram.value.tags,
  (tags) => {
    if (tagFilter.value !== "#" && !tags.some(({ name }) => name === tagFilter.value))
      tagFilter.value = "";
  },
);
const matchesTag = (note: Note) =>
  tagFilter.value === "" || (tagFilter.value === "#" ? !note.tag : note.tag === tagFilter.value);
const openQuestions = computed(() =>
  notes.value.filter((note) => isOpen(note) && matchesTag(note)),
);
const resolvedQuestions = computed(() =>
  notes.value.filter((note) => note.kind === "question" && note.done && matchesTag(note)),
);
const diagramNotes = computed(() =>
  notes.value.filter((note) => note.target === undefined && note.kind === "note"),
);
const notesFor = (target: string) => notes.value.filter((note) => note.target === target);
const questionsFor = (target: string, done: boolean) =>
  notesFor(target).filter(
    (note) => note.kind === "question" && note.done === done && matchesTag(note),
  );
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

const diagramOptions = computed(() => names.value.map((name) => ({ value: name, label: name })));
const kindOptions = kinds.map((kind) => ({ value: kind, label: kindStyles[kind].name }));

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
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: dark.value ? "#64748b" : "#94a3b8",
        // The arrow shape fills about a quarter of the marker box.
        width: 28,
        height: 28,
      },
      selected: selection.value === id,
      // Vue Flow keeps previous values for omitted fields, so unmarked edges reset them explicitly.
      style: {},
      labelStyle: {},
    };
    if (!marks.value.has(id)) return flowEdge;
    return Object.assign(flowEdge, {
      style: { stroke: "#d97706", strokeWidth: 3 },
      // Marker size scales with stroke width, so this matches the unmarked arrows.
      markerEnd: { type: MarkerType.ArrowClosed, color: "#d97706", width: 10, height: 10 },
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
  // On small screens an open sheet covers the lower part of the canvas.
  const sheetTop =
    small.matches && sidebarOpen.value ? sidebar.value?.getBoundingClientRect().top : undefined;
  const bottom = Math.min(rect.bottom, sheetTop ?? rect.bottom);
  return {
    x: clamp(x - rect.left, rect.width - size.width),
    y: clamp(y - rect.top, bottom - rect.top - size.height),
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
  prompt.value = {
    ...place(point, { width: 288, height: request.tags?.length ? 174 : 130 }),
    ...request,
  };
}

function promptNote(target: string | undefined, kind: Note["kind"], point: Point) {
  openPrompt(point, {
    title: target ? labelFor(target) : "Whole diagram",
    placeholder: kind === "question" ? "What should we clarify?" : "Add a note",
    kind,
    tags: diagram.value.tags,
    submit: (text, chosen, tag) => {
      if (!text) return;
      const note: Note = { kind: chosen, text, done: false };
      if (target) note.target = target;
      if (chosen === "question" && tag) note.tag = tag;
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
  // Small screens reveal the selection above the sheet instead (see the selection watcher).
  if (small.matches) return;
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
  if (readOnly) return;
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
  if (readOnly) return;
  clearTimeout(sheetTimer);
  promptNote(target, "note", eventPoint(event));
}

function onCanvasDoubleClick(event: MouseEvent) {
  const onPane =
    event.target instanceof Element && event.target.classList.contains("vue-flow__pane");
  if (onPane && !readOnly) promptNote(undefined, "note", eventPoint(event));
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
  } else if (readOnly) {
    // The viewer has no editing shortcuts.
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

// Viewer only: diagrams come from files the user opens or drops.
function onFiles(event: Event) {
  if (event.target instanceof HTMLInputElement && event.target.files) void load(event.target.files);
}

function onDrop(event: DragEvent) {
  if (readOnly && event.dataTransfer) void load(event.dataTransfer.files);
}

function closePopovers() {
  menu.value = undefined;
  prompt.value = undefined;
}
</script>

<template>
  <div
    class="h-dvh flex font-sans text-slate-800 dark:bg-slate-950 dark:text-slate-100"
    @dragover.prevent
    @drop.prevent="onDrop"
  >
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
        :class="readOnly && 'read-only'"
        :delete-key-code="null"
        :nodes-draggable="!readOnly"
        :nodes-connectable="!readOnly"
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
      <div v-else-if="readOnly && !files" class="grid h-full place-items-center p-6">
        <div class="grid max-w-sm gap-3 text-center text-sm">
          <h1 class="heading text-lg">Open a diagram</h1>
          <p class="muted">
            Choose or drop its files: <code class="code">name.txt</code> and, if present,
            <code class="code">name.notes.md</code>, <code class="code">name.layout.json</code> and
            <code class="code">name.marks</code>.
          </p>
          <button type="button" class="button justify-self-center" @click="fileInput?.click()">
            Choose files
          </button>
        </div>
      </div>
      <p v-else-if="names.length === 0" class="muted p-6">
        Create <code>diagrams/&lt;name&gt;.txt</code> to start.
      </p>
      <input
        v-if="readOnly"
        ref="fileInput"
        type="file"
        multiple
        accept=".txt,.md,.json,.marks"
        class="hidden"
        @change="onFiles"
      />
      <CanvasLegend v-if="ready" />
      <button
        v-if="!sidebarOpen"
        type="button"
        class="button absolute bottom-3 right-3 z-10 flex items-center gap-2 shadow-sm md:bottom-auto md:top-3"
        aria-label="Show sidebar"
        @click="setSidebar(true)"
      >
        <svg
          class="size-5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <rect width="18" height="18" x="3" y="3" rx="2" />
          <path d="M15 3v18" />
        </svg>
        Sidebar
      </button>
      <ContextMenu v-if="menu" :request="menu" @close="menu = undefined" />
      <CanvasPrompt v-if="prompt" :key="promptKey" :request="prompt" @close="prompt = undefined" />
    </div>

    <div
      v-show="sidebarOpen"
      class="hidden w-1.5 shrink-0 cursor-col-resize touch-none select-none hover:bg-slate-300 focus-visible:bg-slate-300 dark:hover:bg-slate-600 dark:focus-visible:bg-slate-600 md:block"
      role="separator"
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-controls="sidebar"
      :aria-valuenow="sidebarWidth"
      :aria-valuemin="256"
      :aria-valuemax="640"
      tabindex="0"
      @pointerdown.prevent="onResizeStart"
      @pointermove="onResizeMove"
      @keydown.left.prevent="resizeSidebar(sidebarWidth + 16)"
      @keydown.right.prevent="resizeSidebar(sidebarWidth - 16)"
    />
    <aside
      v-show="sidebarOpen"
      id="sidebar"
      ref="sidebar"
      class="fixed inset-x-0 bottom-0 z-30 flex flex-col gap-6 overflow-y-auto border-t border-slate-200 bg-slate-50 px-4 text-sm shadow-lg dark:border-slate-800 dark:bg-slate-900 md:static md:pt-4 md:h-auto md:max-h-none md:w-[var(--sidebar-width)] md:shrink-0 md:rounded-none md:border-t-0 md:border-l md:shadow-none"
      :class="[
        sheetFull ? 'h-dvh' : 'max-h-[65dvh] rounded-t-xl',
        sheetOffset === 0 && 'transition-transform duration-200',
      ]"
      :style="{
        '--sidebar-width': `${sidebarWidth}px`,
        transform: sheetOffset > 0 ? `translateY(${sheetOffset}px)` : undefined,
      }"
    >
      <div
        class="sticky top-0 z-10 -mx-4 -mb-3 flex touch-none select-none justify-center bg-slate-50 px-4 pb-2 pt-2.5 dark:bg-slate-900 md:hidden"
        @pointerdown="onGrabStart"
        @pointermove="onGrabMove"
        @pointerup="onGrabEnd"
        @pointercancel="onGrabEnd"
      >
        <span class="h-1.5 w-10 rounded-full bg-slate-300 dark:bg-slate-600" aria-hidden="true" />
        <button
          type="button"
          class="muted absolute right-2 top-0.5 grid size-8 place-items-center"
          :aria-label="sheetFull ? 'Half height' : 'Full height'"
          :title="sheetFull ? 'Half height' : 'Full height'"
          @click="sheetFull = !sheetFull"
        >
          <svg
            class="size-5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path v-if="sheetFull" d="m7 6 5 5 5-5M7 13l5 5 5-5" />
            <path v-else d="m17 11-5-5-5 5M17 18l-5-5-5 5" />
          </svg>
        </button>
      </div>

      <header class="grid gap-1.5">
        <div class="relative flex items-center gap-2">
          <SelectMenu
            class="flex-1"
            label="Diagram"
            :model-value="files?.name ?? ''"
            :options="diagramOptions"
            @update:model-value="(name) => void open(name)"
          />
          <HelpPopover v-if="!readOnly" />
          <button
            type="button"
            class="button grid size-9 place-items-center px-0"
            :aria-label="dark ? 'Switch to light mode' : 'Switch to dark mode'"
            :title="dark ? 'Light mode' : 'Dark mode'"
            @click="toggleTheme"
          >
            <svg
              class="size-5"
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
          <button
            type="button"
            class="button grid size-9 place-items-center px-0"
            aria-label="Hide sidebar"
            title="Hide sidebar"
            @click="setSidebar(false)"
          >
            <svg
              class="size-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <rect width="18" height="18" x="3" y="3" rx="2" />
              <path d="M15 3v18" />
            </svg>
          </button>
        </div>
        <p v-if="readOnly" class="muted text-xs">
          {{ files ? `${files.name}.txt · ` : "" }}
          <button type="button" class="link" @click="fileInput?.click()">Open files</button>
        </p>
        <p v-else class="muted text-xs">
          diagrams/{{ files?.name }}.txt ·
          <button
            type="button"
            class="link"
            :title="
              selection
                ? 'Copy a chat prompt about this element'
                : 'Copy a chat prompt about your marks and questions'
            "
            @click="copyPrompt"
          >
            {{ copied ? "Copied" : "Copy prompt" }}
          </button>
        </p>
        <p v-if="readOnly" class="muted text-xs">Read-only view of the diagram files.</p>
        <p v-else-if="!selection" class="muted text-xs">
          Mark elements and add questions; the agent reads them from these files.
        </p>
      </header>

      <template v-if="selection && (selectedNode || selectedEdge)">
        <button type="button" class="link self-start" @click="selection = undefined">
          Back to overview
        </button>

        <section :key="selection" class="grid gap-6">
          <div class="flex items-center justify-between gap-3">
            <div class="grid min-w-0 gap-0.5">
              <h2 class="heading text-lg leading-tight break-words">
                {{
                  selectedEdge ? selectedEdge.label || "Unlabeled connection" : labelFor(selection)
                }}
              </h2>
              <p v-if="selectedNode" class="muted text-xs">
                {{ kindStyles[selectedNode.kind].name }} ·
                <code class="code">{{ selection }}</code>
              </p>
              <p v-else-if="selectedEdge" class="muted text-xs">
                Connection from
                <button type="button" class="link" @click="focus(selectedEdge.source)">
                  {{ labelFor(selectedEdge.source) }}
                </button>
                to
                <button type="button" class="link" @click="focus(selectedEdge.target)">
                  {{ labelFor(selectedEdge.target) }}
                </button>
              </p>
            </div>
            <button
              v-if="!readOnly"
              type="button"
              class="button shrink-0"
              :class="
                marks.has(selection) &&
                'border-amber-500 bg-amber-50 text-amber-800 dark:border-amber-600 dark:bg-amber-900/40 dark:text-amber-200'
              "
              :aria-pressed="marks.has(selection)"
              :title="
                marks.has(selection)
                  ? 'Marked for you and the agent. Click to unmark.'
                  : 'Highlight this for you and the agent (M)'
              "
              @click="toggleMark(selection)"
            >
              {{ marks.has(selection) ? "Unmark" : "Mark" }}
            </button>
          </div>

          <div class="grid gap-4">
            <div
              v-if="notesFor(selection).some((note) => note.kind === 'question')"
              class="grid gap-2"
            >
              <div class="flex items-center justify-between gap-2">
                <h3 class="heading">
                  Open questions
                  <span class="muted font-normal">{{ questionsFor(selection, false).length }}</span>
                </h3>
                <SelectMenu
                  v-model="tagFilter"
                  class="w-32 shrink-0"
                  label="Filter questions by tag"
                  :options="tagOptions"
                />
              </div>
              <ul v-if="questionsFor(selection, false).length > 0" class="grid gap-2">
                <NoteItem
                  v-for="note in questionsFor(selection, false)"
                  :key="note.text"
                  :note
                  :tags="diagram.tags"
                  @apply="apply"
                />
              </ul>
              <p v-else class="muted">No matching open questions.</p>
              <details v-if="questionsFor(selection, true).length > 0">
                <summary class="disclosure font-normal">
                  Resolved {{ questionsFor(selection, true).length }}
                </summary>
                <ul class="mt-2 grid gap-2">
                  <NoteItem
                    v-for="note in questionsFor(selection, true)"
                    :key="note.text"
                    :note
                    :tags="diagram.tags"
                    @apply="apply"
                  />
                </ul>
              </details>
            </div>

            <div v-if="plainNotesFor(selection).length > 0" class="grid gap-2">
              <h3 class="heading">
                Notes <span class="muted font-normal">{{ plainNotesFor(selection).length }}</span>
              </h3>
              <ul class="grid gap-2">
                <NoteItem
                  v-for="note in plainNotesFor(selection)"
                  :key="note.text"
                  :note
                  :tags="diagram.tags"
                  @apply="apply"
                />
              </ul>
            </div>

            <p v-if="notesFor(selection).length === 0" class="muted">
              {{
                readOnly
                  ? "No notes or questions."
                  : "Nothing here yet. Add a question to discuss it with the agent."
              }}
            </p>
            <NoteComposer
              v-if="!readOnly"
              :target="selection"
              :tags="diagram.tags"
              @apply="apply"
            />
          </div>

          <div
            v-if="selectedNode"
            class="grid gap-2 border-t border-slate-200 pt-4 dark:border-slate-800"
          >
            <h3 class="heading">Connections</h3>
            <p v-if="incoming.length + outgoing.length === 0" class="muted">None yet.</p>
            <ul v-else class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <template v-for="edge in incoming" :key="edgeId(edge)">
                <li class="muted contents">
                  <span>from</span>
                  <span>
                    <button type="button" class="link text-left" @click="focus(edge.source)">
                      {{ labelFor(edge.source) }}
                    </button>
                    <button
                      v-if="edge.label"
                      type="button"
                      class="muted ml-1.5 hover:underline"
                      @click="focus(edgeId(edge))"
                    >
                      {{ edge.label }}
                    </button>
                  </span>
                </li>
              </template>
              <template v-for="edge in outgoing" :key="edgeId(edge)">
                <li class="muted contents">
                  <span>to</span>
                  <span>
                    <button type="button" class="link text-left" @click="focus(edge.target)">
                      {{ labelFor(edge.target) }}
                    </button>
                    <button
                      v-if="edge.label"
                      type="button"
                      class="muted ml-1.5 hover:underline"
                      @click="focus(edgeId(edge))"
                    >
                      {{ edge.label }}
                    </button>
                  </span>
                </li>
              </template>
            </ul>
          </div>

          <details v-if="!readOnly" class="border-t border-slate-200 pt-4 dark:border-slate-800">
            <summary class="disclosure">Edit details</summary>
            <div class="mt-3 grid gap-3">
              <div v-if="selectedNode" class="grid grid-cols-[1fr_auto] gap-2">
                <input
                  class="field"
                  aria-label="Label"
                  :value="selectedNode.label"
                  @change="fieldValue($event) && updateNode({ label: fieldValue($event) })"
                />
                <SelectMenu
                  class="w-36"
                  label="Kind"
                  :model-value="selectedNode.kind"
                  :options="kindOptions"
                  @update:model-value="(kind) => updateNode({ kind })"
                />
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
                class="button justify-self-start border-red-200 text-red-600 dark:border-red-900 dark:text-red-400"
                @click="remove(selection)"
              >
                {{ selectedNode ? "Delete node" : "Delete connection" }}
              </button>
            </div>
          </details>
        </section>
      </template>

      <template v-else-if="files">
        <section class="grid gap-2">
          <div class="flex items-baseline justify-between">
            <h2 class="heading">
              Marked <span class="muted font-normal">{{ marks.size }}</span>
            </h2>
            <button
              v-if="marks.size > 0 && !readOnly"
              type="button"
              class="link"
              @click="apply([{ type: 'clear-marks' }])"
            >
              Clear
            </button>
          </div>
          <ul v-if="marks.size > 0" class="grid gap-1">
            <li v-for="mark in marks" :key="mark">
              <button type="button" class="link text-left" @click="focus(mark)">
                {{ labelFor(mark) }}
              </button>
            </li>
          </ul>
          <p v-else class="muted">
            {{ readOnly ? "Nothing marked." : "Select an element and press M to point at it." }}
          </p>
        </section>

        <section class="grid gap-2">
          <div class="flex items-center justify-between gap-2">
            <h2 class="heading">
              Open questions <span class="muted font-normal">{{ openQuestions.length }}</span>
            </h2>
            <SelectMenu
              v-model="tagFilter"
              class="w-32 shrink-0"
              label="Filter questions by tag"
              :options="tagOptions"
            />
          </div>
          <ul v-if="openQuestions.length > 0" class="grid gap-2">
            <NoteItem
              v-for="note in openQuestions"
              :key="`${note.target} ${note.text}`"
              :note
              :tags="diagram.tags"
              :label-for="labelFor"
              @apply="apply"
              @select="focus"
            />
          </ul>
          <p v-else class="muted">
            {{ tagFilter ? "No matching open questions." : "Nothing to clarify yet." }}
          </p>
          <details v-if="resolvedQuestions.length > 0">
            <summary class="disclosure font-normal">
              Resolved {{ resolvedQuestions.length }}
            </summary>
            <ul class="mt-2 grid gap-2">
              <NoteItem
                v-for="note in resolvedQuestions"
                :key="`${note.target} ${note.text}`"
                :note
                :tags="diagram.tags"
                :label-for="labelFor"
                @apply="apply"
                @select="focus"
              />
            </ul>
          </details>
        </section>

        <section v-if="!readOnly || diagramNotes.length > 0" class="grid gap-2">
          <h2 class="heading">Notes about the whole diagram</h2>
          <ul v-if="diagramNotes.length > 0" class="grid gap-2">
            <NoteItem
              v-for="note in diagramNotes"
              :key="note.text"
              :note
              :tags="diagram.tags"
              @apply="apply"
            />
          </ul>
          <NoteComposer v-if="!readOnly" :tags="diagram.tags" @apply="apply" />
        </section>
      </template>

      <ul v-if="diagram.errors.length > 0" class="grid gap-1 text-red-700 dark:text-red-400">
        <li v-for="error in diagram.errors" :key="error">{{ error }}</li>
      </ul>

      <div
        v-if="!readOnly"
        class="sticky bottom-0 -mx-4 mt-auto flex gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-900"
      >
        <button
          class="button"
          type="button"
          :disabled="!files"
          @click="promptAddNode(canvasCenter(), false)"
        >
          Add node
        </button>
        <button
          v-if="pinned"
          class="button"
          type="button"
          title="Drop manual positions and lay out automatically"
          @click="apply([{ type: 'reset-layout' }])"
        >
          Auto layout
        </button>
      </div>
    </aside>
  </div>
</template>
