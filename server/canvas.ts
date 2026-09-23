// Single-file canvas: `canvas.js [dir] [--port 7766] [--host 127.0.0.1]` or `canvas.js status [dir]`.
import { createServer } from "node:http";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import html from "../dist/app/index.html" with { type: "text" };
import { createDiagramsService } from "./diagrams.ts";
import { diagramStatus } from "./status.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    // Off the usual Vite ports, so it runs next to a project's own dev server.
    port: { type: "string", default: "7766" },
    host: { type: "string", default: "127.0.0.1" },
  },
});
const [command, dirArgument] =
  positionals[0] === "status" ? positionals : ["serve", positionals[0]];
const dir = resolve(dirArgument ?? "diagrams");

if (command === "status") {
  const { text, failed } = await diagramStatus(dir);
  console.log(text);
  process.exitCode = failed ? 1 : 0;
} else {
  const service = createDiagramsService(dir);
  createServer((request, response) => {
    const url = request.url ?? "/";
    if (url.startsWith("/__events")) return service.events(request, response);
    if (url.startsWith("/__diagrams")) {
      return void service.api(request, response, url.slice("/__diagrams".length)).catch(() => {
        response.statusCode = 500;
        response.end();
      });
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(html);
  }).listen(Number(values.port), values.host, () => {
    console.log(`Diagram canvas on http://${values.host}:${values.port}/ for ${service.root}`);
  });
}
