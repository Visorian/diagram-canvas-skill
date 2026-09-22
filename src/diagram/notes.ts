// Markdown list, one entry per line; other lines are kept as written:
//   - [ ] @orders Who owns payment retries?   open question
//   - [x] @orders Who owns payment retries?   resolved question
//   - @gateway->auth Token cache TTL is 5 min  note
//   - [ ] Split search out?                    no @target: about the whole diagram
export interface Note {
  kind: "note" | "question";
  target?: string;
  text: string;
  done: boolean;
}

export type NoteOp =
  | { type: "add-note"; note: Note }
  | { type: "resolve-note"; note: Note; done: boolean }
  | { type: "remove-note"; note: Note };

type NoteLine = { type: "note"; note: Note } | { type: "other"; text: string };

const notePattern = /^- (?:\[([ x])\] )?(?:@([\w-]+(?:->[\w-]+)?) )?(.+)$/;

function parseLine(text: string): NoteLine {
  const match = notePattern.exec(text.trim());
  if (!match?.[3]) return { type: "other", text };
  const note: Note = {
    kind: match[1] === undefined ? "note" : "question",
    text: match[3],
    done: match[1] === "x",
  };
  if (match[2]) note.target = match[2];
  return { type: "note", note };
}

function serializeLine(line: NoteLine) {
  if (line.type === "other") return line.text;
  const { kind, target, text, done } = line.note;
  const box = kind === "question" ? `[${done ? "x" : " "}] ` : "";
  return `- ${box}${target ? `@${target} ` : ""}${text}`;
}

const parseLines = (source: string) =>
  source === "" ? [] : source.replace(/\n$/, "").split("\n").map(parseLine);

const sameNote = (a: Note, b: Note) =>
  a.kind === b.kind && a.target === b.target && a.text === b.text;

export const parseNotes = (source: string) =>
  parseLines(source).flatMap((line) => (line.type === "note" ? [line.note] : []));

export function applyNoteOp(source: string, op: NoteOp) {
  let lines = parseLines(source);
  if (op.type === "add-note") {
    lines.push({ type: "note", note: op.note });
  } else if (op.type === "remove-note") {
    lines = lines.filter((line) => !(line.type === "note" && sameNote(line.note, op.note)));
  } else {
    lines = lines.map((line) =>
      line.type === "note" && sameNote(line.note, op.note)
        ? { type: "note", note: { ...line.note, done: op.done } }
        : line,
    );
  }
  return lines.length === 0 ? "" : `${lines.map(serializeLine).join("\n")}\n`;
}
