import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PlanModeState } from "./state.ts";
import type { AutoDecisionSummary, TodoItem, TodoStatus } from "./types.ts";

export const getModeLabel = (state: PlanModeState): string => {
  if (state.mode === "auto") {
    return `auto:${state.phase}`;
  }
  return state.mode;
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

const findCurrentTodo = (todos: TodoItem[]): TodoItem | undefined =>
  todos.find((todo) => todo.status === "in_progress") ??
  todos.find((todo) => todo.status === "todo") ??
  todos.find((todo) => todo.status === "blocked");

const formatPlanName = (planPath: string): string => {
  const filename = path.basename(planPath);
  const withoutExtension = filename.replace(/\.md$/u, "");
  return withoutExtension.replace(/^\d{4}-\d{2}-\d{2}-/u, "") || "当前计划";
};

export const formatAutoDecision = (
  decision: AutoDecisionSummary | null,
): string | null => {
  if (!decision) {
    return null;
  }

  return `${decision.outcome}: ${decision.reason}`;
};

const getUserRunStatus = (state: PlanModeState): string => {
  if (state.activeRun?.status === "completed") {
    return "Done";
  }
  if (state.phase === "act") {
    return state.hasApprovedActivePlan() ? "Executing" : "Ready to act";
  }
  if (state.todos.length > 0 && !state.hasApprovedActivePlan()) {
    return "Waiting for review";
  }
  return "Planning";
};

export const formatPlanModeStatus = (state: PlanModeState): string => {
  const mode =
    state.mode === "fast"
      ? "fast ⚠ review guard bypassed"
      : getModeLabel(state);
  const decision = formatAutoDecision(state.lastAutoDecision);
  if (!state.activeRun) {
    return [
      `Plan mode: ${mode}`,
      `status: ${getUserRunStatus(state)}`,
      decision,
    ]
      .filter(Boolean)
      .join(" • ");
  }

  const plan = state.activeRun.planPath ?? "unbound plan";
  const archived = state.recentRuns.length;
  const done = state.todos.filter((todo) => todo.status === "done").length;
  return [
    `Plan mode: ${mode}`,
    `status: ${getUserRunStatus(state)}`,
    `run: ${state.activeRun.status}`,
    `plan: ${plan}`,
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
  const modePrefix = `【${state.phase}:completed】`;
  const deliverySummary = `${done}/${total} 项任务已交付`;
  const planPath = state.activeRun?.planPath;
  if (!planPath) {
    return [`${modePrefix}✅ 任务已完成 · ${deliverySummary}`];
  }

  return [
    `${modePrefix}✅ 计划「${formatPlanName(planPath)}」已完成 · ${deliverySummary}`,
  ];
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

  const modePrefix = `【${getModeLabel(state)}】`;
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
