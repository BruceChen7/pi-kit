import { getDefaultArtifactPolicyConfig } from "./artifact-policy.ts";
import {
  BOUNDARIES_SEQUENCE_GUIDANCE,
  FC_IS_GUIDANCE,
  FLOW_TREE_GUIDANCE,
  IMPLEMENTATION_CALL_TREE_GUIDANCE,
  PLAN_SUBMIT_CHECKLIST,
  todoDisciplineGuidance,
} from "./guidance.ts";

export {
  BOUNDARIES_SEQUENCE_GUIDANCE,
  FC_IS_GUIDANCE,
  FLOW_TREE_GUIDANCE,
  IMPLEMENTATION_CALL_TREE_GUIDANCE,
  PLAN_SUBMIT_CHECKLIST,
  todoDisciplineGuidance,
};

import type {
  PlanArtifactFormat,
  PlanMode,
  PlanModeConfig,
  PlanRunStatus,
  TodoStatus,
  TodoStatusInput,
} from "./types.ts";

export const STATE_ENTRY_TYPE = "plan-mode-state";
export const STATUS_KEY = "plan-mode";
export const MODE_WIDGET_KEY = "plan-mode-current-mode";
export const TODO_WIDGET_KEY = "plan-mode-todos";
export const PLAN_MODE_TOGGLE_SHORTCUT = "alt+0";
export const PLAN_MODE_TOGGLE_SHORTCUT_LABEL = "Alt+0";
export const TODO_TOOL_NAME = "plan_mode_todo";
export const ACT_TODO_TOOL_NAME = "act_mode_todo";
export const PLANNOTATOR_SUBMIT_TOOL_NAME = "plannotator_auto_submit_review";
export const MARKDOWN_PLAN_REVIEW_ARTIFACT_LOCATION =
  ".pi/plans/<repo>/plan/YYYY-MM-DD-<slug>.md or " +
  ".pi/plans/<repo>/specs/YYYY-MM-DD-<slug>-design.md";
export const REVIEW_ARTIFACT_LOCATION =
  ".pi/plans/<repo>/plan/YYYY-MM-DD-<slug>.md, " +
  ".pi/plans/<repo>/specs/YYYY-MM-DD-<slug>-design.md, " +
  ".pi/plans/<repo>/shaping/*.md, or " +
  ".pi/plans/<repo>/issues/<topic>/*.md";
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
export const HTML_ARTIFACT_REVIEW_LOCATION_HINT =
  ".pi/html/<repo>/YYYY-MM-DD-<slug>.html";
export const HTML_ARTIFACT_REVIEW_GUIDANCE =
  "- HTML review artifacts must be written under " +
  "<htmlDirs> as YYYY-MM-DD-<slug>.html, then submitted with " +
  PLANNOTATOR_SUBMIT_TOOL_NAME +
  ".";
export const RECENT_RUN_LIMIT = 5;

export const PLAN_MODE_ACT = "act";
export const PLAN_MODE_PLAN = "plan";
export const PLAN_MODE_LABELS = {
  [PLAN_MODE_ACT]: "Act",
  [PLAN_MODE_PLAN]: "Plan",
} as const satisfies Record<PlanMode, string>;
export const MODE_SELECTION_OPTIONS: PlanMode[] = [
  PLAN_MODE_ACT,
  PLAN_MODE_PLAN,
];
export const PLAN_MODE_COMMAND_OPTIONS = [
  ...MODE_SELECTION_OPTIONS,
  "status",
] as const;
export const PLAN_ARTIFACT_FORMAT_MARKDOWN =
  "markdown" satisfies PlanArtifactFormat;
export const PLAN_ARTIFACT_FORMAT_VALUES = [
  PLAN_ARTIFACT_FORMAT_MARKDOWN,
] as const satisfies readonly PlanArtifactFormat[];
export const TODO_STATUS_TODO = "todo" satisfies TodoStatus;
export const TODO_STATUS_IN_PROGRESS = "in_progress" satisfies TodoStatus;
export const TODO_STATUS_DONE = "done" satisfies TodoStatus;
export const TODO_STATUS_BLOCKED = "blocked" satisfies TodoStatus;
export const TODO_STATUS_PENDING = "pending" satisfies TodoStatusInput;
export const TODO_STATUS_VALUES = [
  TODO_STATUS_TODO,
  TODO_STATUS_IN_PROGRESS,
  TODO_STATUS_DONE,
  TODO_STATUS_BLOCKED,
] as const satisfies readonly TodoStatus[];
export const PLAN_RUN_STATUS_DRAFT = "draft" satisfies PlanRunStatus;
export const PLAN_RUN_STATUS_APPROVED = "approved" satisfies PlanRunStatus;
export const PLAN_RUN_STATUS_EXECUTING = "executing" satisfies PlanRunStatus;
export const PLAN_RUN_STATUS_COMPLETED = "completed" satisfies PlanRunStatus;
export const PLAN_RUN_STATUS_ARCHIVED = "archived" satisfies PlanRunStatus;
export const PLAN_RUN_STATUS_VALUES = [
  PLAN_RUN_STATUS_DRAFT,
  PLAN_RUN_STATUS_APPROVED,
  PLAN_RUN_STATUS_EXECUTING,
  PLAN_RUN_STATUS_COMPLETED,
  PLAN_RUN_STATUS_ARCHIVED,
] as const satisfies readonly PlanRunStatus[];
export const EXPLICIT_PLAN_MODE_REQUEST_PATTERN =
  /\b(?:please\s+)?plan\s+(?:this|the|mode|first)|计划模式|规划模式/iu;

export const DEFAULT_CONFIG: PlanModeConfig = {
  defaultMode: PLAN_MODE_ACT,
  planArtifactFormat: PLAN_ARTIFACT_FORMAT_MARKDOWN,
  planArtifactFormatSource: "default",
  preserveExternalTools: true,
  requireReview: true,
  guards: {
    readBeforeWrite: true,
  },
  artifactPolicy: getDefaultArtifactPolicyConfig(),
  callflowSummary: false,
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
export const READ_ONLY_PATH_TOOL_NAMES = ["read", "ls", "rg", "fd"];
export const PATH_GUARDED_TOOL_NAMES = new Set([
  ...READ_ONLY_PATH_TOOL_NAMES,
  ...WRITE_TOOL_NAMES,
]);
export const PLAN_INSPECTION_TOOL_NAMES = READ_ONLY_PATH_TOOL_NAMES;
export const PLAN_INSPECTION_TOOL_SLASH_LIST =
  PLAN_INSPECTION_TOOL_NAMES.join("/");
export const PLAN_INSPECTION_TOOL_COMMA_LIST =
  PLAN_INSPECTION_TOOL_NAMES.join(", ");
export const FC_IS_TEST_GUIDANCE =
  "- 写测试时按 Functional Core, Imperative Shell: " +
  "核心 value in / value out, shell 尽量薄。 " +
  "Module 的 Interface is the test surface; " +
  "test seam/Adapter behavior, not Implementation details。 " +
  "实现阶段也必须按此拆分：Core 纯函数无副作用，Shell 薄包装只做 IO/编排。";
export const IMPLEMENTATION_DATA_STRUCTURE_GUIDANCE = [
  "- Implementation 强调关键数据结构（types / interfaces / data models），",
  "  而不是文件路径列表。",
  "- 包括关键类型、函数签名、条件判断、状态迁移的最小片段。",
  "- 避免粘贴完整实现，只展示能让 reviewer 判断方向的代码。",
  "- 调用树中标注每层归属 Functional Core 还是 Imperative Shell，副作用归 Shell、纯计算归 Core。",
];
export const TESTING_VALUE_IN_OUT_GUIDANCE = [
  "- Testing 围绕核心 value in / value out，",
  "  写出核心函数签名 + 关键测试场景（Functional Core 表测）。",
  "- Shell 层尽量薄，只测边界行为，不测 mock choreography。",
];
export const DECISIONS_ADR_GUIDANCE =
  "- Decisions 记录 ADR-worthy 的决策原因，包括推荐方案、被拒方案以及原因；若涉及 FC/IS 边界划分一并记录取舍。";
export const NON_GOALS_GUIDANCE =
  "- Non-goals（或 Out of scope）明确不做什么。";
export const PLAN_REVIEW_ARTIFACT_GUIDANCE = [
  ...PLAN_SUBMIT_CHECKLIST,
  "- 从 UX/system flow 出发，先画 flow tree，再确定 architecture boundary。",
  ...FLOW_TREE_GUIDANCE,
  BOUNDARIES_SEQUENCE_GUIDANCE,
  ...IMPLEMENTATION_DATA_STRUCTURE_GUIDANCE,
  ...IMPLEMENTATION_CALL_TREE_GUIDANCE,
  ...FC_IS_GUIDANCE,
  ...TESTING_VALUE_IN_OUT_GUIDANCE,
  DECISIONS_ADR_GUIDANCE,
  NON_GOALS_GUIDANCE,
  FC_IS_TEST_GUIDANCE,
];
export const ACT_CODE_WRITING_GUIDANCE = [FC_IS_TEST_GUIDANCE];
export const EXECUTION_TODO_DISCIPLINE_GUIDANCE =
  todoDisciplineGuidance("the todo list");
export const DIRECT_ACT_TODO_GUIDANCE = [
  "- In direct act mode, create concrete TODOs before using tools or making changes.",
  EXECUTION_TODO_DISCIPLINE_GUIDANCE,
].join("\n");
