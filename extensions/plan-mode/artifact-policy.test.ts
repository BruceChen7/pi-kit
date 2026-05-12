import { describe, expect, it } from "vitest";
import {
  formatArtifactPolicyFailure,
  validateArtifactPolicy,
} from "./artifact-policy.js";

const planPath = ".pi/plans/pi-kit/plan/2026-05-08-demo.md";
const specPath = ".pi/plans/pi-kit/specs/2026-05-08-demo-design.md";
const reviewDetailsFixSnippet =
  "最终 review 将记录改动点、验证结果、剩余风险，以及 bug/根因原因。";

const validPlan = `## Context
- 用户希望实现 Plan Artifact Policy，确保计划文件格式稳定。

## Steps
- [ ] 新增 policy 测试
- [ ] 实现 policy 模块

## Verification
- 运行 npm test -- extensions/plan-mode

## Review
- 待实现后记录改动点、验证结果、风险，以及 bug 修复原因。
`;

describe("plan artifact policy", () => {
  it("approves a standard Chinese plan with checkbox steps", () => {
    const result = validateArtifactPolicy({
      path: planPath,
      content: validPlan,
    });

    expect(result.approved).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("rejects a plan missing a required top-level section", () => {
    const result = validateArtifactPolicy({
      path: planPath,
      content: validPlan.replace("## Review", "## Notes"),
    });

    expect(result.approved).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "missing_section",
        section: "Review",
      }),
    );
  });

  it("rejects a plan whose Steps section has no checkbox item", () => {
    const result = validateArtifactPolicy({
      path: planPath,
      content: validPlan
        .replace("- [ ] 新增 policy 测试", "- 新增 policy 测试")
        .replace("- [ ] 实现 policy 模块", "- 实现 policy 模块"),
    });

    expect(result.approved).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "missing_steps_checkbox",
        section: "Steps",
      }),
    );
  });

  it("includes copyable snippets for common plan format issues", () => {
    const checkboxResult = validateArtifactPolicy({
      path: planPath,
      content: validPlan
        .replace("- [ ] 新增 policy 测试", "- 新增 policy 测试")
        .replace("- [ ] 实现 policy 模块", "- 实现 policy 模块"),
    });

    expect(
      formatArtifactPolicyFailure(planPath, checkboxResult.issues),
    ).toContain("- [ ] 描述一个可验证的执行步骤");
  });

  it("includes a copyable Review fix snippet", () => {
    const result = validateArtifactPolicy({
      path: planPath,
      content: validPlan.replace(
        "- 待实现后记录改动点、验证结果、风险，以及 bug 修复原因。",
        "- 待实现后补充结果。",
      ),
    });

    expect(formatArtifactPolicyFailure(planPath, result.issues)).toContain(
      reviewDetailsFixSnippet,
    );
  });

  it("does not apply standard markdown plan policy to HTML plan artifacts", () => {
    const result = validateArtifactPolicy({
      path: ".pi/plans/pi-kit/plan/2026-05-08-demo.html",
      content: "<html><body><h1>视觉计划</h1></body></html>",
    });

    expect(result.applied).toBe(false);
    expect(result.approved).toBe(true);
  });

  it("does not apply standard plan policy to spec artifacts", () => {
    const result = validateArtifactPolicy({
      path: specPath,
      content: "# PRD\n\n## Problem Statement\n\n需要写 PRD。\n",
    });

    expect(result.applied).toBe(false);
    expect(result.approved).toBe(true);
  });
});
