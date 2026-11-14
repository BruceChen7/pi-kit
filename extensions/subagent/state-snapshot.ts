/**
 * subagent 的状态快照（ADR-0002 D5）。
 *
 * 发给别的扩展的是**全量**：每次 `entries` 都完整替换上一份，所以中途 attach 的
 * 消费者不会缺一段历史。快照里只有元数据 —— id、名字、状态、是否关闭 —— 没有
 * 任务正文、结果、工具参数。
 */

import type { SnapshotEnvelope } from "../shared/event-protocol.ts";
import { isTerminal, type RunStatus, type SubagentRun } from "./core.ts";

/**
 * 对外的状态词汇。它故意比内部 `RunStatus` 粗：内部多出来的中间态是
 * 本扩展的实现细节，消费者只该看到"在跑 / 在等 / 闲着 / 失败 / 被打断 / 没跑"。
 */
export type SnapshotAgentState =
  | "working"
  | "waiting"
  | "idle"
  | "failed"
  | "interrupted"
  | "skipped";

export type SnapshotAgent = {
  id: string;
  name: string;
  state: SnapshotAgentState;
  closed: boolean;
};

export const STATE_BY_STATUS: Record<RunStatus, SnapshotAgentState> = {
  queued: "waiting",
  running: "working",
  done: "idle",
  failed: "failed",
  stopped: "skipped",
  intermediate: "interrupted",
};

export const snapshotOf = (
  runs: readonly SubagentRun[],
): SnapshotEnvelope<SnapshotAgent> => {
  const entries = runs
    .map((run) => ({
      id: run.runId,
      name: run.agent,
      state: STATE_BY_STATUS[run.status],
      closed: isTerminal(run.status),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return { kind: "snapshot", empty: entries.length === 0, entries };
};

/** 两份快照是不是一样；一样就不必再发（避免 UI 回环与无谓唤醒）。 */
export const sameSnapshot = (
  left: SnapshotEnvelope<SnapshotAgent> | undefined,
  right: SnapshotEnvelope<SnapshotAgent>,
): boolean => JSON.stringify(left) === JSON.stringify(right);

/** 终态但仍在可见面上的 run 也要能被消费者区分出来。 */
export const openAgents = (
  snapshot: SnapshotEnvelope<SnapshotAgent>,
): SnapshotAgent[] => snapshot.entries.filter((entry) => !entry.closed);
