import assert from "node:assert/strict";
import { test } from "node:test";
import { compare } from "./compare.ts";
import { edgeId, parseDiagram } from "./format.ts";
import { autoLayout } from "./layout.ts";

const older =
  "[api: API]\ngateway: Gateway\nauth: Auth\ncache: Cache\ngateway -> auth: token\ngateway -> cache\n";
const newer =
  "[api: API]\ngateway: Gateway\nauth: Auth service\nbilling: Billing\ngateway -> auth: jwt\ngateway -> billing\n";

const versions = (before: string, after: string) =>
  compare(
    { diagram: parseDiagram(before), layout: { cache: [5, 5] } },
    { diagram: parseDiagram(after), layout: { gateway: [0, 0] } },
  );

test("marks what was added, removed and changed", () => {
  const { changes } = versions(older, newer);
  assert.deepEqual(Object.fromEntries(changes), {
    auth: "changed",
    billing: "added",
    cache: "removed",
    "gateway->auth": "changed",
    "gateway->billing": "added",
    "gateway->cache": "removed",
  });
});

test("holds both versions, with removed elements where they used to be", () => {
  const { union, layout } = versions(older, newer);
  assert.deepEqual(
    union.nodes.map(({ id, label, group }) => [id, label, group]),
    [
      ["gateway", "Gateway", "api"],
      ["auth", "Auth service", "api"],
      ["cache", "Cache", "api"],
      ["billing", "Billing", "api"],
    ],
  );
  assert.deepEqual(union.edges.map(edgeId), [
    "gateway->auth",
    "gateway->cache",
    "gateway->billing",
  ]);
  assert.deepEqual(layout, { cache: [5, 5], gateway: [0, 0] }, "removed nodes keep their pins");
});

test("both versions share one layout, so switching moves nothing", () => {
  const { union } = versions(older, newer);
  const { positions } = autoLayout(union);
  for (const node of [...parseDiagram(older).nodes, ...parseDiagram(newer).nodes])
    assert.ok(positions[node.id], `${node.id} has a place in both versions`);
});
