import { computed, ref, shallowRef } from "vue";
import { embedded, readOnly } from "../mode";
import {
  isDiagramFiles,
  parseDiagram,
  partPattern,
  toDiagramFiles,
  type DiagramFiles,
  type Op,
  type PartSuffix,
} from "./format";

const isNames = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((name) => typeof name === "string");

async function request<T>(path: string, guard: (value: unknown) => value is T, init?: RequestInit) {
  const response = await fetch(`/__diagrams/${path}`, init);
  const body: unknown = await response.json();
  if (!response.ok || !guard(body)) throw new Error(`/__diagrams/${path}: ${JSON.stringify(body)}`);
  return body;
}

function useStore() {
  const names = ref<string[]>([]);
  const files = shallowRef<DiagramFiles>();
  const diagram = computed(() => parseDiagram(files.value?.source ?? ""));
  const layout = computed(() => files.value?.layout ?? {});
  return { names, files, diagram, layout };
}

// Canvas: every edit round-trips through the server and its files; file changes stream back.
function useServerDiagram() {
  const store = useStore();
  const { names, files } = store;
  let latest = 0;
  const accept = (next: DiagramFiles) => {
    if ((next.version ?? latest) < latest) return;
    latest = next.version ?? latest;
    files.value = next;
  };

  async function open(name: string) {
    accept(await request(name, isDiagramFiles));
    history.replaceState(null, "", `?diagram=${encodeURIComponent(name)}`);
  }

  async function apply(ops: Op[]) {
    if (!files.value || ops.length === 0) return;
    const body = JSON.stringify(ops);
    accept(await request(files.value.name, isDiagramFiles, { method: "POST", body }));
  }

  new EventSource("/__events").addEventListener("message", (message) => {
    const event: unknown = typeof message.data === "string" ? JSON.parse(message.data) : undefined;
    if (typeof event !== "object" || event === null) return;
    if ("names" in event && isNames(event.names)) names.value = event.names;
    if ("diagram" in event && isDiagramFiles(event.diagram)) {
      if (event.diagram.name === files.value?.name) accept(event.diagram);
    }
  });

  void (async () => {
    names.value = await request("", isNames);
    const initial = new URLSearchParams(location.search).get("diagram") ?? names.value[0];
    if (initial) await open(initial);
  })();

  return { ...store, open, apply, load: async (_files: Iterable<File>) => {} };
}

// Viewer: diagrams are embedded in the page or come from files the user opens; nothing is written.
function useFileDiagram() {
  const store = useStore();
  const { names, files } = store;
  let loaded = new Map<string, DiagramFiles>();

  function show(diagrams: DiagramFiles[], initial?: string | null) {
    loaded = new Map(diagrams.map((diagram) => [diagram.name, diagram]));
    names.value = [...loaded.keys()].toSorted();
    void open(initial && loaded.has(initial) ? initial : (names.value[0] ?? ""));
  }

  async function load(list: Iterable<File>) {
    const contents = await Promise.all(
      [...list].map(async (file) => [file.name, await file.text()] as const),
    );
    const parts = new Map<string, Partial<Record<PartSuffix, string>>>();
    for (const [fileName, content] of contents) {
      const [, name, suffix] = partPattern.exec(fileName) ?? [];
      if (name && suffix) parts.set(name, { ...parts.get(name), [suffix]: content });
    }
    show(
      [...parts]
        .filter(([, part]) => part[".txt"] !== undefined)
        .map(([name, part]) => toDiagramFiles(name, part)),
    );
  }

  async function open(name: string) {
    files.value = loaded.get(name);
    // Links to a published page can point at one of its diagrams.
    if (files.value) history.replaceState(null, "", `?diagram=${encodeURIComponent(name)}`);
  }

  if (embedded !== undefined) {
    const diagrams: unknown = JSON.parse(embedded);
    if (Array.isArray(diagrams)) {
      show(diagrams.filter(isDiagramFiles), new URLSearchParams(location.search).get("diagram"));
    }
  }

  return { ...store, open, apply: async (_ops: Op[]) => {}, load };
}

export const useDiagram = readOnly ? useFileDiagram : useServerDiagram;
