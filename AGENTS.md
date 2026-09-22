# Diagrams

Architecture diagrams live in `diagrams/<name>.txt`. `bun run dev` serves an editable canvas at
`http://localhost:5173/?diagram=<name>`. Edits to the file show up live, and canvas edits are
written back to the same file.

Format, one statement per line:

```
# comment
orders: Orders Service          node, kind defaults to service
orders-db: Orders DB [db]       kinds: service, db, queue, ext, ui
orders -> orders-db: SQL        edge, label optional; unknown ids become service nodes
```

- Ids use letters, digits, `_` and `-`. One edge per source and target pair.
- Don't read or edit `diagrams/*.layout.json`; it holds positions from the canvas.
- Run `bun run diagrams:check` after editing to validate and get node and edge counts.
