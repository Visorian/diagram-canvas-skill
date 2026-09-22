import { computed, ref, shallowRef } from "vue";
import { isDiagramFiles, parseDiagram, type DiagramFiles, type Op } from "./format";

const isNames = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((name) => typeof name === "string");

async function request<T>(path: string, guard: (value: unknown) => value is T, init?: RequestInit) {
  const response = await fetch(`/__diagrams/${path}`, init);
  const body: unknown = await response.json();
  if (!response.ok || !guard(body)) throw new Error(`/__diagrams/${path}: ${JSON.stringify(body)}`);
  return body;
}

// Keeps the canvas in sync with `diagrams/<name>.txt`; every edit round-trips through the file.
export function useDiagram() {
  const names = ref<string[]>([]);
  const files = shallowRef<DiagramFiles>();
  const diagram = computed(() => parseDiagram(files.value?.source ?? ""));
  const layout = computed(() => files.value?.layout ?? {});

  async function open(name: string) {
    files.value = await request(name, isDiagramFiles);
    history.replaceState(null, "", `?diagram=${encodeURIComponent(name)}`);
  }

  async function apply(ops: Op[]) {
    if (!files.value || ops.length === 0) return;
    const body = JSON.stringify(ops);
    files.value = await request(files.value.name, isDiagramFiles, { method: "POST", body });
  }

  import.meta.hot?.on("diagrams:change", (event: { names: unknown; diagram: unknown }) => {
    if (isNames(event.names)) names.value = event.names;
    if (isDiagramFiles(event.diagram) && event.diagram.name === files.value?.name) {
      files.value = event.diagram;
    }
  });

  void (async () => {
    names.value = await request("", isNames);
    const initial = new URLSearchParams(location.search).get("diagram") ?? names.value[0];
    if (initial) await open(initial);
  })();

  return { names, files, diagram, layout, open, apply };
}
