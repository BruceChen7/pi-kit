// Plan artifact writing guidance shared across extensions:
//   - plan-mode system prompt (constants.ts, PLAN_REVIEW_ARTIFACT_GUIDANCE)
//   - submit-time artifact policy (artifact-policy.ts, CONTENT_FORM_CHECKS)
//   - plannotator-auto pending-review gate messages (plan-review.ts)
// This module is a cross-extension seam: keep it a leaf (no extension
// imports), so any consumer can depend on it without a cycle.

// Mermaid frontmatter config for light-theme readability.
// Every mermaid block in a plan artifact must start with this config block.
// It uses theme: base with explicit themeVariables so diagrams are readable
// in light themes (the common rendering context for plan documents).
// Note: %%{init: ...}%% directive is deprecated since Mermaid v10.5.0;
// frontmatter (---\nconfig:\n ...\n---) is the recommended replacement.
export const MERMAID_CONFIG_LIGHT = [
  "---",
  "config:",
  "  theme: base",
  "  themeVariables:",
  "    actorBkg: '#f0f4f8'",
  "    actorBorder: '#94a3b8'",
  "    actorTextColor: '#1a202c'",
  "    actorLineColor: '#94a3b8'",
  "    signalColor: '#2563eb'",
  "    signalTextColor: '#1a202c'",
  "    noteBkgColor: '#fef3c7'",
  "    noteBorderColor: '#d97706'",
  "    noteTextColor: '#1a202c'",
  "    labelBoxBkgColor: '#e2e8f0'",
  "    labelBoxBorderColor: '#94a3b8'",
  "    labelTextColor: '#1a202c'",
  "---",
].join("\n");

const MERMAID_CONFIG_EXAMPLE = [
  "```mermaid",
  "---",
  "config:",
  "  theme: base",
  "  themeVariables:",
  "    actorBkg: '#f0f4f8'",
  "    ...",
  "---",
  "sequenceDiagram",
  "  ...",
  "```",
].join("\n");

export const FLOW_TREE_GUIDANCE = [
  "- Current Flow / Desired Flow 使用 Mermaid sequenceDiagram + tree 格式。",
  "- Module 是边界，不要太细到代码行级。",
  "- Desired Flow 标注新增、删除、修改的变化部分。",
  "- Mermaid 代码块必须以 Mermaid frontmatter config（--- / config: / themeVariables: / ---）开头，",
  "  确保浅色主题下文字和线条清晰可辨。示例：",
  ...MERMAID_CONFIG_EXAMPLE.split("\n").map((l) => `  ${l}`),
];
export const BOUNDARIES_SEQUENCE_GUIDANCE =
  "- Boundaries 用 Mermaid sequenceDiagram 表达层间交互和 ownership。" +
  " 展示谁检测、谁副作用、谁更新状态、谁持久化。" +
  " Mermaid 代码块同样需要以上述 frontmatter config 开头。";
export const IMPLEMENTATION_CALL_TREE_GUIDANCE = [
  "- Implementation 中的调用链用 ASCII tree 展示：",
  "  父函数 → 子调用 → 条件分支，标注 skip / 过滤 / 副作用 / 数据流向。",
  "- 用 ├─ 和 └─ 画树，条件或循环用 ← 标注原因。",
  "- 示例:",
  "  bootstrapDefaultManagedPlugins(cwd, plugins)",
  "    ├─ 读 defaultDisabledPlugins（默认: copyx, pi-autoresearch）",
  "    └─ 遍历库插件（排除全局 autoload: plugin-toggle, shared, cc-switch）",
  "         ├─ effective = (library − defaultDisabled − 差异) ∪ 差异enabled",
  "         └─ effective.has(name) ? enablePlugin()   ← 副作用: 写 symlink",
  "              : removePluginSymlink()              ← 副作用: 删 symlink",
  "- Mermaid 留给 Current Flow / Desired Flow / Boundaries 的架构层交互；",
  "  ASCII tree 用于 Implementation 的函数级调用链和条件分支。",
  "- 调用树中每层标注归属 Functional Core 还是 Imperative Shell，副作用分支明确标为 Shell，纯计算分支标为 Core。",
];

export const FC_IS_GUIDANCE = [
  "- 实现代码必须按 Functional Core, Imperative Shell（FC/IS）拆分：",
  "  Core 是纯函数 value in / value out（无 IO、无副作用、可表测）；Shell 只做 IO/编排/副作用（读文件、网络、DB、时钟、env）。",
  "  Boundaries 用 plain DTO/接口定义 Core↔Shell 边界，不传 live service 对象。",
  "  Implementation 调用树中标注每层归属 Core 还是 Shell，并标出 side effect / 纯计算分支。",
  "  Testing 围绕 Core 的 value in / value out 写表测，Shell 尽量薄、只测边界行为，不测编排 mock choreography。",
  "  违反信号：业务判断与 IO/DB/网络/时钟/全局变量缠绕、或测试断言 mock choreography 即为未按 FC/IS 拆分。",
];

export const FC_IS_CHECKLIST_ENTRY =
  "- ## Implementation / ## Boundaries / ## Testing 体现 FC/IS 拆分：包含 Functional Core / Imperative Shell / FC/IS / value in / value out / 纯函数 等关键词之一，且 Implementation 调用树标注 Core vs Shell 与副作用。";

const stripGuidanceBullet = (line: string): string => line.replace(/^-\s*/, "");

/** The content form a standard plan section must contain to pass the policy. */
export type PlanContentForm = "mermaid" | "ascii-call-tree";

/**
 * Single source of truth for "what content form each plan section must
 * have". The submit-time policy checks (artifact-policy.ts
 * CONTENT_FORM_CHECKS) and the agent-facing pre-submit checklist
 * (PLAN_SUBMIT_CHECKLIST) are both derived from this list, so the prompt
 * guidance can never drift from the enforced rules.
 */
export const PLAN_CONTENT_FORM_RULES: readonly {
  section: string;
  form: PlanContentForm;
  suggestion: string;
}[] = [
  {
    section: "Current Flow",
    form: "mermaid",
    suggestion: `Add a \`\`\`mermaid block. ${stripGuidanceBullet(FLOW_TREE_GUIDANCE[0])}`,
  },
  {
    section: "Desired Flow",
    form: "mermaid",
    suggestion: `Add a \`\`\`mermaid block. ${stripGuidanceBullet(FLOW_TREE_GUIDANCE[2])}`,
  },
  {
    section: "Boundaries",
    form: "mermaid",
    suggestion: `Add a \`\`\`mermaid block. ${stripGuidanceBullet(BOUNDARIES_SEQUENCE_GUIDANCE)}`,
  },
  {
    section: "Implementation",
    form: "ascii-call-tree",
    suggestion: stripGuidanceBullet(IMPLEMENTATION_CALL_TREE_GUIDANCE[0]),
  },
];

const PLAN_CONTENT_FORM_HINTS: Record<PlanContentForm, string> = {
  mermaid: "非空的 ```mermaid 代码块",
  "ascii-call-tree": "├─ / └─ ASCII 调用树（不是只有文件列表或 prose）",
};

/**
 * Pre-submit checklist shown to the agent in the plan-phase prompt and in
 * the pending-review gate messages, so a first submission passes the local
 * policy instead of bouncing back with a format-fix round-trip. The
 * content-form lines are derived from PLAN_CONTENT_FORM_RULES; the fence
 * and heading lines cover the other submit-time checks.
 */
export const PLAN_SUBMIT_CHECKLIST = [
  "- 提交 plan 前先做一次 pre-submit checklist（对照 artifact policy）:",
  ...PLAN_CONTENT_FORM_RULES.map(
    ({ section, form }) =>
      `  - ## ${section} 包含${PLAN_CONTENT_FORM_HINTS[form]}。`,
  ),
  `  ${FC_IS_CHECKLIST_ENTRY}`,
  "- Mermaid 使用 ```mermaid 围栏，不要使用 ~~~mermaid；每个代码块都要闭合。",
  "- 首次提交和被拒绝后的重提都复用同一个 plan 文件，并保持第一个 # 标题不变。",
];

/**
 * Execution todo discipline guidance, templated on the tool the agent should
 * call. Single source of truth for the "one in_progress at a time, update the
 * list before each step" rule — shared by the system prompt (constants.ts,
 * with a generic subject) and the todo tool's promptGuidelines (todo-tool.ts,
 * with the concrete tool name).
 */
export const todoDisciplineGuidance = (todoToolName: string): string =>
  `- Keep at most one in_progress item. Update ${todoToolName} before starting ` +
  "each step: mark the finished step done and the next step in_progress in " +
  "the same call, so the widget shows the step you are about to execute " +
  "— never bulk-mark all items done at the end.";
