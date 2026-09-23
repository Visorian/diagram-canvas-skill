// Text imports of built HTML (`with { type: "text" }`), bundled by `bun build`.
declare module "*.html" {
  const content: string;
  export default content;
}
