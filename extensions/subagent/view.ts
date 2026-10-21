/**
 * FleetView 的纯渲染（Functional Core）。
 *
 * 列表走 `ctx.ui.select`，所以这里只产出标签；会话视图走 overlay，行由
 * core.renderTranscript 产出。两处都不画边框 —— 边框归 Shell 的 panelPainter。
 */

import { activeRuns, type SubagentRun, type SubagentState } from "./core.ts";

export type RunOptions = {
  labels: string[];
  ids: string[];
};

const elapsedLabel = (run: SubagentRun, now: number): string => {
  const end = run.endedAt ?? now;
  const seconds = Math.max(0, Math.round((end - run.startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
};

/** 选项标签：`explore a1b2c3d4 · running · 12s · grep`。 */
export function renderRunOptions(
  state: SubagentState,
  now: number = Date.now(),
): RunOptions {
  const runs = activeRuns(state);
  return {
    ids: runs.map((run) => run.runId),
    labels: runs.map((run) => {
      const step = run.step ? ` · ${run.step}` : "";
      return `${run.agent} ${run.runId} · ${run.status} · ${elapsedLabel(run, now)}${step}`;
    }),
  };
}

/** 没有活跃 run 时给用户的静态文案，用于 notify。 */
export function renderEmptyFleetMessage(state: SubagentState): string {
  const finished = state.runs.filter((run) => run.endedAt).length;
  return finished === 0
    ? "no subagent runs in this session"
    : `no active subagent runs (${finished} finished)`;
}

/** 宿主不支持 custom panel 时的降级文案：把会话内容压成可 notify 的短文本。 */
export function renderFleetFallback(
  state: SubagentState,
  maxLines = 12,
): string {
  const runs = activeRuns(state);
  if (runs.length === 0) return renderEmptyFleetMessage(state);
  return runs
    .slice(0, maxLines)
    .map(
      (run) =>
        `${run.runId} ${run.agent} ${run.status}${run.step ? ` · ${run.step}` : ""}`,
    )
    .join("\n");
}
