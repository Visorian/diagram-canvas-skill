import { defineConfig, presetWind4 } from "unocss";

export default defineConfig({
  presets: [presetWind4()],
  shortcuts: {
    muted: "text-slate-500 dark:text-slate-400",
    link: "text-indigo-700 hover:underline dark:text-indigo-300",
    code: "rounded bg-slate-200/70 px-1 font-mono text-[0.85em] dark:bg-slate-700/70",
    popover:
      "rounded-lg border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-800",
    field:
      "w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm font-normal dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 dark:placeholder-slate-500",
    button:
      "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700",
  },
});
