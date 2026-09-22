import { readFile, readdir } from "node:fs/promises";
import { parseDiagram } from "../src/diagram/format";

const files = (await readdir("diagrams")).filter((file) => file.endsWith(".txt"));
const results = await Promise.all(
  files.map(async (file) => ({
    file,
    diagram: parseDiagram(await readFile(`diagrams/${file}`, "utf8")),
  })),
);
for (const {
  file,
  diagram: { nodes, edges, errors },
} of results) {
  console.log(`${file}: ${nodes.length} nodes, ${edges.length} edges`);
  for (const error of errors) console.log(`  ${error}`);
}
process.exitCode = results.some(({ diagram }) => diagram.errors.length > 0) ? 1 : 0;
