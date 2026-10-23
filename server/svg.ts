import type { DiagramFiles } from "../src/diagram/format.ts";
import {
  architectureGrid,
  compareVersions,
  labelHeight,
  labelWidth,
  nodeSize,
  parseDiagram,
  roundedPath,
  scene,
  shortLabel,
  type Box,
  type Change,
  type Position,
} from "../src/diagram/index.ts";
import { autoLayout } from "../src/diagram/layout.ts";
import { parseNotes } from "../src/diagram/notes.ts";
import { kindStyles } from "../src/kinds.ts";

const escape = (text: string) =>
  Array.from(text)
    .filter((char) => {
      const point = char.codePointAt(0)!;
      return (
        point === 9 ||
        point === 10 ||
        point === 13 ||
        (point >= 32 && point <= 0xd7ff) ||
        (point >= 0xe000 && point <= 0xfffd) ||
        point >= 0x10000
      );
    })
    .join("")
    .replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&apos;",
        })[char]!,
    );
const colors: Record<Change, string> = { added: "#40c1ac", changed: "#60a5fa", removed: "#f6459d" };
const number = (value: number) => Number(value.toFixed(2));

function dottedFlow(path: string, color: string) {
  return `<path class="dotted-flow" d="${path}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="1 8"><animate attributeName="stroke-dashoffset" from="0" to="-18" dur="1.2s" repeatCount="indefinite"/></path>`;
}

function sequenceTrail(
  path: string,
  points: Position[],
  color: string,
  index: number,
  steps: number,
) {
  const length = number(
    points.slice(1).reduce((total, [x, y], i) => {
      const [previousX, previousY] = points[i]!;
      return total + Math.hypot(x - previousX, y - previousY);
    }, 0),
  );
  const start = index / steps;
  const end = (index + 1) / steps;
  const timing = [
    { at: 0, offset: 28, visible: start === 0 ? 1 : 0 },
    ...(start > 0 ? [{ at: start, offset: 28, visible: 1 }] : []),
    { at: end, offset: -length, visible: 0 },
    ...(end < 1 ? [{ at: 1, offset: -length, visible: 0 }] : []),
  ];
  const keyTimes = timing.map(({ at }) => Number(at.toFixed(6))).join(";");
  const duration = number(steps * 1.2);
  return `<path class="dotted-flow sequence-trail" d="${path}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-dasharray="1 8 1 8 1 8 1 ${length + 36}" stroke-dashoffset="28" opacity="0"><animate attributeName="stroke-dashoffset" values="${timing.map(({ offset }) => offset).join(";")}" keyTimes="${keyTimes}" dur="${duration}s" calcMode="linear" repeatCount="indefinite"/><animate attributeName="opacity" values="${timing.map(({ visible }) => visible).join(";")}" keyTimes="${keyTimes}" dur="${duration}s" calcMode="discrete" repeatCount="indefinite"/></path>`;
}

// A native SVG image: no scripts, foreignObject, fonts or external assets. Uses the canvas's
// automatic layout and routes, so it can be exported without a browser. Labels get room as in the
// scene (see scene.ts); two versions that don't differ are no comparison.
export function renderSvg(current: DiagramFiles, base?: DiagramFiles) {
  const currentDiagram = parseDiagram(current.source);
  const baseDiagram = base && parseDiagram(base.source);
  const errors = [...currentDiagram.errors, ...(baseDiagram?.errors ?? [])];
  if (errors.length) throw new Error(errors.join("\n"));
  const comparison =
    baseDiagram &&
    compareVersions({ diagram: baseDiagram, layout: {} }, { diagram: currentDiagram, layout: {} });
  const diagram = comparison ? comparison.union : currentDiagram;
  const changes = comparison ? comparison.changes : new Map<string, Change>();
  const gap = Math.max(
    48,
    ...[...diagram.edges.map((edge) => edge.label), ...(comparison?.reserved.values() ?? [])].map(
      (label) => labelWidth(shortLabel(label)) + 32,
    ),
  );
  const laid = scene(
    diagram,
    (extra) =>
      comparison && diagram.layout === "architecture"
        ? architectureGrid(diagram, gap, extra)
        : autoLayout(diagram, extra),
    { reserved: comparison?.reserved },
  );
  const auto = laid.layout;
  if (!diagram.nodes.length && !auto.groups.length)
    throw new Error("Cannot export an empty diagram.");
  const sequence = diagram.layout === "sequence";
  const nodeBoxes = diagram.nodes.map((node) => {
    const [x, y] = auto.positions[node.id]!;
    return { x, y, ...nodeSize };
  });
  const notes = parseNotes(current.notes);
  const title = (id: string, label: string) =>
    `<title>${escape(
      [label, ...notes.filter((note) => note.target === id).map((note) => note.text)].join("\n"),
    )}</title>`;
  const boxes: Box[] = auto.groups.map(({ box }) => box);
  const groups = auto.groups.map(({ id, box }) => {
    const group = diagram.groups.find((candidate) => candidate.id === id)!;
    const change = changes.get(id);
    return `<g>${title(id, group.label)}<defs><clipPath id="group-label-${id}"><rect x="${box.x + 16}" y="${box.y}" width="${box.width - 32}" height="40"/></clipPath></defs><rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="12" fill="#0b1220" stroke="${change ? colors[change] : "#1e293b"}"/><text x="${box.x + 16}" y="${box.y + 26}" class="group-label" clip-path="url(#group-label-${id})">${escape(group.label)}</text></g>`;
  });
  const timelines = diagram.nodes.flatMap((node) => {
    const length = auto.timelines?.[node.id];
    if (!length) return [];
    const [x, y] = auto.positions[node.id]!;
    const bottom = y + nodeSize.height + length;
    boxes.push({ x, y, width: nodeSize.width, height: nodeSize.height + length });
    return [
      `<path d="M${x + nodeSize.width / 2},${y + nodeSize.height} V${bottom}" stroke="#58585f" stroke-dasharray="4 4"/>`,
    ];
  });
  const labels: string[] = [];
  const activeEdges = laid.edges.filter(({ id }) => changes.get(id) !== "removed");
  const edges = laid.edges.map((drawn, index) => {
    const { id, edge, points, label } = drawn;
    const change = changes.get(id);
    if (label) {
      const {
        text,
        at: [x, y],
        routeY,
      } = label;
      const width = number(label.width);
      const box = { x: x - width / 2, y: y - labelHeight / 2, width, height: labelHeight };
      boxes.push(box);
      const loop = sequence && edge.source === edge.target;
      labels.push(
        `<g>${title(id, edge.label)}${routeY === y ? "" : `<path d="M${number(x)},${number(routeY)} V${number(y)}" stroke="#334155"/>`}<rect data-label="${escape(id)}" x="${number(box.x)}" y="${number(box.y)}" width="${width}" height="${labelHeight}" rx="4" fill="${sequence ? "none" : "#020617"}"/><text x="${number(loop ? box.x + 6 : x)}" y="${number(y + 4)}" class="edge-label${loop ? " loop-label" : ""}${change ? ` ${change}` : ""}">${escape(text)}</text></g>`,
      );
    }
    for (const [x, y] of points) boxes.push({ x, y, width: 0, height: 0 });
    const animated =
      (edge.animated === true || diagram.layout === "sequence") && change !== "removed";
    const color = change
      ? colors[change]
      : comparison || sequence
        ? "#64748b"
        : animated
          ? "#529aff"
          : "#64748b";
    const path = roundedPath(points);
    if (sequence) {
      const row = auto.steps?.[id] ?? points[0]![1];
      const gutterX = Math.min(...nodeBoxes.map((box) => box.x)) - 22;
      labels.push(
        `<text data-step="${escape(id)}" x="${gutterX}" y="${row + 4}" class="step-number" fill="${change ? colors[change] : "#64748b"}">${index + 1}</text>`,
      );
      boxes.push({ x: gutterX - 14, y: row - 10, width: 24, height: 20 });
    }
    const flow = animated
      ? diagram.layout === "sequence"
        ? sequenceTrail(
            path,
            points,
            comparison ? color : "#93c5fd",
            activeEdges.indexOf(drawn),
            activeEdges.length,
          )
        : dottedFlow(path, color)
      : "";
    return `<g>${title(id, `${edge.source} → ${edge.target}: ${edge.label}`)}<defs><marker id="arrow-${index}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 Z" fill="${color}"/></marker></defs><path data-edge="${escape(id)}" d="${path}" fill="none" stroke="${color}" stroke-width="1.5" marker-end="url(#arrow-${index})"${animated ? ` class="flow" stroke-opacity="${sequence ? "0.8" : "0.25"}"` : change === "removed" ? ' stroke-dasharray="5 4" opacity="0.6"' : ""}/>${flow}</g>`;
  });
  const nodes = diagram.nodes.map((node) => {
    const [x, y] = auto.positions[node.id]!;
    boxes.push({ x, y, ...nodeSize });
    const kind = kindStyles[node.kind];
    const change = changes.get(node.id);
    const count = sequence ? 0 : notes.filter((note) => note.target === node.id).length;
    const subtitle = [change, kind.tag, count ? `${count} note${count === 1 ? "" : "s"}` : ""]
      .filter(Boolean)
      .join(" · ");
    return `<g>${title(node.id, node.label)}<defs><clipPath id="node-label-${node.id}"><rect x="${x + 42}" y="${y}" width="${nodeSize.width - 52}" height="${nodeSize.height}"/></clipPath></defs><rect data-node="${node.id}" x="${x}" y="${y}" width="${nodeSize.width}" height="${nodeSize.height}" rx="8" fill="#0f172a" stroke="${change ? colors[change] : "#334155"}"${kind.dashed || change === "removed" ? ' stroke-dasharray="5 4"' : ""}/><svg x="${x + 12}" y="${y + 18}" width="20" height="20" viewBox="0 0 24 24"><path d="${kind.icon}" fill="none" stroke="#9d9d9d" stroke-width="1.5"/></svg><g clip-path="url(#node-label-${node.id})"><text x="${x + 42}" y="${y + (subtitle ? 25 : 33)}" class="node-label"${change === "removed" ? ' text-decoration="line-through"' : ""}>${escape(node.label)}</text>${subtitle ? `<text x="${x + 42}" y="${y + 43}" class="subtitle" fill="${change ? colors[change] : "#9d9d9d"}">${escape(subtitle)}</text>` : ""}</g></g>`;
  });
  const comparisons: string[] = [];
  if (comparison) {
    const x = Math.min(...boxes.map((box) => box.x));
    const y = Math.min(...boxes.map((box) => box.y)) - 24;
    const entries = [
      { change: "added", label: "Added", color: colors.added },
      { change: "changed", label: "Changed", color: colors.changed },
      { change: "removed", label: "Removed", color: colors.removed },
      { change: "unchanged", label: "Unchanged", color: "#64748b" },
    ];
    let legendX = x;
    for (const { change, label, color } of entries) {
      comparisons.push(
        `<path d="M${legendX},${y - 4} h20" stroke="${color}" stroke-width="2"${change === "removed" ? ' stroke-dasharray="5 4"' : ""}/><text x="${legendX + 28}" y="${y}" class="legend-label">${label}</text>`,
      );
      legendX += labelWidth(label) + 56;
    }
    boxes.push({ x, y: y - 14, width: legendX - x, height: 20 });
  }
  const left = Math.min(...boxes.map((box) => box.x)) - 32;
  const top = Math.min(...boxes.map((box) => box.y)) - 32;
  const width = number(Math.max(...boxes.map((box) => box.x + box.width)) + 32 - left);
  const height = number(Math.max(...boxes.map((box) => box.y + box.height)) + 32 - top);
  const name = comparison && base ? `${current.name} compared with ${base.name}` : current.name;
  const diagramTitle = [
    name,
    ...notes.filter((note) => note.target === undefined).map((note) => note.text),
  ].join("\n");
  const grid = sequence
    ? '<pattern id="grid" width="64" height="64" patternUnits="userSpaceOnUse"><path d="M64,0 H0 V64" fill="none" stroke="#71839e" stroke-opacity="0.14" stroke-width="0.6"/></pattern>'
    : '<pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="0.7" fill="#1e293b"/></pattern>';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${number(left)} ${number(top)} ${width} ${height}" role="img" aria-labelledby="diagram-title"><title id="diagram-title">${escape(diagramTitle)}</title><desc>Component relationships and ordered operations. Teal indicates additions, blue indicates changes, pink dashed lines indicate removals, and gray indicates unchanged connections. Moving dotted lines trace selected connections.</desc><defs>${grid}</defs><style>text{font-family:system-ui,sans-serif}.node-label{font-size:14px;fill:white}.group-label{font-size:13px;font-weight:600;fill:white}.subtitle{font-size:12px}.edge-label{font-size:11px;text-anchor:middle;fill:#cbd5e1}.edge-label.added{fill:#40c1ac}.edge-label.changed{fill:#93c5fd}.edge-label.removed{fill:#f6459d}.legend-label{font-size:11px;fill:#94a3b8}${diagram.layout === "sequence" ? ".loop-label{text-anchor:start}.step-number{font-size:10px;text-anchor:end}" : ""}@media(prefers-reduced-motion:reduce){.dotted-flow{display:none}.flow{stroke-opacity:1}}</style><rect x="${number(left)}" y="${number(top)}" width="${width}" height="${height}" fill="#020617"/><rect x="${number(left)}" y="${number(top)}" width="${width}" height="${height}" fill="url(#grid)"/>${[...groups, ...timelines, ...edges, ...nodes, ...labels, ...comparisons].join("\n")}</svg>\n`;
}
