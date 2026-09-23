# Diagram canvas

This repo builds the diagram canvas: a Vue Flow app where a user and an agent iterate on
architecture and workflow diagrams stored as plain text files.

The diagram format and the agent workflow are documented in [`skill/SKILL.md`](skill/SKILL.md),
which is also the skill that ships with the build. Follow it for the diagrams in `diagrams/`,
with these commands for this repo:

- `bun run dev` serves the canvas for `diagrams/` at `http://localhost:5173/?diagram=<name>`.
- `bun run diagrams` prints the status (counts, errors, marks, open questions).

## Build artifacts

`bun run build` writes to `dist/`:

- `canvas.js`: the editable canvas with its server. `node canvas.js [dir] [--port 7766]
[--host 127.0.0.1]` serves `dir` (default `./diagrams`), `node canvas.js status [dir]`
  prints the status. Bun works as well as Node.
- `viewer.html`: read-only viewer. Open it in a browser and choose or drop a diagram's files.
- `skill/`: `SKILL.md` plus `canvas.js`. `bun run install:skill` builds and copies it to
  `~/.claude/skills/diagram-canvas/` (or `$CLAUDE_SKILLS_DIR/diagram-canvas/`).
