import "./app.css";
import App from "./App.svelte";

const appTarget = document.getElementById("app");
if (!appTarget) {
  throw new Error("#app container not found");
}

new App({
  target: appTarget,
});
