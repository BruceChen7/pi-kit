/**
 * run 账本（ADR-0002 D4）。
 *
 * 子会话本身恢复不了（`SessionManager.inMemory`），所以账本只回答一个问题：
 * **上次有哪些 run 没有结算**。它用 `pi.appendEntry` 落在父会话记录里，因此
 * 崩溃/关会话之后还在；恢复的语义只能是"重跑或放弃"，不能假装续跑。
 *
 * 这里是纯的：entries 进，未结算的 run 出。
 */

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
  /** 任务摘要：够人做"重跑还是放弃"的判断即可，不存全量上下文。 */
  task: string;
  at: number;
  /** 结果正文的引用（char 数），不复制正文。 */
  resultChars?: number;
};

export type UnsettledRun = {
  runId: string;
  agent: string;
  task: string;
  startedAt: number;
  /** 最后一次见到的中间回答时间；没有就是 undefined。 */
  lastIntermediateAt?: number;
};

/**
 * 账本意义上的"这条 run 不用再管了"：结果已交付、失败或被人停掉。
 *
 * `intermediate` 故意**不**在这里：那一轮结束了，但它欠的结果没到，
 * 所以下次会话要把它报成没结算的 run（见 core.ts 里 `intermediate` 的注释）。
 */
const TERMINAL_EVENTS: ReadonlySet<RunLedgerEvent> = new Set([
  "settled",
  "failed",
  "stopped",
]);

/** 摘要截断：账本条目要小，且不携带任务全文。 */
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

/**
 * 从会话记录里挑出本扩展的账本条目。不认识的形状直接丢掉 —— 账本是诊断用的，
 * 读坏了也不该让扩展启动失败。
 */
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

/**
 * 没有终态事件的 run。同一 runId 有多条 start 时以最后一条为准；
 * 已经有了 settled / failed / stopped 的 run 不再列出来。
 */
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
    if (TERMINAL_EVENTS.has(entry.event)) {
      open.delete(entry.runId);
    }
  }

  return [...open.values()].sort(
    (left, right) => left.startedAt - right.startedAt,
  );
};

/**
 * 给人看的一句话：这些 run 上次没结算，子会话内容已经没了，只能重跑或放弃。
 */
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
