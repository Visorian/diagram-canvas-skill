import { ref, watchEffect } from "vue";

// Starts dark until the user picks a theme.
export function useTheme() {
  const stored = localStorage.getItem("theme");
  const dark = ref(stored !== "light");
  watchEffect(() => {
    document.documentElement.classList.toggle("dark", dark.value);
    document.documentElement.style.colorScheme = dark.value ? "dark" : "light";
  });
  function toggle() {
    dark.value = !dark.value;
    localStorage.setItem("theme", dark.value ? "dark" : "light");
  }
  return { dark, toggle };
}
