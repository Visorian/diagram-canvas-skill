import { diagramStatus } from "../server/status.ts";

const { text, failed } = await diagramStatus("diagrams");
console.log(text);
process.exitCode = failed ? 1 : 0;
