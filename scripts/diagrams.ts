import { runStatus } from "../server/status.ts";

const { text, failed } = await runStatus("diagrams");
console.log(text);
process.exitCode = failed ? 1 : 0;
