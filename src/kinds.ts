// @unocss-include
import type { Kind } from "./diagram/format";

// Single source for how kinds look and read: nodes, legend and the kind picker use it.
export const kindStyles: Record<
  Kind,
  { name: string; tag: string; description: string; className: string }
> = {
  service: {
    name: "Service",
    tag: "",
    description: "Service or step",
    className: "bg-white border-slate-400 dark:bg-slate-800 dark:border-slate-500",
  },
  db: {
    name: "Data",
    tag: "data",
    description: "Database, file or other state",
    className: "bg-emerald-50 border-emerald-600 dark:bg-emerald-950 dark:border-emerald-500",
  },
  queue: {
    name: "Queue",
    tag: "queue",
    description: "Queue, topic or event bus",
    className: "bg-amber-50 border-amber-600 dark:bg-amber-950 dark:border-amber-500",
  },
  ui: {
    name: "Entry point",
    tag: "entry",
    description: "User-facing app or command",
    className: "bg-sky-50 border-sky-600 dark:bg-sky-950 dark:border-sky-500",
  },
  ext: {
    name: "External",
    tag: "external",
    description: "System outside this diagram",
    className:
      "bg-slate-100 border-slate-400 border-dashed dark:bg-slate-900 dark:border-slate-500",
  },
};
