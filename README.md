# Diagram canvas skill

[![Latest release](https://img.shields.io/github/v/release/Visorian/diagram-canvas-skill?label=version)](https://github.com/Visorian/diagram-canvas-skill/releases/latest)
[![Size of canvas.js](https://img.shields.io/github/size/Visorian/diagram-canvas-skill/skills/diagram-canvas/canvas.js?label=canvas.js)](skills/diagram-canvas/canvas.js)

An agent skill for drawing architecture and workflow diagrams together with a coding agent. The
diagram lives in plain text files in your project. You look at it and edit it on a canvas in the
browser, the agent edits the same files, and both sides see each other's changes right away.

To point the agent at something, you mark nodes and connections and leave notes and questions on
them. The agent answers or changes the diagram, and asks you questions of its own, which you
answer on the canvas.

![The canvas with a shop platform diagram in three groups and its main flow animated, compared with an earlier commit that highlights an added event bus, a renamed service and a removed mailer, two marked elements and questions for the user and the agent, split diagonally into the light and the dark theme](docs/screenshot.png)

## Install

Install it for your agents with the [skills](https://skills.sh) CLI:

```sh
npx skills add Visorian/diagram-canvas-skill
```

Or download it from the latest release into your skills folder:

```sh
curl -fsSLO https://github.com/Visorian/diagram-canvas-skill/releases/latest/download/diagram-canvas.zip
unzip -o diagram-canvas.zip -d ~/.claude/skills/ && rm diagram-canvas.zip
```

The canvas needs Node 20+ or Bun.

## Use

Ask the agent for a diagram, for example "Map the services in this repo as a diagram and open the
canvas". It writes `diagrams/<name>.txt`, starts the canvas and gives you a link.

On the canvas:

- Select an element and press `M` to mark it, `Q` to ask a question or `N` to add a note.
- Drag from a node's dot to connect it, and right-click for more actions. The `?` button lists all
  shortcuts.
- Answer the agent's questions under "Waiting on you". The answer is saved with the question.
- Pick another diagram, such as a second plan, or a commit under "Compare with" to see how they
  differ. Press `V` to switch between both; the current one highlights what it added, changed or
  removed.
- Press "Send to agent" to hand the diagram back, with an optional message about the selected
  element. The agent waits for it in the background and sees what you changed. If it isn't
  waiting, use "Copy prompt" and paste the prompt into the chat.

A diagram is a few small files you can commit and review like code:

```
diagrams/platform.txt          nodes and connections
diagrams/platform.notes.md     notes and questions
diagrams/platform.layout.json  positions you dragged
diagrams/platform.marks        current marks, short-lived
```

The format is documented in [`skills/diagram-canvas/SKILL.md`](skills/diagram-canvas/SKILL.md).

## View online

The canvas starts in dark mode and remembers a theme the user chooses.
`canvas.js export diagrams --diagram shop --out shop.svg` exports a dark SVG image using automatic
layout, with moving dotted lines on `=>` connections and notes as tooltips. Sequence diagrams carry a short dotted trail along each connection in step
order, and removed connections stay stationary. Add `--compare shop-before` to include
changes against another diagram. Sequence comparisons use a small change legend and put before/after details below the flow.
Operation labels sit clear of the arrows. The SVG needs no browser, scripts or external assets.

`canvas.js export diagrams --out diagrams.html` writes all diagrams into one read-only page that
works without a server. To publish it on GitHub Pages, set **Settings → Pages → Source** to
"GitHub Actions" and add this workflow:

```yaml
name: Diagrams

on:
  push:
    branches: [main]
    paths: [diagrams/**]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deploy.outputs.page_url }}
    steps:
      - uses: actions/checkout@v7
      # Exports diagrams/ and uploads the page; pin a release tag to control updates.
      - uses: Visorian/diagram-canvas-skill@main
      - id: deploy
        uses: actions/deploy-pages@v5
```

Link to a single diagram with `?diagram=<name>`, like this repo's
[example](https://visorian.github.io/diagram-canvas-skill/?diagram=platform), and to a comparison
with `&compare=<other>`, like two plans for a
[checkout workflow](https://visorian.github.io/diagram-canvas-skill/?diagram=checkout-plan-b&compare=checkout-plan-a)
and a [hosting architecture](https://visorian.github.io/diagram-canvas-skill/?diagram=hosting-plan-b&compare=hosting-plan-a).

The online viewer is only available when GitHub Pages is enabled and the repository is public, or on
GitHub Enterprise Cloud. There, a private or internal repository can publish the site privately, so
only people who can read the repository see it. On GitHub Free, Pro and Team a Pages site is always
public, even from a private repository, so don't publish internal diagrams there; share the exported
file instead.

## Develop

```sh
bun install
bun run dev      # canvas for diagrams/ at http://localhost:5173/?diagram=platform
bun run check    # format, lint, typecheck, test and build
```

`bun run build` bundles the canvas into `skills/diagram-canvas/canvas.js` and writes a read-only
`dist/viewer.html` that opens diagram files you choose. The bundle is committed, so the skill
installs straight from the repo; CI fails when it doesn't match the sources.
`bun run install:skill` builds the skill and copies it to `~/.claude/skills/diagram-canvas/`.

## License

[MIT](LICENSE)
