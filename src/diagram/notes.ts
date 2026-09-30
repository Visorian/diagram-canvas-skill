// Markdown list, one entry per line plus a question's answer; other lines are kept as written:
//   - [ ] @orders Who owns payment retries?     open question for the agent
//   - [ ] >user @orders Retry for how long?     open question for the user
//   - [x] @orders Who owns payment retries?     resolved question
//     → Payments team                           its answer, on the next line
//   - [ ] #risk @orders Can payment retry?      tagged question
//   - @gateway->auth Token cache TTL is 5 min   note
//   - @gateway->auth#2 Retries after a timeout  note on the second edge from gateway to auth
//   - [ ] Split search out?                     no @target: about the whole diagram
export interface Note {
  kind: "note" | "question";
  target?: string;
  tag?: string;
  // Questions the agent asks the user; the others are for the agent.
  forUser?: boolean;
  text: string;
  answer?: string;
  done: boolean;
}

export type NoteOp =
  | { type: "add-note"; note: Note }
  | { type: "update-note"; note: Note; next: Note }
  | { type: "remove-note"; note: Note };

type NoteLine = { type: "note"; note: Note } | { type: "other"; text: string };

const answerPattern = /^\s*→\s*(.+)$/;
const notePattern =
  /^- (?:\[([ x])\] (?:(>user) )?(?:#([\w-]+) )?)?(?:@([\w-]+(?:->[\w-]+(?:#\d+)?)?) )?(.+)$/;

function parseLine(text: string): NoteLine {
  const match = notePattern.exec(text.trim());
  const [, box, forUser, tag, target, body] = match ?? [];
  if (!body) return { type: "other", text };
  const note: Note = {
    kind: box === undefined ? "note" : "question",
    text: body,
    done: box === "x",
  };
  if (tag) note.tag = tag;
  if (target) note.target = target;
  if (forUser && note.kind === "question") note.forUser = true;
  return { type: "note", note };
}

function serializeLine(line: NoteLine) {
  if (line.type === "other") return line.text;
  const { kind, target, tag, forUser, text, answer, done } = line.note;
  const box = kind === "question" ? `[${done ? "x" : " "}] ${forUser ? ">user " : ""}` : "";
  const answerLine = answer ? `\n  → ${answer}` : "";
  return `- ${box}${tag ? `#${tag} ` : ""}${target ? `@${target} ` : ""}${text}${answerLine}`;
}

// An answer line belongs to the question right above it.
function parseLines(source: string) {
  const lines: NoteLine[] = [];
  for (const text of source === "" ? [] : source.replace(/\n$/, "").split("\n")) {
    const previous = lines.at(-1);
    const answer = answerPattern.exec(text)?.[1]?.trim();
    if (
      answer &&
      previous?.type === "note" &&
      previous.note.kind === "question" &&
      previous.note.answer === undefined
    ) {
      previous.note.answer = answer;
      continue;
    }
    lines.push(parseLine(text));
  }
  return lines;
}

const sameNote = (a: Note, b: Note) =>
  a.kind === b.kind &&
  a.target === b.target &&
  a.tag === b.tag &&
  Boolean(a.forUser) === Boolean(b.forUser) &&
  a.text === b.text;

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
      line.type === "note" && sameNote(line.note, op.note) ? { type: "note", note: op.next } : line,
    );
  }
  return lines.length === 0 ? "" : `${lines.map(serializeLine).join("\n")}\n`;
}
