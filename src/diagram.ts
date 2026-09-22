import type { Edge, Node } from "@vue-flow/core";

// Write diagrams here.
export const nodes: Node[] = [
  { id: "request", type: "input", position: { x: 0, y: 0 }, data: { label: "Request" } },
  { id: "auth", position: { x: 0, y: 100 }, data: { label: "Auth" } },
  { id: "cache", position: { x: -150, y: 200 }, data: { label: "Cache" } },
  { id: "handler", position: { x: 150, y: 200 }, data: { label: "Handler" } },
  { id: "db", position: { x: 150, y: 300 }, data: { label: "Database" } },
  { id: "response", type: "output", position: { x: 0, y: 400 }, data: { label: "Response" } },
];

export const edges: Edge[] = [
  { id: "request-auth", source: "request", target: "auth" },
  { id: "auth-cache", source: "auth", target: "cache" },
  { id: "auth-handler", source: "auth", target: "handler" },
  { id: "handler-db", source: "handler", target: "db", animated: true },
  { id: "cache-response", source: "cache", target: "response" },
  { id: "db-response", source: "db", target: "response" },
];
