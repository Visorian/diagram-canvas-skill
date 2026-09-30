// Compact status for agents: counts, validation errors, marks, open questions and what changed
// since the previous status, per diagram.
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  edgeId,
  edgeStatement,
  nodeStatement,
  parseDiagram,
  partNames,
  toDiagramFiles,
  type DiagramNode,
} from "../src/diagram/format.ts";
import { parseNotes, type Note } from "../src/diagram/notes.ts";

// What the previous status saw of each diagram.
export type Snapshot = Record<string, { source: string; notes: string; marks: string[] }>;

const isSnapshot = (value: unknown): value is Snapshot =>
  typeof value === "object" &&
  value !== null &&
  Object.values(value).every(
    (seen: unknown) =>
      typeof seen === "object" &&
      seen !== null &&
      "source" in seen &&
      typeof seen.source === "string" &&
      "notes" in seen &&
      typeof seen.notes === "string" &&
      "marks" in seen &&
      Array.isArray(seen.marks),
  );

const nodeLine = (node: DiagramNode) =>
  `${nodeStatement(node)}${node.group ? ` in [${node.group}]` : ""}`;

const noteKey = (note: Note) =>
  `${note.kind} ${note.forUser ? ">user " : ""}${note.target} ${note.text}`;

// `+` added, `-` removed and `~` changed items, keyed by `key` and shown by `show`.
function diff<T>(before: T[], after: T[], key: (item: T) => string, show: (item: T) => string) {
  const was = new Map(before.map((item) => [key(item), item]));
  const now = new Map(after.map((item) => [key(item), item]));
  const lines: string[] = [];
  for (const [id, item] of now) {
    const old = was.get(id);
    if (old === undefined) lines.push(`+ ${show(item)}`);
    else if (show(old) !== show(item)) lines.push(`~ ${show(item)}`);
  }
  for (const [id, item] of was) if (!now.has(id)) lines.push(`- ${show(item)}`);
  return lines;
}

export async function diagramStatus(dir: string, previous?: Snapshot) {
  const read = (file: string) => readFile(join(dir, file), "utf8").catch(() => undefined);
  // A project without a diagrams folder simply has no diagrams yet.
  const listing = await readdir(dir).catch(() => []);
  const names = partNames(listing, ".txt").toSorted();

  const reports = await Promise.all(
    names.map(async (name) => {
      const [source, notes, marks] = await Promise.all(
        [".txt", ".notes.md", ".marks"].map((suffix) => read(`${name}${suffix}`)),
      );
      const files = toDiagramFiles(name, { ".txt": source, ".notes.md": notes, ".marks": marks });
      const { nodes, edges, tags, errors } = parseDiagram(files.source);
      const entries = parseNotes(files.notes);
      const tagNames = new Set(tags.map((tag) => tag.name));
      const unknownTags = entries
        .map((note) => note.tag)
        .filter((tag) => tag !== undefined && !tagNames.has(tag));
      const labels = new Map(nodes.map((node) => [node.id, node.label]));
      const targets = new Set([...labels.keys(), ...edges.map(edgeId)]);
      const describe = (target: string) =>
        labels.has(target) ? `${target} (${labels.get(target)})` : target;
      const describeNote = (note: Note) =>
        [
          note.kind === "note" ? "note" : note.done ? "✓" : "?",
          note.forUser && ">user",
          note.tag && `#${note.tag}`,
          note.target && `@${describe(note.target)}`,
          note.text,
          note.answer && `→ ${note.answer}`,
        ]
          .filter(Boolean)
          .join(" ");
      const questions = entries.filter((note) => note.kind === "question");
      const open = questions.filter((note) => !note.done);
      const forUser = open.filter((note) => note.forUser).length;
      const unknown = [...entries.map((note) => note.target), ...files.marks].filter(
        (target) => target !== undefined && !targets.has(target),
      );

      const seen = previous?.[name];
      let changes: string[] = [];
      if (previous && !seen) changes = ["+ new diagram"];
      else if (seen) {
        const before = parseDiagram(seen.source);
        changes = [
          ...diff(
            before.nodes,
            nodes,
            (node) => node.id,
            (node) => `node ${nodeLine(node)}`,
          ),
          ...diff(before.edges, edges, edgeId, (edge) => `edge ${edgeStatement(edge)}`),
          ...diff(parseNotes(seen.notes), entries, noteKey, describeNote),
          ...diff(seen.marks, files.marks, String, (mark) => `mark ${describe(mark)}`),
        ];
      }

      const lines = [
        `${name}: ${nodes.length} nodes, ${edges.length} edges, ${open.length} open questions${forUser > 0 ? ` (${forUser} for the user)` : ""}, ${questions.length - open.length} resolved, ${entries.length - questions.length} notes`,
        ...errors.map((error) => `  error: ${error}`),
        ...(files.marks.length > 0 ? [`  marked: ${files.marks.map(describe).join(", ")}`] : []),
        ...open.map((note) => `  ${describeNote(note)}`),
        ...[...new Set(unknown)].map((target) => `  unknown target: ${target}`),
        ...[...new Set(unknownTags)].map((tag) => `  unknown tag: ${tag}`),
        ...(changes.length > 0
          ? ["  changed since the last status:", ...changes.map((change) => `    ${change}`)]
          : []),
      ];
      const snapshot = { source: files.source, notes: files.notes, marks: files.marks };
      return { name, lines, failed: errors.length > 0, snapshot };
    }),
  );

  const removed = Object.keys(previous ?? {})
    .filter((name) => !names.includes(name))
    .map((name) => `${name}: removed since the last status`);
  const text = [...reports.flatMap(({ lines }) => lines), ...removed];
  return {
    text: text.length === 0 ? `No diagrams in ${dir} yet.` : text.join("\n"),
    failed: reports.some(({ failed }) => failed),
    snapshot: Object.fromEntries(reports.map(({ name, snapshot }) => [name, snapshot])),
  };
}

// Snapshots live in the user's cache rather than the project, so they never show up in its files or
// commits, and rather than the shared temp folder, so other users can't plant or redirect them.
const cacheDir = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "diagram-canvas");
const snapshotPath = (dir: string) =>
  join(cacheDir, `${createHash("sha256").update(resolve(dir)).digest("hex").slice(0, 16)}.json`);

// Status with the changes since the previous call for the same folder.
export async function runStatus(dir: string) {
  const path = snapshotPath(dir);
  const previous: unknown = await readFile(path, "utf8")
    .then(JSON.parse)
    .catch(() => undefined);
  const status = await diagramStatus(dir, isSnapshot(previous) ? previous : undefined);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(path, JSON.stringify(status.snapshot));
  return status;
}
