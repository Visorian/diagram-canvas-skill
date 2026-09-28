// Single-file canvas: `canvas.js [dir] [--port 7766] [--host 127.0.0.1] [--allow-host name]`,
// `canvas.js status [dir]` or `canvas.js wait [dir]`.
import { createServer } from "node:http";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { brotliDecompressSync } from "node:zlib";
import { createDiagramsService } from "./diagrams.ts";
import { compressedHtml } from "./html.ts" with { type: "macro" };
import { waitForHandoffs } from "./handoff.ts";
import { runStatus } from "./status.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    // Off the usual Vite ports, so it runs next to a project's own dev server.
    port: { type: "string", default: "7766" },
    host: { type: "string", default: "127.0.0.1" },
    // Host names the canvas is reached by besides localhost and IP addresses, e.g. behind a proxy.
    "allow-host": { type: "string", multiple: true, default: [] },
  },
});
const [command, dirArgument] =
  positionals[0] === "status" || positionals[0] === "wait"
    ? positionals
    : ["serve", positionals[0]];
const dir = resolve(dirArgument ?? "diagrams");

if (command === "status" || command === "wait") {
  // `wait` blocks until the user hands a diagram over on the canvas.
  const handoffs = command === "wait" ? await waitForHandoffs(dir) : [];
  const { text, failed } = await runStatus(dir);
  for (const { name, text: message } of handoffs) {
    console.log(`${name}: handed over by the user${message ? `: ${message}` : ""}`);
  }
  console.log(text);
  // Only `status` fails on invalid lines; for `wait` the output already lists them.
  process.exitCode = command === "status" && failed ? 1 : 0;
} else {
  const service = createDiagramsService(dir, values["allow-host"]);
  const html = brotliDecompressSync(Buffer.from(compressedHtml(), "base64"));
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
