export const RUN_LEDGER_ENTRY_TYPE = "pi-kit-subagent-run";

export type RunLedgerEvent =
  | "start"
  | "settled"
  | "intermediate"
  | "failed"
  | "stopped";

export type RunLedgerEntry = {
  runId: string;
  event: RunLedgerEvent;
  agent: string;
  task: string;
  at: number;
  resultChars?: number;
};

export type UnsettledRun = {
  runId: string;
  agent: string;
  task: string;
  startedAt: number;
  lastIntermediateAt?: number;
};

const resolvesRun = (event: RunLedgerEvent): boolean =>
  event === "settled" || event === "failed" || event === "stopped";

export const truncateTask = (task: string, limit = 160): string =>
  task.length > limit ? `${task.slice(0, limit - 1)}…` : task;

export const toLedgerEntry = (input: {
  runId: string;
  event: RunLedgerEvent;
  agent: string;
  task: string;
  at: number;
  resultChars?: number;
}): RunLedgerEntry => ({
  runId: input.runId,
  event: input.event,
  agent: input.agent,
  task: truncateTask(input.task),
  at: input.at,
  ...(input.resultChars === undefined
    ? {}
    : { resultChars: input.resultChars }),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const EVENT_VALUES: readonly RunLedgerEvent[] = [
  "start",
  "settled",
  "intermediate",
  "failed",
  "stopped",
];

const isLedgerEvent = (value: unknown): value is RunLedgerEvent =>
  typeof value === "string" &&
  (EVENT_VALUES as readonly string[]).includes(value);

export const ledgerEntriesOf = (
  entries: readonly unknown[],
): RunLedgerEntry[] =>
  entries.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    if (entry.type !== "custom" || entry.customType !== RUN_LEDGER_ENTRY_TYPE) {
      return [];
    }
    const data = entry.data;
    if (!isRecord(data)) return [];
    const { runId, event, agent, task, at, resultChars } = data;
    if (typeof runId !== "string" || runId === "") return [];
    if (!isLedgerEvent(event)) return [];
    return [
      {
        runId,
        event,
        agent: typeof agent === "string" ? agent : "unknown",
        task: typeof task === "string" ? task : "",
        at: typeof at === "number" ? at : 0,
        ...(typeof resultChars === "number" ? { resultChars } : {}),
      },
    ];
  });

export const unsettledRuns = (
  entries: readonly RunLedgerEntry[],
): UnsettledRun[] => {
  const open = new Map<string, UnsettledRun>();

  for (const entry of entries) {
    if (entry.event === "start") {
      open.set(entry.runId, {
        runId: entry.runId,
        agent: entry.agent,
        task: entry.task,
        startedAt: entry.at,
      });
      continue;
    }
    if (entry.event === "intermediate") {
      const run = open.get(entry.runId);
      if (run !== undefined) run.lastIntermediateAt = entry.at;
      continue;
    }
    if (resolvesRun(entry.event)) {
      open.delete(entry.runId);
    }
  }

  return [...open.values()].sort(
    (left, right) => left.startedAt - right.startedAt,
  );
};

export const renderUnsettled = (runs: readonly UnsettledRun[]): string => {
  if (runs.length === 0) return "";
  const lines = runs.map((run) => {
    const half =
      run.lastIntermediateAt === undefined
        ? ""
        : "（上次给了中间回答，没有结算）";
    return `- ${run.runId} ${run.agent}: ${run.task}${half}`;
  });
  return [
    `${runs.length} subagent run(s) from the previous session never settled:`,
    ...lines,
    "Their sessions are gone; re-run the task or drop it. Nothing was resumed.",
  ].join("\n");
};
