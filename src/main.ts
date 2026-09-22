import { createVaporApp, vaporInteropPlugin } from "vue";
import App from "./App.vue";
import "virtual:uno.css";

createVaporApp(App).use(vaporInteropPlugin).mount("#app");
