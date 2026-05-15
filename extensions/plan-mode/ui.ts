import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PLAN_MODE_ACT, PLAN_MODE_LABELS } from "./constants.ts";
import type { PlanModeState } from "./state.ts";
import type {
  PlanDecisionSummary,
  PlanModeConfig,
  TodoItem,
  TodoStatus,
} from "./types.ts";

export const getModeLabel = (state: PlanModeState): string =>
  PLAN_MODE_LABELS[state.mode];

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

const findCurrentTodo = (todos: TodoItem[]): TodoItem | undefined =>
  todos.find((todo) => todo.status === "in_progress") ??
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
        artifactFormat === "html"
          ? "planTarget: .pi/plans/<repo>/plan/YYYY-MM-DD-<slug>.html"
          : "planTarget: .pi/plans/<repo>/plan/YYYY-MM-DD-<slug>.md",
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
  const heading = current
    ? `进行中 #${current.id}/${total}：${current.text}`
    : `已完成 ${done}/${total}`;
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
