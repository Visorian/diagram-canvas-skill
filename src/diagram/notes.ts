// Markdown list, one entry per line; other lines are kept as written:
//   - [ ] @orders Who owns payment retries?   open question
//   - [x] @orders Who owns payment retries?   resolved question
//   - [ ] #risk @orders Can payment retry?     tagged question
//   - @gateway->auth Token cache TTL is 5 min  note
//   - [ ] Split search out?                    no @target: about the whole diagram
export interface Note {
  kind: "note" | "question";
  target?: string;
  tag?: string;
  text: string;
  done: boolean;
}

export type NoteOp =
  | { type: "add-note"; note: Note }
  | { type: "resolve-note"; note: Note; done: boolean }
  | { type: "tag-note"; note: Note; tag?: string }
  | { type: "remove-note"; note: Note };

type NoteLine = { type: "note"; note: Note } | { type: "other"; text: string };

const questionPattern = /^- \[([ x])\] (?:#([\w-]+) )?(?:@([\w-]+(?:->[\w-]+)?) )?(.+)$/;
const notePattern = /^- (?:@([\w-]+(?:->[\w-]+)?) )?(.+)$/;

function parseLine(text: string): NoteLine {
  const question = questionPattern.exec(text.trim());
  if (question?.[4]) {
    const note: Note = { kind: "question", text: question[4], done: question[1] === "x" };
    if (question[2]) note.tag = question[2];
    if (question[3]) note.target = question[3];
    return { type: "note", note };
  }
  const match = notePattern.exec(text.trim());
  if (!match?.[2]) return { type: "other", text };
  const note: Note = { kind: "note", text: match[2], done: false };
  if (match[1]) note.target = match[1];
  return { type: "note", note };
}

function serializeLine(line: NoteLine) {
  if (line.type === "other") return line.text;
  const { kind, target, tag, text, done } = line.note;
  const box = kind === "question" ? `[${done ? "x" : " "}] ` : "";
  return `- ${box}${tag ? `#${tag} ` : ""}${target ? `@${target} ` : ""}${text}`;
}

const parseLines = (source: string) =>
  source === "" ? [] : source.replace(/\n$/, "").split("\n").map(parseLine);

const sameNote = (a: Note, b: Note) =>
  a.kind === b.kind && a.target === b.target && a.tag === b.tag && a.text === b.text;

export const parseNotes = (source: string) =>
  parseLines(source).flatMap((line) => (line.type === "note" ? [line.note] : []));

export function applyNoteOp(source: string, op: NoteOp) {
  let lines = parseLines(source);
  if (op.type === "add-note") {
    lines.push({ type: "note", note: op.note });
  } else if (op.type === "remove-note") {
    lines = lines.filter((line) => !(line.type === "note" && sameNote(line.note, op.note)));
  } else if (op.type === "resolve-note") {
    lines = lines.map((line) =>
      line.type === "note" && sameNote(line.note, op.note)
        ? { type: "note", note: { ...line.note, done: op.done } }
        : line,
    );
  } else {
    lines = lines.map((line) =>
      line.type === "note" && sameNote(line.note, op.note)
        ? { type: "note", note: { ...line.note, tag: op.tag } }
        : line,
    );
  }
  return lines.length === 0 ? "" : `${lines.map(serializeLine).join("\n")}\n`;
}
