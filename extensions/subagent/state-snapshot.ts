import type { SnapshotEnvelope } from "../shared/event-protocol.ts";
import { isTerminal, type RunStatus, type SubagentRun } from "./core.ts";

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

export const sameSnapshot = (
  left: SnapshotEnvelope<SnapshotAgent> | undefined,
  right: SnapshotEnvelope<SnapshotAgent>,
): boolean => JSON.stringify(left) === JSON.stringify(right);
