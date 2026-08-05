// Plan artifact writing guidance shared by the plan-phase system prompt
// (constants.ts) and the submit-time artifact policy (artifact-policy.ts).
// Kept in a leaf module so both can import it without a cycle:
// constants.ts imports artifact-policy.ts for getDefaultArtifactPolicyConfig.

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
  ...MERMAID_CONFIG_EXAMPLE.split("\n").map((l) => "  " + l),
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
  "    └─ plugins.filter(isDefaultBootstrapEntry)  ← 排除 plugin-toggle, shared",
  "         └─ bootstrapPlugins(...)",
  "              └─ 遍历: disabled.has(name) → skip",
  "                   其余 → enablePlugin()  ← 副作用: 写 symlink",
  "- Mermaid 留给 Current Flow / Desired Flow / Boundaries 的架构层交互；",
  "  ASCII tree 用于 Implementation 的函数级调用链和条件分支。",
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
