import { createApp, createVaporApp, vaporInteropPlugin } from "vue";
import App from "./App.vue";
import "virtual:uno.css";

if (import.meta.env.MODE === "vdom") {
  createApp(App).mount("#app");
} else {
  createVaporApp(App).use(vaporInteropPlugin).mount("#app");
}
