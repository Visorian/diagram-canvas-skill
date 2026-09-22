import { defineConfig, presetWind4 } from "unocss";

export default defineConfig({
  presets: [presetWind4()],
  shortcuts: {
    field: "w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm font-normal",
    button:
      "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed",
  },
});
