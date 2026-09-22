// Compact status for agents: counts, validation errors, marks and open questions per diagram.
import { readFile, readdir } from "node:fs/promises";
import { edgeId, parseDiagram } from "../src/diagram/format";
import { parseNotes } from "../src/diagram/notes";

const read = (file: string) => readFile(`diagrams/${file}`, "utf8").catch(() => "");
const names = (await readdir("diagrams"))
  .filter((file) => /^[\w-]+\.txt$/.test(file))
  .map((file) => file.slice(0, -".txt".length));

const reports = await Promise.all(
  names.map(async (name) => {
    const [source, notesSource, marksSource] = await Promise.all([
      read(`${name}.txt`),
      read(`${name}.notes.md`),
      read(`${name}.marks`),
    ]);
    const { nodes, edges, errors } = parseDiagram(source);
    const notes = parseNotes(notesSource);
    const labels = new Map(nodes.map((node) => [node.id, node.label]));
    const targets = new Set([...labels.keys(), ...edges.map(edgeId)]);
    const describe = (target: string) =>
      labels.has(target) ? `${target} (${labels.get(target)})` : target;
    const open = notes.filter((note) => note.kind === "question" && !note.done);
    const marks = marksSource.split("\n").filter((mark) => mark.trim() !== "");
    const unknown = [...notes.map((note) => note.target), ...marks].filter(
      (target) => target !== undefined && !targets.has(target),
    );

    const lines = [
      `${name}: ${nodes.length} nodes, ${edges.length} edges, ${open.length} open questions, ${notes.length - open.length} other notes`,
      ...errors.map((error) => `  error: ${error}`),
      ...(marks.length > 0 ? [`  marked: ${marks.map(describe).join(", ")}`] : []),
      ...open.map((note) => `  ? ${note.target ? `@${describe(note.target)} ` : ""}${note.text}`),
      ...[...new Set(unknown)].map((target) => `  unknown target: ${target}`),
    ];
    return { lines, failed: errors.length > 0 };
  }),
);

for (const { lines } of reports) console.log(lines.join("\n"));
process.exitCode = reports.some(({ failed }) => failed) ? 1 : 0;
