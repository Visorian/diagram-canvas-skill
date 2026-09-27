---
name: diagram-canvas
description: Draw and iterate on architecture or workflow diagrams together with the user on a shared, editable canvas backed by plain text files. Use when the user asks to visualize, diagram or map a system, a service landscape or a workflow, wants to discuss or plan something on a diagram, or refers to what they marked, noted or asked on the canvas.
---

# Diagram canvas

Diagrams are plain text files in the project's `diagrams/` folder. The user works on a canvas in the browser, you work on the files, and both sides see each other's changes live. `canvas.js` in this skill's directory runs the canvas and prints a status; it needs Node 20+ or Bun.

## Files per diagram `<name>`

- `<name>.txt`: the model. You write it; the user can edit it on the canvas too.
- `<name>.notes.md`: notes and open questions, written by both sides.
- `<name>.marks`: one node or edge id per line, pointing at what someone wants the other to look at. Short-lived; not worth committing.
- `<name>.layout.json`: positions the user dragged. Never read or edit it.

## Model format

```
# comment
# tag: risk #d97706
orders: Orders Service          node, kind defaults to service
orders-db: Orders DB [db]       kinds: service, db, queue, ext, ui
orders -> orders-db: SQL        edge, label optional; unknown ids become service nodes
```

- Kinds: `service` for a service or step, `db` for data or state, `queue` for queues, topics and event buses, `ui` for entry points like apps or CLI commands, `ext` for systems outside the diagram.
- Ids use letters, digits, `_` and `-`. An edge's id is `source->target`, so there is one edge per pair.
- Define question tags once in the model as `# tag: name #rrggbb`, named like ids, with any hex color.
- Declare nodes in reading order, for workflows the order of the steps. The auto layout follows the edges and keeps the file order within a row. In a cycle, the edges back to earlier nodes are drawn as loop-backs.
- Keep labels to about 20 characters. Put details, commands and `file:line` references in notes.

## Notes format

```
- [ ] @orders Who owns payment retries?    open question
- [x] @orders Who owns payment retries?    resolved question
- [ ] #risk @orders Can payment retry?     question tagged with risk
- @gateway->auth Token cache TTL is 5 min  note
- [ ] Split search into its own service?   no @target: about the whole diagram
```

One entry per line, without line breaks inside. Other lines are kept as written. Record open points as questions instead of only mentioning them in chat, and resolve them with `[x]` once they are decided. Only questions take a tag, written as `#name` right after the checkbox and using a tag defined in the model.

## Workflow

1. Start with `node <this skill's directory>/canvas.js status diagrams`. It prints counts, validation errors, marks and open questions per diagram. Run it again after editing; it exits non-zero on invalid lines.
2. When the user wants to see or edit a diagram, start the canvas in the background: `node <this skill's directory>/canvas.js diagrams --port 7766` (listens on 127.0.0.1; pick another port if 7766 is taken). Give the user `http://127.0.0.1:7766/?diagram=<name>`. If their browser runs on another machine, expose the port with the tailscale-dev skill. Reuse a canvas that is already running and stop the ones you started when you are done.
3. When the user refers to "this", "what I marked" or pastes a prompt copied from the canvas, run the status and read the marks and questions it lists.
4. To point the user at elements, write their ids to `<name>.marks`.
5. The canvas saves the user's edits to the same files. Re-read a file before changing it so you don't overwrite their edits.
