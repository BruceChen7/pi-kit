import { describe, expect, it } from "vitest";
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
  "- 当前从用户请求到数据返回的全链路流程。",
  "",
  "## Desired Flow",
  "- 目标状态的变化和新增节点。",
  "",
  "## Boundaries",
  "- 展示层间交互和 ownership。",
  "",
  "## Implementation",
  "- 关键数据结构和函数签名。",
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
    });

    expect(result.approved).toBe(true);
    expect(result.issues).toEqual([]);
  });
});
