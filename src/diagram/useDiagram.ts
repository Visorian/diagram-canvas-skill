import { computed, ref, shallowRef } from "vue";
import { readOnly } from "../mode";
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

  async function open(name: string) {
    files.value = await request(name, isDiagramFiles);
    history.replaceState(null, "", `?diagram=${encodeURIComponent(name)}`);
  }

  async function apply(ops: Op[]) {
    if (!files.value || ops.length === 0) return;
    const body = JSON.stringify(ops);
    files.value = await request(files.value.name, isDiagramFiles, { method: "POST", body });
  }

  new EventSource("/__events").addEventListener("message", (message) => {
    const event: unknown = typeof message.data === "string" ? JSON.parse(message.data) : undefined;
    if (typeof event !== "object" || event === null) return;
    if ("names" in event && isNames(event.names)) names.value = event.names;
    if ("diagram" in event && isDiagramFiles(event.diagram)) {
      if (event.diagram.name === files.value?.name) files.value = event.diagram;
    }
  });

  void (async () => {
    names.value = await request("", isNames);
    const initial = new URLSearchParams(location.search).get("diagram") ?? names.value[0];
    if (initial) await open(initial);
  })();

  return { ...store, open, apply, load: async (_files: Iterable<File>) => {} };
}

// Viewer: diagrams come from files the user opens; nothing is written.
function useFileDiagram() {
  const store = useStore();
  const { names, files } = store;
  let loaded = new Map<string, DiagramFiles>();

  async function load(list: Iterable<File>) {
    const contents = await Promise.all(
      [...list].map(async (file) => [file.name, await file.text()] as const),
    );
    const parts = new Map<string, Partial<Record<PartSuffix, string>>>();
    for (const [fileName, content] of contents) {
      const [, name, suffix] = partPattern.exec(fileName) ?? [];
      if (name && suffix) parts.set(name, { ...parts.get(name), [suffix]: content });
    }
    loaded = new Map(
      [...parts]
        .filter(([, part]) => part[".txt"] !== undefined)
        .map(([name, part]) => [name, toDiagramFiles(name, part)]),
    );
    names.value = [...loaded.keys()].toSorted();
    files.value = loaded.get(names.value[0] ?? "");
  }

  async function open(name: string) {
    files.value = loaded.get(name);
  }

  return { ...store, open, apply: async (_ops: Op[]) => {}, load };
}

export const useDiagram = readOnly ? useFileDiagram : useServerDiagram;
