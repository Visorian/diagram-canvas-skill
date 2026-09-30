// @unocss-include
import type { Change } from "./diagram/compare";

// Single source for how differences to the compared version look on nodes, groups and in the
// legend; edges take the same colors in style.css and App.vue.
export const changeStyles: Record<
  Change,
  { name: string; description: string; border: string; text: string }
> = {
  added: {
    name: "Added",
    description: "only in this version",
    border:
      "border-[#00a795] [box-shadow:0_0_0_1px_#00a795] dark:border-[#40c1ac] dark:[box-shadow:0_0_0_1px_#40c1ac]",
    text: "text-[#007066] dark:text-[#40c1ac]",
  },
  changed: {
    name: "Changed",
    description: "differs from the other",
    border:
      "border-[#6050d6] [box-shadow:0_0_0_1px_#6050d6] dark:border-[#908cfe] dark:[box-shadow:0_0_0_1px_#908cfe]",
    text: "text-[#6050d6] dark:text-[#908cfe]",
  },
  removed: {
    name: "Removed",
    description: "only in the other version",
    border: "border-dashed border-[#da1984] opacity-60 dark:border-[#f6459d]",
    text: "text-[#b4006b] dark:text-[#f6459d]",
  },
};
