import { defineConfig, presetWind4 } from "unocss";

export default defineConfig({
  // All theme variables in a fixed order: on demand, their order varies between builds, and the
  // committed skills/diagram-canvas/canvas.js has to be reproducible.
  presets: [presetWind4({ preflights: { theme: { mode: true } } })],
  shortcuts: {
    muted: "text-slate-500 dark:text-slate-400",
    swatch: "size-2.5 shrink-0 rounded-sm border border-slate-500/30",
    heading: "font-semibold text-slate-950 dark:text-white",
    link: "text-indigo-700 hover:underline dark:text-indigo-300",
    code: "rounded bg-slate-200/70 px-1 font-mono text-[0.85em] [overflow-wrap:anywhere] dark:bg-slate-700/70",
    disclosure:
      "muted cursor-pointer font-semibold marker:text-slate-400 dark:marker:text-slate-500",
    segmented:
      "flex overflow-hidden rounded-md border border-slate-300 text-sm dark:border-slate-600",
    "segment-on": "bg-slate-200 font-medium text-slate-900 dark:bg-slate-600 dark:text-slate-50",
    "segment-off": "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700",
    popover:
      "rounded-lg border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-800",
    field:
      "w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm font-normal dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100 dark:placeholder-slate-500",
    "button-primary":
      "rounded-md border border-indigo-600 bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed dark:border-indigo-500 dark:bg-indigo-500 dark:hover:bg-indigo-400",
    button:
      "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700",
  },
});
