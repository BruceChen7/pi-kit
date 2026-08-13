import { describe, expect, it } from "vitest";
import { expectDefined } from "../shared/test-kit.js";
import {
  formatArtifactPolicyFailure,
  validateArtifactPolicy,
} from "./artifact-policy.js";

const planPath = ".pi/plans/pi-kit/plan/2026-07-24-demo.md";
const specPath = ".pi/plans/pi-kit/specs/2026-07-24-demo-design.md";

const validPlan = [
  "## Goal",
  "- 用户希望实现 UX-Flow-Tree 风格的 Plan 模板。",
  "",
  "## Current Flow",
  "```mermaid",
  "sequenceDiagram",
  "  A->>B: current step",
  "```",
  "",
  "## Desired Flow",
  "```mermaid",
  "sequenceDiagram",
  "  A->>B: new step  ← 新增",
  "```",
  "",
  "## Boundaries",
  "```mermaid",
  "sequenceDiagram",
  "  L1->>L2: call  ← ownership",
  "```",
  "",
  "## Implementation",
  "parentFn()",
  "  ├─ childA()  ← 条件分支",
  "  └─ childB()  ← 副作用",
  "",
  "## Testing",
  "- 核心 value in / value out 测试场景。",
  "",
  "## Decisions",
  "- 推荐方案和被拒原因。",
  "",
  "## Non-goals",
  "- 不处理存量格式迁移。",
].join("\n");

const structuralOnlyConfig = { requireReviewDetails: false };

describe("plan artifact policy", () => {
  it("approves a standard plan with all 8 required sections", () => {
    const result = validateArtifactPolicy({
      path: planPath,
      content: validPlan,
    });

    expect(result.approved).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("approves a plan using Out of scope alias for Non-goals", () => {
    const result = validateArtifactPolicy({
      path: planPath,
      content: validPlan.replace("## Non-goals", "## Out of scope"),
    });

    expect(result.approved).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("rejects a plan missing a required top-level section", () => {
    const content = [
      "## Goal",
      "- Product goal.",
      "",
      "## Current Flow",
      "- Current flow.",
      "",
      "## Boundaries",
      "- Boundaries.",
      "",
      "## Implementation",
      "- Implementation.",
      "",
      "## Testing",
      "- Testing.",
      "",
      "## Decisions",
      "- Decisions.",
      "",
      "## Non-goals",
      "- Non-goals.",
    ].join("\n");

    const result = validateArtifactPolicy({
      path: planPath,
      content,
    });

    expect(result.approved).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "missing_section",
        section: "Desired Flow",
      }),
    );
  });

  it("rejects a plan with wrong section order", () => {
    const content = [
      "## Goal",
      "- Product goal.",
      "",
      "## Boundaries",
      "- Boundaries before flow.",
      "",
      "## Current Flow",
      "- Current flow after boundaries.",
      "",
      "## Desired Flow",
      "- Desired flow.",
      "",
      "## Implementation",
      "- Implementation.",
      "",
      "## Testing",
      "- Testing.",
      "",
      "## Decisions",
      "- Decisions.",
      "",
      "## Non-goals",
      "- Non-goals.",
    ].join("\n");

    const result = validateArtifactPolicy({
      path: planPath,
      content,
    });

    expect(result.approved).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "section_order",
      }),
    );
  });

  it("rejects a plan with an empty required section", () => {
    const content = [
      "## Goal",
      "- Product goal.",
      "",
      "## Current Flow",
      "",
      "## Desired Flow",
      "- Desired flow.",
      "",
      "## Boundaries",
      "- Boundaries.",
      "",
      "## Implementation",
      "- Implementation.",
      "",
      "## Testing",
      "- Testing.",
      "",
      "## Decisions",
      "- Decisions.",
      "",
      "## Non-goals",
      "- Non-goals.",
    ].join("\n");

    const result = validateArtifactPolicy({
      path: planPath,
      content,
    });

    expect(result.approved).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "empty_section",
        section: "Current Flow",
      }),
    );
  });

  it("includes a copyable suggestion for missing section", () => {
    const content = [
      "## Goal",
      "- Product goal.",
      "",
      "## Current Flow",
      "- Current flow.",
      "",
      "## Desired Flow",
      "- Desired flow.",
      "",
      "## Implementation",
      "- Implementation.",
      "",
      "## Testing",
      "- Testing.",
      "",
      "## Decisions",
      "- Decisions.",
      "",
      "## Non-goals",
      "- Non-goals.",
    ].join("\n");

    const result = validateArtifactPolicy({
      path: planPath,
      content,
    });

    expect(formatArtifactPolicyFailure(planPath, result.issues)).toContain(
      "## Boundaries",
    );
  });

  it("does not apply standard markdown plan policy to HTML plan artifacts", () => {
    const result = validateArtifactPolicy({
      path: ".pi/plans/pi-kit/plan/2026-07-24-demo.html",
      content: "<html><body><h1>Plan</h1></body></html>",
    });

    expect(result.applied).toBe(false);
    expect(result.approved).toBe(true);
  });

  it("does not apply standard plan policy to spec artifacts", () => {
    const result = validateArtifactPolicy({
      path: specPath,
      content: "# PRD\n\n## Problem Statement\n\nNeed to write PRD.\n",
    });

    expect(result.applied).toBe(false);
    expect(result.approved).toBe(true);
  });

  it("allows extra sections beyond the required 8", () => {
    const content = [
      "## Goal",
      "- Product goal.",
      "",
      "## Current Flow",
      "- Current flow.",
      "",
      "## Desired Flow",
      "- Desired flow.",
      "",
      "## Boundaries",
      "- Boundaries.",
      "",
      "## Implementation",
      "- Implementation.",
      "",
      "## Testing",
      "- Testing.",
      "",
      "## Decisions",
      "- Decisions.",
      "",
      "## Non-goals",
      "- Non-goals.",
      "",
      "## Notes",
      "- An extra section that should be allowed.",
    ].join("\n");

    const result = validateArtifactPolicy({
      path: planPath,
      content,
      config: structuralOnlyConfig,
    });

    expect(result.approved).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("does not require Chinese content", () => {
    const content = [
      "## Goal",
      "- A product goal written in English.",
      "",
      "## Current Flow",
      "- Current flow description in English.",
      "",
      "## Desired Flow",
      "- Desired flow description in English.",
      "",
      "## Boundaries",
      "- Boundaries in English.",
      "",
      "## Implementation",
      "- Implementation details in English.",
      "",
      "## Testing",
      "- Testing strategy in English.",
      "",
      "## Decisions",
      "- Decisions in English.",
      "",
      "## Non-goals",
      "- Non-goals in English.",
    ].join("\n");

    const result = validateArtifactPolicy({
      path: planPath,
      content,
      config: structuralOnlyConfig,
    });

    expect(result.approved).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("does not require checkbox steps", () => {
    const content = [
      "## Goal",
      "- Product goal.",
      "",
      "## Current Flow",
      "- Current flow.",
      "",
      "## Desired Flow",
      "- Desired flow.",
      "",
      "## Boundaries",
      "- Boundaries.",
      "",
      "## Implementation",
      "- Implementation.",
      "",
      "## Testing",
      "- Testing.",
      "",
      "## Decisions",
      "- Decisions.",
      "",
      "## Non-goals",
      "- Non-goals.",
    ].join("\n");

    const result = validateArtifactPolicy({
      path: planPath,
      content,
      config: structuralOnlyConfig,
    });

    expect(result.approved).toBe(true);
    expect(result.issues).toEqual([]);
  });
});

describe("plan artifact content forms", () => {
  const noDiagramsPlan = [
    "## Goal",
    "- Product goal.",
    "",
    "## Current Flow",
    "- Current flow in prose only.",
    "",
    "## Desired Flow",
    "- Desired flow in prose only.",
    "",
    "## Boundaries",
    "- Boundaries in prose only.",
    "",
    "## Implementation",
    "- Implementation details in prose only.",
    "",
    "## Testing",
    "- Testing.",
    "",
    "## Decisions",
    "- Decisions.",
    "",
    "## Non-goals",
    "- Non-goals.",
  ].join("\n");

  it("rejects a prose-only plan with one issue per missing content form", () => {
    const result = validateArtifactPolicy({
      path: planPath,
      content: noDiagramsPlan,
    });

    expect(result.approved).toBe(false);
    const formIssues = result.issues.filter(
      (issue) => issue.code === "missing_content_form",
    );
    expect(formIssues.map((issue) => issue.section)).toEqual([
      "Current Flow",
      "Desired Flow",
      "Boundaries",
      "Implementation",
    ]);
  });

  it("reports only the sections that are missing their content form", () => {
    const content = noDiagramsPlan.replace(
      "## Implementation\n- Implementation details in prose only.",
      "## Implementation\nparentFn()\n  ├─ childA()\n  └─ childB()",
    );

    const result = validateArtifactPolicy({
      path: planPath,
      content,
    });

    const formIssues = result.issues.filter(
      (issue) => issue.code === "missing_content_form",
    );
    expect(formIssues.map((issue) => issue.section)).toEqual([
      "Current Flow",
      "Desired Flow",
      "Boundaries",
    ]);
  });

  it("skips content form checks when requireReviewDetails is disabled", () => {
    const result = validateArtifactPolicy({
      path: planPath,
      content: noDiagramsPlan,
      config: structuralOnlyConfig,
    });

    expect(result.approved).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("includes guidance and a fix snippet in the block reason", () => {
    const result = validateArtifactPolicy({
      path: planPath,
      content: noDiagramsPlan,
    });
    const reason = formatArtifactPolicyFailure(planPath, result.issues);

    expect(reason).toContain("Mermaid sequenceDiagram");
    expect(reason).toContain("```mermaid");
    expect(reason).toContain("├─");
  });

  it("every Mermaid fix snippet includes MERMAID_CONFIG_LIGHT frontmatter", () => {
    const result = validateArtifactPolicy({
      path: planPath,
      content: noDiagramsPlan,
    });
    const reason = formatArtifactPolicyFailure(planPath, result.issues);

    // Extract each mermaid code block to verify it starts with the frontmatter
    const mermaidBlocks = reason.match(/```mermaid\n[\s\S]*?```/g);
    expect(mermaidBlocks).not.toBeNull();
    const blocks = expectDefined(mermaidBlocks);
    expect(blocks.length).toBeGreaterThanOrEqual(3);

    for (const block of blocks) {
      // Each block must start with ```mermaid\n---\nconfig:\n  theme: base
      expect(block).toMatch(/```mermaid\n---\nconfig:\n {2}theme: base/);
      expect(block).toContain("themeVariables:");
    }
  });

  it("keeps Implementation fix snippet as ASCII tree (unchanged)", () => {
    const result = validateArtifactPolicy({
      path: planPath,
      content: noDiagramsPlan,
    });
    const reason = formatArtifactPolicyFailure(planPath, result.issues);

    expect(reason).toContain("├─ childA()");
    expect(reason).toContain("└─ childB()");
    expect(reason).toContain("parentFn()");
  });
});
