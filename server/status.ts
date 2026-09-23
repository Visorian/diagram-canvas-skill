// Compact status for agents: counts, validation errors, marks and open questions per diagram.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { edgeId, parseDiagram, partPattern, toDiagramFiles } from "../src/diagram/format.ts";
import { parseNotes } from "../src/diagram/notes.ts";

export async function diagramStatus(dir: string) {
  const read = (file: string) => readFile(join(dir, file), "utf8").catch(() => undefined);
  const names = (await readdir(dir)).flatMap((file) => {
    const match = partPattern.exec(file);
    return match?.[1] && match[2] === ".txt" ? [match[1]] : [];
  });

  const reports = await Promise.all(
    names.map(async (name) => {
      const [source, notes, marks] = await Promise.all(
        [".txt", ".notes.md", ".marks"].map((suffix) => read(`${name}${suffix}`)),
      );
      const files = toDiagramFiles(name, { ".txt": source, ".notes.md": notes, ".marks": marks });
      const { nodes, edges, errors } = parseDiagram(files.source);
      const entries = parseNotes(files.notes);
      const labels = new Map(nodes.map((node) => [node.id, node.label]));
      const targets = new Set([...labels.keys(), ...edges.map(edgeId)]);
      const describe = (target: string) =>
        labels.has(target) ? `${target} (${labels.get(target)})` : target;
      const open = entries.filter((note) => note.kind === "question" && !note.done);
      const unknown = [...entries.map((note) => note.target), ...files.marks].filter(
        (target) => target !== undefined && !targets.has(target),
      );

      const lines = [
        `${name}: ${nodes.length} nodes, ${edges.length} edges, ${open.length} open questions, ${entries.length - open.length} other notes`,
        ...errors.map((error) => `  error: ${error}`),
        ...(files.marks.length > 0 ? [`  marked: ${files.marks.map(describe).join(", ")}`] : []),
        ...open.map((note) => `  ? ${note.target ? `@${describe(note.target)} ` : ""}${note.text}`),
        ...[...new Set(unknown)].map((target) => `  unknown target: ${target}`),
      ];
      return { lines, failed: errors.length > 0 };
    }),
  );

  return {
    text: reports.map(({ lines }) => lines.join("\n")).join("\n"),
    failed: reports.some(({ failed }) => failed),
  };
}
