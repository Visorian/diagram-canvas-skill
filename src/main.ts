import { createApp, createVaporApp, vaporInteropPlugin } from "vue";
import App from "./App.vue";
import "virtual:uno.css";
import "./style.css";

if (import.meta.env.MODE === "vapor") {
  createVaporApp(App).use(vaporInteropPlugin).mount("#app");
} else {
  createApp(App).mount("#app");
}
