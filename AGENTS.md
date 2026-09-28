# Diagram canvas skill

This repo builds the diagram canvas: a Vue Flow app where a user and an agent iterate on
architecture and workflow diagrams stored as plain text files.

The diagram format and the agent workflow are documented in [`skills/diagram-canvas/SKILL.md`](skills/diagram-canvas/SKILL.md),
which is also the skill that ships with the build. Follow it for the diagrams in `diagrams/`,
with these commands for this repo:

- `bun run dev` serves the canvas for `diagrams/` at `http://localhost:5173/?diagram=<name>`.
- `bun run diagrams` prints the status (counts, errors, marks, open questions and what changed
  since the previous status).

## Build artifacts

`bun run build` writes:

- `skills/diagram-canvas/canvas.js`: the editable canvas with its server, committed next to
  `SKILL.md` so `npx skills add` installs a working skill. Commit it after changing the sources;
  CI fails when it is outdated. `node canvas.js [dir] [--port 7766] [--host 127.0.0.1]
[--allow-host name]` serves `dir` (default `./diagrams`), `node canvas.js status [dir]` prints
  the status, `node canvas.js wait [dir]` waits until the user hands a diagram over and
  `node canvas.js export [dir] [--out diagrams.html]` writes a read-only page with the diagrams
  embedded. Bun works as well as Node.
- `dist/viewer.html`: read-only viewer. Open it in a browser and choose or drop a diagram's files.

`action.yml` is a GitHub Action that exports a project's diagrams and uploads the page for GitHub
Pages; `.github/workflows/pages.yml` uses it to publish this repo's `diagrams/`.

`bun run install:skill` builds and copies the skill to `~/.claude/skills/diagram-canvas/` (or
`$CLAUDE_SKILLS_DIR/diagram-canvas/`).
