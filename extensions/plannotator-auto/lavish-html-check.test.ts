import { describe, expect, it } from "vitest";
import {
  checkLavishHtmlCompliance,
  decideLavishHtmlGate,
  formatLavishHtmlIssues,
  type LavishHtmlIssue,
} from "./lavish-html-check.js";

const errorRules = (issues: LavishHtmlIssue[]) =>
  issues
    .filter((issue) => issue.severity === "error")
    .map((issue) => issue.rule);
const warningRules = (issues: LavishHtmlIssue[]) =>
  issues
    .filter((issue) => issue.severity === "warning")
    .map((issue) => issue.rule);

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

  it("handles media query wrappers without missing rules", () => {
    const html = `
      <style>@media (prefers-reduced-motion: no-preference) { .a { cursor: pointer } }</style>
      <div class="a">x</div>
    `;
    const issues = checkLavishHtmlCompliance(html);
    expect(errorRules(issues)).toContain("interactive-control-unmarked");
  });

  it("ignores scoping ancestors in compound selectors (false-positive guard)", () => {
    const html = `
      <style>#vA .row { cursor: pointer }</style>
      <script>
        document.addEventListener("keydown", (e) => {
          if (e.key === "ArrowLeft") cycle(-1);
          if (e.key === "ArrowRight") cycle(1);
        });
      </script>
      <div id="vA">plain text</div>
      <div class="row" data-lavish-action>row</div>
    `;
    const issues = checkLavishHtmlCompliance(html);
    expect(issues).toHaveLength(0);
  });

  it("tolerates doctype, comments and void tags while scanning", () => {
    const html = `
      <!doctype html><!-- c --><html><body>
      <br><img src="x"><hr>
      <style>.arrow { cursor: pointer }</style>
      <div class="arrow">◀</div>
      </body></html>
    `;
    const issues = checkLavishHtmlCompliance(html);
    expect(errorRules(issues)).toContain("interactive-control-unmarked");
  });

  it("does not flag elements whose CSS lacks cursor:pointer", () => {
    const html = `<style>.a { color: red }</style><div class="a">text</div>`;
    expect(checkLavishHtmlCompliance(html)).toHaveLength(0);
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

describe("decideLavishHtmlGate", () => {
  const error: LavishHtmlIssue = {
    rule: "interactive-control-unmarked",
    severity: "error",
    message: "e",
  };
  const warning: LavishHtmlIssue = {
    rule: "keyboard-fallback-missing",
    severity: "warning",
    message: "w",
  };

  it("passes when there are no issues", () => {
    expect(decideLavishHtmlGate([])).toEqual({ kind: "pass" });
  });

  it("blocks when any issue is an error, carrying the full issue list", () => {
    expect(decideLavishHtmlGate([warning, error])).toEqual({
      kind: "block",
      issues: [warning, error],
    });
  });

  it("warns when only warnings are present", () => {
    expect(decideLavishHtmlGate([warning])).toEqual({
      kind: "warn",
      issues: [warning],
    });
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

  it("blocked message also lists warnings as suggested fixes", () => {
    const text = formatLavishHtmlIssues(
      [
        sample[0],
        {
          ...sample[0],
          rule: "keyboard-fallback-missing" as const,
          severity: "warning" as const,
        },
      ],
      { blocked: true, planFile: "proto.html" },
    );
    expect(text).toContain("建议同时修复");
    expect(text).toContain("keyboard-fallback-missing");
  });
});
