import { getDefaultArtifactPolicyConfig } from "./artifact-policy.ts";
import type { PlanMode, PlanModeConfig } from "./types.ts";

export const STATE_ENTRY_TYPE = "plan-mode-state";
export const STATUS_KEY = "plan-mode";
export const TODO_WIDGET_KEY = "plan-mode-todos";
export const TODO_TOOL_NAME = "plan_mode_todo";
export const ACT_TODO_TOOL_NAME = "act_mode_todo";
export const PLANNOTATOR_SUBMIT_TOOL_NAME = "plannotator_auto_submit_review";
export const MARKDOWN_PLAN_REVIEW_ARTIFACT_LOCATION =
  ".pi/plans/<repo>/plan/YYYY-MM-DD-<slug>.md or " +
  ".pi/plans/<repo>/specs/YYYY-MM-DD-<slug>-design.md";
export const HTML_PLAN_REVIEW_ARTIFACT_LOCATION =
  ".pi/plans/<repo>/plan/YYYY-MM-DD-<slug>.html; " +
  "specs remain .pi/plans/<repo>/specs/YYYY-MM-DD-<slug>-design.md";
export const REVIEW_ARTIFACT_LOCATION =
  ".pi/plans/<repo>/plan/YYYY-MM-DD-<slug>.md|.html or " +
  ".pi/plans/<repo>/specs/YYYY-MM-DD-<slug>-design.md";
export const REVIEW_ARTIFACT_WRITE_HINT =
  "No mkdir is needed; use write with a standard filename and the tool will " +
  "create missing .pi/plans parent directories.";
export const REVIEW_ARTIFACT_TARGET = [
  "reviewable plan/spec artifacts under",
  REVIEW_ARTIFACT_LOCATION,
].join(" ");
export const REVIEW_ARTIFACT_WRITE_GUIDANCE = [
  `${REVIEW_ARTIFACT_TARGET}.`,
  REVIEW_ARTIFACT_WRITE_HINT,
].join(" ");
export const SPEC_REVIEW_ARTIFACT_PATTERN = /^\d{4}-\d{2}-\d{2}-.+-design\.md$/;
export const HTML_PLAN_FORMAT_GUIDANCE = [
  "- When planArtifactFormat is html, write implementation plans as " +
    "self-contained HTML under " +
    ".pi/plans/<repo>/plan/YYYY-MM-DD-<slug>.html.",
  "- HTML plan mode is mandatory for implementation plans in this session; " +
    "do not write a Markdown plan unless the format is switched back to " +
    "markdown.",
  "- Use the plannotator-visual-explainer skill Plan path: inline CSS/SVG, " +
    "Plannotator theme tokens, visual timeline/data-flow/key-code/risk " +
    "sections when useful, and no time estimates.",
  "- Specs remain Markdown only under " +
    ".pi/plans/<repo>/specs/YYYY-MM-DD-<slug>-design.md.",
];
export const RECENT_RUN_LIMIT = 5;

const DEFAULT_MODE_SELECTION_TIMEOUT_SECONDS = 5;
export const DEFAULT_MODE_SELECTION_TIMEOUT_MS =
  DEFAULT_MODE_SELECTION_TIMEOUT_SECONDS * 1000;
export const MODE_SELECTION_TITLE = "Choose Plan Mode for this run";
export const MODE_SELECTION_MESSAGE =
  "Choose Plan Mode for this run; defaulting to act in " +
  `${DEFAULT_MODE_SELECTION_TIMEOUT_SECONDS}s.`;
export const MODE_SELECTION_OPTIONS: PlanMode[] = ["act", "plan"];
export const PLAN_MODE_COMMAND_OPTIONS = [
  ...MODE_SELECTION_OPTIONS,
  "format",
  "html",
  "markdown",
  "status",
] as const;
export const EXPLICIT_PLAN_MODE_REQUEST_PATTERN =
  /\b(?:please\s+)?plan\s+(?:this|the|mode|first)|计划模式|规划模式/iu;

export const DEFAULT_CONFIG: PlanModeConfig = {
  defaultMode: "act",
  planArtifactFormat: "markdown",
  planArtifactFormatSource: "default",
  preserveExternalTools: true,
  requireReview: true,
  guards: {
    cwdOnly: true,
    allowedPaths: [],
    readBeforeWrite: true,
  },
  artifactPolicy: getDefaultArtifactPolicyConfig(),
};

export const BUILTIN_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "edit",
  "write",
];
export const PLAN_MODE_TOOL_NAMES = new Set([
  ...BUILTIN_TOOL_NAMES,
  TODO_TOOL_NAME,
  ACT_TODO_TOOL_NAME,
]);
export const WRITE_TOOL_NAMES = new Set(["edit", "write"]);
export const READ_ONLY_PATH_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "ls",
  "rg",
  "fd",
];
export const PATH_GUARDED_TOOL_NAMES = new Set([
  ...READ_ONLY_PATH_TOOL_NAMES,
  ...WRITE_TOOL_NAMES,
]);
export const OUTSIDE_CWD_ALLOWED_TOOL_NAMES = new Set(
  READ_ONLY_PATH_TOOL_NAMES,
);
export const PLAN_INSPECTION_TOOL_NAMES = READ_ONLY_PATH_TOOL_NAMES;
export const PLAN_INSPECTION_TOOL_SLASH_LIST =
  PLAN_INSPECTION_TOOL_NAMES.join("/");
export const PLAN_INSPECTION_TOOL_COMMA_LIST =
  PLAN_INSPECTION_TOOL_NAMES.join(", ");
export const ARCHITECTURE_TEST_GUIDANCE =
  "- 写测试时按 improve-codebase-architecture：Module 的 Interface " +
  "is the test surface; test seam/Adapter behavior, not Implementation details.";
export const DIAGRAM_CHANGE_COLOR_GUIDANCE =
  "- 画流程图/数据模型图时，必须用颜色或图例区分数据变更与逻辑变更，" +
  "并标明新增、删除、修改。";
export const LOGIC_CHANGE_DIAGRAM_GUIDANCE = [
  "- For any code-writing plan/spec that changes logic, state, data models, " +
    "control flow, or process flow, the artifact must include before/after " +
    "diagrams for the affected data model and flow.",
  "- 写代码且涉及逻辑、状态、数据模型、控制流或流程变更的 plan/spec " +
    "必须包含变更前后数据模型与流程图。",
  DIAGRAM_CHANGE_COLOR_GUIDANCE,
];
export const KEY_CODE_SKETCH_GUIDANCE = [
  "- 写 code-changing plan/spec 时，plan 文件必须包含关键代码草案；" +
    "包括关键类型、函数签名、条件判断、状态迁移或测试断言的最小片段。",
  "- 关键代码草案应放在标准 plan 的 ## Context 内，不能新增顶层章节；" +
    "避免粘贴完整实现，只展示能让 reviewer 判断方向的代码。",
];
export const DIRECT_ACT_TODO_GUIDANCE =
  "- In direct act mode, create concrete TODOs before using tools or making changes.";
