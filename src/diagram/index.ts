// The diagram library without Vue, a DOM or Node: the text format, the grid layouts, comparisons and
// the scene geometry for read-only views. Copy this folder into another app (see docs/library.md);
// `autoLayout` in layout.ts also lays out flows without groups, which needs @dagrejs/dagre.
export { compare, type Change, type Comparison } from "./compare";
export { labelWidth } from "./connections";
export {
  edgeId,
  kinds,
  parseDiagram,
  type Diagram,
  type DiagramEdge,
  type DiagramGroup,
  type DiagramNode,
  type Kind,
  type Layout,
  type Position,
} from "./format";
export {
  architectureGrid,
  flowGrid,
  groupHeader,
  nodeSize,
  sequenceGrid,
  type AutoLayout,
  type Box,
  type Connection,
  type Extra,
} from "./grid";
export {
  compareVersions,
  labelHeight,
  labelLimit,
  legendMarks,
  roundedPath,
  scene,
  shortLabel,
  type EdgeLabel,
  type LegendMark,
  type Scene,
  type SceneEdge,
  type SceneOptions,
  type VersionComparison,
} from "./scene";
