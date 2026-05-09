import { mount } from "svelte";

import "./style.css";
import App from "./App.svelte";

const target = document.getElementById("app");

if (!target) {
  throw new Error("missing #app mount target");
}

mount(App, { target });
