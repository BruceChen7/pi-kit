/**
 * receipt：一次工具调用"看到了什么"的不可变记录（ADR-0002 D6）。
 *
 * 工具结果会留在 transcript 里，所以它只能装**永远为真**的东西：这次调用碰到哪个
 * run、那一刻它的身份、状态、任务长度、结果长度。不装会变的字段 —— 最近工具名
 * （`step`）、最近事件时间（`lastEventAt`）、transcript、结果正文、错误文本：
 * 那些描述"现在在跑什么"，渲染时另找来源。
 *
 * 纯函数：run 进，receipt 出，不读时钟。
 */

import type { RunStatus, SubagentRun } from "./core.ts";

export type RunReceipt = {
  runId: string;
  agent: string;
  /** 观察那一刻的状态。 */
  status: RunStatus;
  /** 调用发起时它是不是后台 run。 */
  background: boolean;
  /** 任务的字符数，不是任务正文。 */
  taskChars: number;
  /** 结果的字符数；还没结算时没有这个字段。 */
  resultChars?: number;
  /** 开始时的事实；时间戳本身不会变，所以可以进 receipt。 */
  startedAt: number;
  endedAt?: number;
};

export type Receipt = {
  /** receipt 形状变了就加一，读的人据此决定还认不认。 */
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

/** 一次调用碰到的所有 run，按 runId 排序：同一份输入永远得到同一份 receipt。 */
export const observeRuns = (runs: readonly SubagentRun[]): Receipt => ({
  version: RECEIPT_VERSION,
  runs: runs
    .map(observeRun)
    .sort((left, right) => left.runId.localeCompare(right.runId)),
});
