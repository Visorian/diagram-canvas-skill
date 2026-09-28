import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDiagramsService } from "./diagrams.ts";
import { waitForHandoffs } from "./handoff.ts";

const addNote = JSON.stringify([
  { type: "add-note", note: { kind: "note", text: "From the canvas", done: false } },
]);

const handoff = (text?: string) => JSON.stringify([{ type: "handoff", text }]);

// Serves `shop` from a fresh folder the way canvas.js does.
async function withCanvas(run: (dir: string, port: number) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "diagram-canvas-skill-server-"));
  const service = createDiagramsService(dir, ["canvas.example.ts.net"]);
  const server = createServer((incoming, response) => {
    void service.api(incoming, response, incoming.url?.slice("/__diagrams".length) ?? "/");
  });
  try {
    await writeFile(join(dir, "shop.txt"), "orders: Orders\n");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(typeof address === "object" && address !== null);
    await run(dir, address.port);
  } finally {
    server.close();
    service.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function send(port: number, headers: Record<string, string>, body?: string) {
  return new Promise<number>((resolve, reject) => {
    const outgoing = request(
      { port, path: "/__diagrams/shop", method: body ? "POST" : "GET", headers },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

test("serves the canvas and allowed hosts, but not other sites or unknown host names", () =>
  withCanvas(async (dir, port) => {
    const local = `127.0.0.1:${port}`;
    assert.equal(await send(port, { host: local, origin: `http://${local}` }, addNote), 200);
    assert.equal(await send(port, { host: `localhost:${port}` }), 200);
    assert.equal(await send(port, { host: "canvas.example.ts.net" }), 200);
    // A proxy that rewrites the host name.
    const proxied = { host: local, origin: "https://canvas.example.ts.net" };
    assert.equal(await send(port, proxied, addNote), 200);

    // Another site posting to the canvas, and a rebound domain reading from it.
    assert.equal(await send(port, { host: local, origin: "https://evil.example" }, addNote), 403);
    assert.equal(await send(port, { host: `rebound.evil.example:${port}` }), 403);

    assert.equal(
      await readFile(join(dir, "shop.notes.md"), "utf8"),
      "- From the canvas\n- From the canvas\n",
    );
  }));

test("hands a diagram over to a waiting agent, also without a message", () =>
  withCanvas(async (dir, port) => {
    const host = { host: `127.0.0.1:${port}` };

    // Sent before anyone waits.
    assert.equal(await send(port, host, handoff("@orders Split this?")), 200);
    assert.deepEqual(await waitForHandoffs(dir), [{ name: "shop", text: "@orders Split this?" }]);

    const waiting = waitForHandoffs(dir);
    assert.equal(await send(port, host, handoff("")), 200);
    assert.deepEqual(await waiting, [{ name: "shop", text: "" }]);
    await assert.rejects(readFile(join(dir, "shop.handoff")));

    // Taken back before the agent looked.
    await send(port, host, handoff("Later"));
    await send(port, host, JSON.stringify([{ type: "handoff" }]));
    await assert.rejects(readFile(join(dir, "shop.handoff")));
  }));
