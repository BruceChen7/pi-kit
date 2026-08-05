import { describe, expect, it } from "vitest";
import {
  checkLavishHtmlCompliance,
  extractPointerRules,
  formatLavishHtmlIssues,
  type LavishHtmlIssue,
  tokenizeElements,
} from "./lavish-html-check.js";

const errorRules = (issues: LavishHtmlIssue[]) =>
  issues
    .filter((issue) => issue.severity === "error")
    .map((issue) => issue.rule);
const warningRules = (issues: LavishHtmlIssue[]) =>
  issues
    .filter((issue) => issue.severity === "warning")
    .map((issue) => issue.rule);

describe("extractPointerRules", () => {
  it("extracts cursor:pointer rules with classes and ids", () => {
    const rules = extractPointerRules(
      ".arrow { cursor: pointer; color: red; } #switcher .arrow:hover { cursor:pointer }",
    );
    expect(rules).toHaveLength(2);
    expect(rules[0].classes).toEqual(["arrow"]);
    expect(rules[0].tag).toBe("");
    // Only the last compound segment counts; #switcher is a scoping ancestor.
    expect(rules[1].selector).toBe("#switcher .arrow:hover");
    expect(rules[1].ids).toEqual([]);
    expect(rules[1].classes).toEqual(["arrow"]);
  });

  it("ignores scoping ancestors in compound selectors", () => {
    const rules = extractPointerRules(
      "#vA .row { cursor: pointer } #vC .col .row:hover { cursor: pointer }",
    );
    expect(rules).toHaveLength(2);
    for (const rule of rules) {
      expect(rule.ids).toEqual([]);
      expect(rule.classes).toEqual(["row"]);
    }
  });

  it("skips native interactive tags", () => {
    const rules = extractPointerRules(
      "button { cursor: pointer } input:hover { cursor: pointer }",
    );
    expect(rules).toHaveLength(0);
  });

  it("skips rules without cursor:pointer", () => {
    expect(extractPointerRules(".a { color: red }")).toHaveLength(0);
  });

  it("handles media query wrappers without choking", () => {
    const rules = extractPointerRules(
      "@media (prefers-reduced-motion: no-preference) { .a { cursor: pointer } }",
    );
    expect(rules.some((rule) => rule.classes.includes("a"))).toBe(true);
  });
});

describe("tokenizeElements", () => {
  it("tracks ancestor data-lavish-action marking", () => {
    const elements = tokenizeElements(
      '<div data-lavish-action><span class="arrow">◀</span></div><span class="row">x</span>',
    );
    expect(elements).toHaveLength(3);
    expect(elements[0].marked).toBe(true);
    expect(elements[1].marked).toBe(true);
    expect(elements[2].marked).toBe(false);
  });

  it("skips script/style/svg content", () => {
    const elements = tokenizeElements(
      `<style>.x { color: red }</style><script>const s = '<div class="x">';</script><div class="x">ok</div>`,
    );
    expect(elements).toHaveLength(1);
    expect(elements[0].classes).toEqual(["x"]);
  });

  it("detects inline cursor:pointer", () => {
    const elements = tokenizeElements('<div style="cursor: pointer">x</div>');
    expect(elements[0].inlinePointer).toBe(true);
  });

  it("handles comments, doctype and void tags", () => {
    const elements = tokenizeElements(
      '<!doctype html><!-- c --><html><body><br><img src="x"><div id="a"></div></body></html>',
    );
    expect(elements.some((el) => el.id === "a")).toBe(true);
  });
});

describe("checkLavishHtmlCompliance", () => {
  it("passes a minimal HTML document", () => {
    const issues = checkLavishHtmlCompliance("<html><body>Plan</body></html>");
    expect(issues).toHaveLength(0);
  });

  it("flags unmarked pointer-cursor custom controls (R1)", () => {
    const html = `
      <style>.arrow { cursor: pointer }</style>
      <div id="switcher"><span class="arrow">◀</span></div>
    `;
    const issues = checkLavishHtmlCompliance(html);
    expect(errorRules(issues)).toContain("interactive-control-unmarked");
  });

  it("passes when an ancestor container is marked", () => {
    const html = `
      <style>.arrow { cursor: pointer }</style>
      <div id="switcher" data-lavish-action><span class="arrow">◀</span></div>
    `;
    const issues = checkLavishHtmlCompliance(html);
    expect(errorRules(issues)).not.toContain("interactive-control-unmarked");
  });

  it("passes native buttons with cursor:pointer", () => {
    const html = `<style>button { cursor: pointer }</style><button>Go</button>`;
    const issues = checkLavishHtmlCompliance(html);
    expect(errorRules(issues)).not.toContain("interactive-control-unmarked");
  });

  it("flags unmarked inline cursor:pointer controls (R1)", () => {
    const html = `<div style="cursor: pointer" onclick="x()">click</div>`;
    const issues = checkLavishHtmlCompliance(html);
    expect(errorRules(issues)).toContain("interactive-control-unmarked");
  });

  it("does not flag classes that only appear in JS strings (dynamic rows)", () => {
    const html = `
      <style>.row { cursor: pointer }</style>
      <script>const div = document.createElement("div"); div.className = "row";</script>
    `;
    const issues = checkLavishHtmlCompliance(html);
    expect(errorRules(issues)).not.toContain("interactive-control-unmarked");
  });

  it("requires arrow-key fallback for prototype switchers (R2 error)", () => {
    const html = `
      <style>.arrow { cursor: pointer }</style>
      <div id="switcher" data-lavish-action><span class="arrow">◀</span></div>
      <script>document.querySelector("#prev").onclick = () => {};</script>
    `;
    const issues = checkLavishHtmlCompliance(html);
    expect(errorRules(issues)).toContain("keyboard-fallback-missing");
  });

  it("passes prototypes with keydown arrow handling", () => {
    const html = `
      <style>.arrow { cursor: pointer }</style>
      <div id="switcher" data-lavish-action><span class="arrow">◀</span></div>
      <script>
        document.addEventListener("keydown", (e) => {
          if (e.key === "ArrowLeft") cycle(-1);
          if (e.key === "ArrowRight") cycle(1);
        });
      </script>
    `;
    const issues = checkLavishHtmlCompliance(html);
    expect(errorRules(issues)).not.toContain("keyboard-fallback-missing");
  });

  it("warns (not errors) about missing arrows for non-prototype controls", () => {
    const html = `
      <style>.tab { cursor: pointer }</style>
      <div data-lavish-action class="tab">Tab</div>
    `;
    const issues = checkLavishHtmlCompliance(html);
    expect(errorRules(issues)).not.toContain("keyboard-fallback-missing");
    expect(warningRules(issues)).toContain("keyboard-fallback-missing");
  });

  it("warns when the prototype header comment lacks review hints (R3)", () => {
    const html = `
      <style>.arrow { cursor: pointer }</style>
      <div id="switcher" data-lavish-action><span class="arrow">◀</span></div>
      <script>
        document.addEventListener("keydown", (e) => {
          if (e.key === "ArrowLeft") cycle(-1);
          if (e.key === "ArrowRight") cycle(1);
        });
      </script>
    `;
    const issues = checkLavishHtmlCompliance(html);
    expect(warningRules(issues)).toContain("review-hint-missing");
  });

  it("passes prototypes whose header mentions the ⌘I toggle", () => {
    const html = `
      <!-- 评审:⌘I 切换批注/浏览模式 -->
      <style>.arrow { cursor: pointer }</style>
      <div id="switcher" data-lavish-action><span class="arrow">◀</span></div>
      <script>
        document.addEventListener("keydown", (e) => {
          if (e.key === "ArrowLeft") cycle(-1);
          if (e.key === "ArrowRight") cycle(1);
        });
      </script>
    `;
    const issues = checkLavishHtmlCompliance(html);
    expect(warningRules(issues)).not.toContain("review-hint-missing");
  });
});

describe("formatLavishHtmlIssues", () => {
  const sample: LavishHtmlIssue[] = [
    {
      rule: "interactive-control-unmarked",
      severity: "error",
      message: "自定义交互控件 .arrow 未标记 data-lavish-action。",
    },
  ];

  it("formats a blocked message with fix guidance", () => {
    const text = formatLavishHtmlIssues(sample, {
      blocked: true,
      planFile: "proto.html",
    });
    expect(text).toContain("[LAVISH HTML 合规检查未通过]");
    expect(text).toContain("proto.html");
    expect(text).toContain("interactive-control-unmarked");
  });

  it("formats a non-blocking warning message", () => {
    const text = formatLavishHtmlIssues(
      [{ ...sample[0], severity: "warning" as const }],
      { blocked: false, planFile: "proto.html" },
    );
    expect(text).toContain("[LAVISH HTML 合规提示(不阻塞提交,建议修复)]");
    expect(text).toContain("interactive-control-unmarked");
  });
});
