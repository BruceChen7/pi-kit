import { describe, expect, it } from "vitest";
import {
  checkPlannotatorHtmlCompliance,
  decidePlannotatorHtmlGate,
  formatPlannotatorHtmlIssues,
} from "./plannotator-html-check.ts";

const PROTOTYPE_HTML = (script: string): string =>
  `<!doctype html><html><head><title>proto</title></head><body>` +
  `<div id="switcher"><span class="arrow">◀</span></div>` +
  `<script>${script}</script></body></html>`;

describe("checkPlannotatorHtmlCompliance", () => {
  it("passes a plain self-contained artifact", () => {
    const issues = checkPlannotatorHtmlCompliance(
      "<html><body><h1>Plan</h1></body></html>",
    );
    expect(issues).toEqual([]);
  });

  it("errors on prototype scripts using localStorage", () => {
    const issues = checkPlannotatorHtmlCompliance(
      PROTOTYPE_HTML('localStorage.setItem("v", "B");'),
    );
    const r1 = issues.find((i) => i.rule === "sandbox-storage-unsafe");
    expect(r1?.severity).toBe("error");
    expect(r1?.message).toContain("localStorage");
  });

  it("errors on prototype scripts using sessionStorage", () => {
    const issues = checkPlannotatorHtmlCompliance(
      PROTOTYPE_HTML("sessionStorage.getItem('v');"),
    );
    expect(issues.some((i) => i.rule === "sandbox-storage-unsafe")).toBe(true);
  });

  it("errors on prototype scripts using history.replaceState", () => {
    const issues = checkPlannotatorHtmlCompliance(
      PROTOTYPE_HTML('history.replaceState({}, "", "?v=B");'),
    );
    const r1 = issues.find((i) => i.rule === "sandbox-storage-unsafe");
    expect(r1?.severity).toBe("error");
    expect(r1?.message).toContain("history.replaceState");
  });

  it("errors on prototype scripts reading location.search", () => {
    const issues = checkPlannotatorHtmlCompliance(
      PROTOTYPE_HTML("const v = location.search;"),
    );
    const r1 = issues.find((i) => i.rule === "sandbox-storage-unsafe");
    expect(r1?.severity).toBe("error");
    expect(r1?.message).toContain("location.search");
  });

  it("downgrades storage API usage to a warning for non-prototype artifacts", () => {
    const issues = checkPlannotatorHtmlCompliance(
      `<html><body><script>localStorage.setItem("k", "v");</script></body></html>`,
    );
    const r1 = issues.find((i) => i.rule === "sandbox-storage-unsafe");
    expect(r1?.severity).toBe("warning");
  });

  it("does not flag unrelated script APIs", () => {
    const issues = checkPlannotatorHtmlCompliance(
      PROTOTYPE_HTML('document.getElementById("switcher").onclick = f;'),
    );
    expect(issues.some((i) => i.rule === "sandbox-storage-unsafe")).toBe(false);
  });

  it("warns when custom interactive controls lack a keyboard fallback", () => {
    const issues = checkPlannotatorHtmlCompliance(
      `<style>.arrow { cursor: pointer }</style>` +
        `<div id="switcher"><span class="arrow">◀</span></div>` +
        `<script>document.getElementById("switcher").onclick = cycle;</script>`,
    );
    const r2 = issues.find((i) => i.rule === "keyboard-fallback-missing");
    expect(r2?.severity).toBe("warning");
    expect(r2?.message).toContain("ArrowLeft/ArrowRight");
  });

  it("does not warn when ArrowLeft/ArrowRight keydown handling exists", () => {
    const issues = checkPlannotatorHtmlCompliance(
      `<style>.arrow { cursor: pointer }</style>` +
        `<div id="switcher"><span class="arrow">◀</span></div>` +
        `<script>` +
        `document.addEventListener("keydown", (e) => {` +
        `  if (e.key === "ArrowLeft") cycle(-1);` +
        `  if (e.key === "ArrowRight") cycle(1);` +
        `});` +
        `</script>`,
    );
    expect(issues.some((i) => i.rule === "keyboard-fallback-missing")).toBe(
      false,
    );
  });

  it("does not treat native interactive controls as custom controls", () => {
    const issues = checkPlannotatorHtmlCompliance(
      `<style>button { cursor: pointer }</style>` +
        `<button onclick="cycle()">Next</button>` +
        `<script>function cycle() {}</script>`,
    );
    expect(issues.some((i) => i.rule === "keyboard-fallback-missing")).toBe(
      false,
    );
  });

  it("warns when a prototype header omits the review hint", () => {
    const issues = checkPlannotatorHtmlCompliance(
      PROTOTYPE_HTML("function cycle() {}"),
    );
    const r3 = issues.find((i) => i.rule === "review-hint-missing");
    expect(r3?.severity).toBe("warning");
    expect(r3?.message).toContain("拖选");
  });

  it("does not warn when the prototype header carries a review hint", () => {
    const issues = checkPlannotatorHtmlCompliance(
      `<!-- 评审操作:拖选文字即批注;pinpoint 模式点元素批注 -->` +
        PROTOTYPE_HTML("function cycle() {}"),
    );
    expect(issues.some((i) => i.rule === "review-hint-missing")).toBe(false);
  });

  it("skips the review-hint rule for non-prototype artifacts", () => {
    const issues = checkPlannotatorHtmlCompliance(
      "<html><body><p>No variants here</p></body></html>",
    );
    expect(issues.some((i) => i.rule === "review-hint-missing")).toBe(false);
  });

  it("errors when all scripts are empty inline blocks (v3 blank-shell)", () => {
    const issues = checkPlannotatorHtmlCompliance(
      `<html><head></head><body><div id="app"></div>` +
        `<script></script></body></html>`,
    );
    const r4 = issues.find((i) => i.rule === "script-absent-or-empty");
    expect(r4?.severity).toBe("error");
    expect(r4?.message).toContain("黑屏");
  });

  it("warns when an empty inline block coexists with a valid script", () => {
    const issues = checkPlannotatorHtmlCompliance(
      `<html><body><script></script>` +
        `<script src="https://cdn.example.com/app.js"></script></body></html>`,
    );
    const r4 = issues.find((i) => i.rule === "script-absent-or-empty");
    expect(r4?.severity).toBe("warning");
  });

  it("errors when interactive controls exist but no script at all", () => {
    const issues = checkPlannotatorHtmlCompliance(
      `<style>.arrow { cursor: pointer }</style>` +
        `<div id="switcher"><span class="arrow">◀</span></div>`,
    );
    const r4 = issues.find((i) => i.rule === "script-absent-or-empty");
    expect(r4?.severity).toBe("error");
    expect(r4?.message).toContain("交互控件");
  });

  it("passes a normal bundle with non-empty script content", () => {
    const issues = checkPlannotatorHtmlCompliance(
      `<html><body><div id="app"></div>` +
        `<script>const app = mount(App, { target: document.getElementById("app") });</script>` +
        `</body></html>`,
    );
    expect(issues.some((i) => i.rule === "script-absent-or-empty")).toBe(false);
  });

  it("errors when a head script touches the DOM without DOMContentLoaded", () => {
    const issues = checkPlannotatorHtmlCompliance(
      `<html><head><script>` +
        `document.getElementById("app").innerHTML = "x";` +
        `</script></head><body><div id="app"></div></body></html>`,
    );
    const r5 = issues.find((i) => i.rule === "script-before-dom-ready");
    expect(r5?.severity).toBe("error");
    expect(r5?.message).toContain("DOMContentLoaded");
  });

  it("exempts a head script wrapped in DOMContentLoaded", () => {
    const issues = checkPlannotatorHtmlCompliance(
      `<html><head><script>` +
        `document.addEventListener("DOMContentLoaded", () => {` +
        `  mount(App, { target: document.getElementById("app") });` +
        `});` +
        `</script></head><body><div id="app"></div></body></html>`,
    );
    expect(issues.some((i) => i.rule === "script-before-dom-ready")).toBe(
      false,
    );
  });

  it("exempts a body-end script after #app", () => {
    const issues = checkPlannotatorHtmlCompliance(
      `<html><body><div id="app"></div>` +
        `<script>mount(App, { target: document.getElementById("app") });</script>` +
        `</body></html>`,
    );
    expect(issues.some((i) => i.rule === "script-before-dom-ready")).toBe(
      false,
    );
  });

  it("warns when an app-like script has no error-visibility fallback", () => {
    const issues = checkPlannotatorHtmlCompliance(
      `<html><body><div id="app"></div>` +
        `<script>mount(App, { target: document.getElementById("app") });</script>` +
        `</body></html>`,
    );
    const r6 = issues.find((i) => i.rule === "error-visibility-missing");
    expect(r6?.severity).toBe("warning");
    expect(r6?.message).toContain("window.onerror");
  });

  it("does not warn when the script installs window.onerror", () => {
    const issues = checkPlannotatorHtmlCompliance(
      `<html><body><div id="app"></div>` +
        `<script>` +
        `window.onerror = (msg) => { document.body.innerHTML = String(msg); };` +
        `mount(App, { target: document.getElementById("app") });` +
        `</script></body></html>`,
    );
    expect(issues.some((i) => i.rule === "error-visibility-missing")).toBe(
      false,
    );
  });
});

describe("decidePlannotatorHtmlGate", () => {
  it("blocks when any error-level issue is present", () => {
    const decision = decidePlannotatorHtmlGate([
      { rule: "sandbox-storage-unsafe", severity: "error", message: "x" },
    ]);
    expect(decision.kind).toBe("block");
  });

  it("warns (does not block) when only warnings are present", () => {
    const decision = decidePlannotatorHtmlGate([
      { rule: "review-hint-missing", severity: "warning", message: "x" },
    ]);
    expect(decision.kind).toBe("warn");
  });

  it("passes with no issues", () => {
    expect(decidePlannotatorHtmlGate([]).kind).toBe("pass");
  });
});

describe("formatPlannotatorHtmlIssues", () => {
  it("renders actionable blocked guidance without skill-doc line references", () => {
    const text = formatPlannotatorHtmlIssues(
      [
        {
          rule: "sandbox-storage-unsafe",
          severity: "error",
          message: "修复指引",
        },
      ],
      { blocked: true, planFile: ".pi/html/repo/proto.html" },
    );
    expect(text).toContain("[PLANNOTATOR HTML 合规检查未通过]");
    expect(text).toContain(".pi/html/repo/proto.html");
    expect(text).toContain("修复指引");
  });

  it("renders warning-only guidance as non-blocking", () => {
    const text = formatPlannotatorHtmlIssues(
      [{ rule: "review-hint-missing", severity: "warning", message: "提示" }],
      { blocked: false, planFile: ".pi/html/repo/proto.html" },
    );
    expect(text).toContain("[PLANNOTATOR HTML 合规提示(不阻塞提交,建议修复)]");
    expect(text).toContain("提示");
  });
});
