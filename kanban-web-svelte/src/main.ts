import "./app.css";
import { mount } from "svelte";
import App from "./App.svelte";

const appTarget = document.getElementById("app");
if (!appTarget) {
  throw new Error("#app container not found");
}

mount(App, {
  target: appTarget,
});
