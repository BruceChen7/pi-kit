import { mount } from "svelte";
import App from "./App.svelte";
import "./styles.css";

function fail(message: string) {
  const el = document.createElement("pre");
  el.style.cssText =
    "position:fixed;inset:0;z-index:999999;background:#0f1117;color:#f87171;" +
    "padding:24px;font:12px/1.6 ui-monospace,monospace;white-space:pre-wrap;overflow:auto;";
  el.textContent = message;
  document.body.appendChild(el);
}

window.addEventListener("error", (e) => {
  fail(`runtime error: ${e.message}\n${e.filename ?? ""}:${e.lineno ?? ""}`);
});
window.addEventListener("unhandledrejection", (e) => {
  fail(`unhandled rejection: ${String(e.reason)}`);
});

function boot() {
  const target = document.getElementById("app");
  if (!target) {
    fail("mount target #app not found");
    return;
  }
  try {
    mount(App, { target });
  } catch (err) {
    fail(
      `mount failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
