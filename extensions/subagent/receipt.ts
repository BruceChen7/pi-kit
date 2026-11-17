import type { RunStatus, SubagentRun } from "./core.ts";

export type RunReceipt = {
  runId: string;
  agent: string;
  status: RunStatus;
  background: boolean;
  taskChars: number;
  resultChars?: number;
  startedAt: number;
  endedAt?: number;
};

export type Receipt = {
  version: 1;
  runs: RunReceipt[];
};

export const RECEIPT_VERSION = 1 as const;

export const observeRun = (run: SubagentRun): RunReceipt => ({
  runId: run.runId,
  agent: run.agent,
  status: run.status,
  background: run.background,
  taskChars: run.task.length,
  ...(run.resultText === undefined
    ? {}
    : { resultChars: run.resultText.length }),
  startedAt: run.startedAt,
  ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
});

export const observeRuns = (runs: readonly SubagentRun[]): Receipt => ({
  version: RECEIPT_VERSION,
  runs: runs
    .map(observeRun)
    .sort((left, right) => left.runId.localeCompare(right.runId)),
});
