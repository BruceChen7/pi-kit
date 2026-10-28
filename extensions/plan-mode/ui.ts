import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  PLAN_MODE_ACT,
  PLAN_MODE_LABELS,
  PLAN_MODE_PLAN,
  PLAN_MODE_TOGGLE_SHORTCUT_LABEL,
} from "./constants.ts";
import type { PlanModeState } from "./state.ts";
import type {
  PlanDecisionSummary,
  PlanModeConfig,
  TodoItem,
  TodoStatus,
} from "./types.ts";

export const getModeLabel = (state: PlanModeState): string =>
  PLAN_MODE_LABELS[state.mode];

/** Relative time label for the widget's "updated X ago" hint. */
export const formatRelativeTime = (iso: string, now = Date.now()): string => {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) {
    return "";
  }
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  if (minutes < 1) {
    return "刚刚";
  }
  if (minutes < 60) {
    return `${minutes} 分钟前`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} 小时前`;
  }
  return `${Math.floor(hours / 24)} 天前`;
};

export const symbolForStatus = (status: TodoStatus): string => {
  switch (status) {
    case "done":
      return "✓";
    case "in_progress":
      return "~";
    case "blocked":
      return "!";
    case "todo":
      return " ";
  }
};

const findInProgressTodo = (todos: TodoItem[]): TodoItem | undefined =>
  todos.find((todo) => todo.status === "in_progress");

const findCurrentTodo = (todos: TodoItem[]): TodoItem | undefined =>
  findInProgressTodo(todos) ??
  todos.find((todo) => todo.status === "todo") ??
  todos.find((todo) => todo.status === "blocked");

const formatPlanName = (planPath: string): string => {
  const filename = path.basename(planPath);
  const withoutExtension = filename.replace(/\.(?:md|html)$/u, "");
  return withoutExtension.replace(/^\d{4}-\d{2}-\d{2}-/u, "") || "当前计划";
};

export const formatPlanDecision = (
  decision: PlanDecisionSummary | null,
): string | null => {
  if (!decision) {
    return null;
  }

  return `${decision.outcome}: ${decision.reason}`;
};

const getUserRunStatus = (state: PlanModeState): string => {
  const hasApprovedPlan = state.hasApprovedActivePlan();

  if (state.activeRun?.status === "completed") {
    return hasApprovedPlan ? "Completed, back to Act" : "Completed";
  }
  if (state.phase === PLAN_MODE_ACT) {
    return hasApprovedPlan
      ? "Approved, executing"
      : PLAN_MODE_LABELS[PLAN_MODE_ACT];
  }
  if (state.todos.length > 0 && !hasApprovedPlan) {
    return "Waiting for review";
  }
  return state.mode === PLAN_MODE_ACT
    ? PLAN_MODE_LABELS[PLAN_MODE_ACT]
    : "Planning";
};

export const formatPlanModeStatus = (
  state: PlanModeState,
  config?: PlanModeConfig,
): string => {
  const mode = getModeLabel(state);
  const decision = formatPlanDecision(state.lastAutoDecision);
  const artifactFormat = config ? state.getPlanArtifactFormat(config) : null;
  const formatParts = config
    ? [
        `planArtifactFormat: ${artifactFormat}`,
        `formatSource: ${state.getPlanArtifactFormatSource(config)}`,
        "planTarget: .pi/plans/<repo>/plan/YYYY-MM-DD-<slug>.md",
        "specs: markdown only",
      ]
    : [];
  if (!state.activeRun) {
    return [
      `Plan Mode: ${mode}`,
      `status: ${getUserRunStatus(state)}`,
      ...formatParts,
      decision,
    ]
      .filter(Boolean)
      .join(" • ");
  }

  const plan = state.activeRun.planPath ?? "unbound plan";
  const archived = state.recentRuns.length;
  const done = state.todos.filter((todo) => todo.status === "done").length;
  return [
    `Plan Mode: ${mode}`,
    `status: ${getUserRunStatus(state)}`,
    `run: ${state.activeRun.status}`,
    `plan: ${plan}`,
    ...formatParts,
    `todos: ${done}/${state.todos.length} done`,
    `archived: ${archived}`,
    decision,
  ]
    .filter(Boolean)
    .join(" • ");
};

/**
 * `Plan Mode: {mode}` + 运行状态：两个消费方共用同一对事实，避免文案漂移。
 *
 * `dedupeRunStatus` 只给 pi-web 的常驻状态行用；TUI 的 mode widget 不去重，
 * 那里的 `Plan Mode: Act · Act · Alt+0 toggles` 被基线冻结。
 */
const formatPlanModeHeadline = (
  state: PlanModeState,
  dedupeRunStatus: boolean,
): string => {
  const mode = getModeLabel(state);
  const runStatus = getUserRunStatus(state);
  return dedupeRunStatus && runStatus === mode
    ? `Plan Mode: ${mode}`
    : `Plan Mode: ${mode} · ${runStatus}`;
};

export const formatModeWidgetLines = (
  state: PlanModeState,
  badges: readonly string[] = [],
): string[] => [
  [
    `${formatPlanModeHeadline(state, false)} · ` +
      `${PLAN_MODE_TOGGLE_SHORTCUT_LABEL} toggles`,
    ...badges,
  ].join(" · "),
];

/**
 * pi-web 的常驻状态行（单行）。
 *
 * pi-web 一直显示 `setStatus` 的文本，而 widget 要点开才看得到，所以这行同时讲
 * 模式/阶段与当前 TODO 步骤，面板折叠或页面刷新后用户仍知道进行到哪一步。
 *
 * 返回 undefined 表示普通 act 直聊：调用方应清空 status，不要在 shelf 上留噪音。
 * badges 只在本来就有输出时追加，不靠一段 badge 造出一行状态。
 */
export const formatPlanModeStatusLine = (
  state: PlanModeState,
  badges: readonly string[] = [],
): string | undefined => {
  const hasPlanContext =
    state.mode === PLAN_MODE_PLAN ||
    state.todos.length > 0 ||
    state.activeRun !== null;
  if (!hasPlanContext) {
    return undefined;
  }

  const total = state.todos.length;
  const done = state.todos.filter((todo) => todo.status === "done").length;
  const current = findCurrentTodo(state.todos);
  const parts = [formatPlanModeHeadline(state, true)];
  if (current) {
    parts.push(`#${current.id}/${total} ${current.text}`);
  }
  if (total > 0) {
    parts.push(`${done}/${total} 已完成`);
  }
  parts.push(...badges);
  return parts.join(" · ");
};

export const colorModeWidgetLines = (
  lines: string[],
  ctx: ExtensionContext,
): string[] => lines.map((line) => ctx.ui.theme.fg("accent", line));

const formatCompletedTodoWidgetLines = (
  state: PlanModeState,
  done: number,
  total: number,
): string[] => {
  const modePrefix = state.hasApprovedActivePlan()
    ? "【completed, back to Act】"
    : "【completed】";
  const deliverySummary = `${done}/${total} 项任务已交付`;
  const planPath = state.activeRun?.planPath;
  const heading = planPath
    ? `✅ 计划「${formatPlanName(planPath)}」已完成 · ${deliverySummary}`
    : `✅ 任务已完成 · ${deliverySummary}`;
  const deliveredLines = state.todos
    .filter((todo) => todo.status === "done")
    .map((todo) => `  #${todo.id} ${todo.text}`);

  return [`${modePrefix}${heading}`, "已交付：", ...deliveredLines];
};

export const formatTodoWidgetLines = (state: PlanModeState): string[] => {
  if (state.todos.length === 0) {
    return [];
  }

  const total = state.todos.length;
  const done = state.todos.filter((todo) => todo.status === "done").length;
  const current = findCurrentTodo(state.todos);
  if (!current && state.activeRun?.status === "completed") {
    return formatCompletedTodoWidgetLines(state, done, total);
  }

  const modePrefix = `【${getUserRunStatus(state)}】`;
  const lastUpdate = state.activeRun?.lastTodoUpdateAt
    ? ` · 更新于 ${formatRelativeTime(state.activeRun.lastTodoUpdateAt)}`
    : "";
  // "进行中" is reserved for a status the agent actually wrote. An item that
  // is merely next in line reads as "下一步", so the widget never claims
  // progress the model did not make.
  const currentLabel = findInProgressTodo(state.todos) ? "进行中" : "下一步";
  const heading = `${
    current
      ? `${currentLabel} #${current.id}/${total}：${current.text}`
      : `已完成 ${done}/${total}`
  }${lastUpdate}`;
  const progress = `已完成 ${done}/${total} · 剩余 ${total - done} 项`;
  const todoLines = state.todos.map((todo) => {
    const marker = todo === current ? "→" : " ";
    const notes = todo.notes ? ` (${todo.notes})` : "";
    return `${marker} #${todo.id} [${symbolForStatus(todo.status)}] ${todo.text}${notes}`;
  });

  return [`${modePrefix}${heading}`, progress, ...todoLines];
};

export const colorTodoWidgetHeading = (
  lines: string[],
  ctx: ExtensionContext,
): string[] => {
  const [heading, ...details] = lines;
  if (!heading) {
    return lines;
  }

  return [ctx.ui.theme.fg("accent", heading), ...details];
};
