# Diagrams

Architecture diagrams live in `diagrams/<name>.txt`. `bun run dev` serves an editable canvas at
`http://localhost:5173/?diagram=<name>`. File edits show up live on the canvas, and canvas edits
are written back to the files.

Run `bun run diagrams` first: it prints every diagram's counts, validation errors, marked elements
and open questions. Run it again after editing.

## Model: `diagrams/<name>.txt`

```
# comment
orders: Orders Service          node, kind defaults to service
orders-db: Orders DB [db]       kinds: service, db, queue, ext, ui
orders -> orders-db: SQL        edge, label optional; unknown ids become service nodes
```

Ids use letters, digits, `_` and `-`. One edge per source and target pair; its id is
`source->target`.

Declare nodes in reading order (for workflows, the order of steps). The auto layout follows the
file order, and edges pointing back to an earlier node are drawn as loop-backs.

## Notes and questions: `diagrams/<name>.notes.md`

```
- [ ] @orders Who owns payment retries?    open question
- [x] @orders Who owns payment retries?    resolved question
- @gateway->auth Token cache TTL is 5 min  note
- [ ] Split search into its own service?   no @target: about the whole diagram
```

Open questions track points to discuss later. Add your own questions here instead of asking
them only in chat, and resolve them with `[x]` once decided.

## Marks: `diagrams/<name>.marks`

One node or edge id per line. When the user says "this" or "what I marked", read the marks.
Write marks to point the user at elements. Marks are not committed.

Don't read or edit `diagrams/*.layout.json`; it holds positions from the canvas.
