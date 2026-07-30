// Plan artifact writing guidance shared by the plan-phase system prompt
// (constants.ts) and the submit-time artifact policy (artifact-policy.ts).
// Kept in a leaf module so both can import it without a cycle:
// constants.ts imports artifact-policy.ts for getDefaultArtifactPolicyConfig.
export const FLOW_TREE_GUIDANCE = [
  "- Current Flow / Desired Flow 使用 Mermaid sequenceDiagram + tree 格式。",
  "- Module 是边界，不要太细到代码行级。",
  "- Desired Flow 标注新增、删除、修改的变化部分。",
];
export const BOUNDARIES_SEQUENCE_GUIDANCE =
  "- Boundaries 用 Mermaid sequenceDiagram 表达层间交互和 ownership。" +
  " 展示谁检测、谁副作用、谁更新状态、谁持久化。";
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
