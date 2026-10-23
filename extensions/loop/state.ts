/**
 * `/loop` 的状态机（纯函数）。
 *
 * 一轮结束时的唯一判断点：判据结果 + 预算 → 继续还是停在哪个终态。
 * 谁跑判据、谁写 entry 都在 index.ts；这里只回答「下一步做什么」。
 */

import { randomUUID } from "node:crypto";
import { DEFAULT_MAX_TURNS } from "./parse.js";

export const LOOP_ENTRY = "loop.v1";
export const LOOP_TURN_TYPE = "loop.turn.v1";

export type LoopStatus =
  | "running"
  | "completed"
  | "stopped"
  | "failed"
  | "interrupted";

export type PredicateResult = {
  exitCode: number | null;
  error?: string;
  timedOut?: boolean;
};

export type LoopState = {
  version: 1;
  runId: string;
  status: LoopStatus;
  goal: string;
  turn: number;
  maxTurns: number;
  until: { command: string; timeoutSec: number } | null;
  allowDirty: boolean;
  startedAt: string;
  updatedAt: string;
  reason: string;
  lastPredicateResult: PredicateResult | null;
};

export type LoopOutcome = "completed" | "aborted" | "error";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isStatus = (value: unknown): value is LoopStatus =>
  typeof value === "string" &&
  ["running", "completed", "stopped", "failed", "interrupted"].includes(value);

const isPredicateResult = (value: unknown): value is PredicateResult =>
  isRecord(value) &&
  (value.exitCode === null || typeof value.exitCode === "number");

export const createInitialLoopState = (options: {
  goal: string;
  maxTurns?: number;
  until?: { command: string; timeoutSec: number } | null;
  allowDirty?: boolean;
  now?: string;
}): LoopState => {
  const now = options.now ?? new Date().toISOString();
  return {
    version: 1,
    runId: randomUUID(),
    status: "running",
    goal: options.goal,
    turn: 1,
    maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
    until: options.until ?? null,
    allowDirty: Boolean(options.allowDirty),
    startedAt: now,
    updatedAt: now,
    reason: "initial-run",
    lastPredicateResult: null,
  };
};

const stateFromEntry = (entry: unknown): LoopState | null => {
  if (
    !isRecord(entry) ||
    entry.type !== "custom" ||
    entry.customType !== LOOP_ENTRY
  ) {
    return null;
  }
  const data = entry.data;
  if (!isRecord(data) || data.version !== 1) {
    return null;
  }
  if (
    typeof data.runId !== "string" ||
    !isStatus(data.status) ||
    typeof data.goal !== "string" ||
    typeof data.turn !== "number" ||
    typeof data.maxTurns !== "number"
  ) {
    return null;
  }
  return {
    version: 1,
    runId: data.runId,
    status: data.status,
    goal: data.goal,
    turn: data.turn,
    maxTurns: data.maxTurns,
    until:
      isRecord(data.until) && typeof data.until.command === "string"
        ? {
            command: data.until.command,
            timeoutSec:
              typeof data.until.timeoutSec === "number"
                ? data.until.timeoutSec
                : 60,
          }
        : null,
    allowDirty: data.allowDirty === true,
    startedAt: typeof data.startedAt === "string" ? data.startedAt : "",
    updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : "",
    reason: typeof data.reason === "string" ? data.reason : "",
    lastPredicateResult: isPredicateResult(data.lastPredicateResult)
      ? data.lastPredicateResult
      : null,
  };
};

/** 取分支上最后一条 loop 状态；畸形 entry 跳过。 */
export const loopFromBranch = (
  entries: readonly unknown[],
): LoopState | null => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const state = stateFromEntry(entries[index]);
    if (state) {
      return state;
    }
  }
  return null;
};

export type LoopDecision =
  | { action: "stop"; nextState: LoopState }
  | { action: "continue"; nextState: LoopState };

/**
 * 一轮结束时的判断。分支顺序就是语义顺序，每条都有测试：
 * 已终态 → 宿主中止 → 宿主报错 → 判据超时 → 判据错误 → 判据通过 →
 * 预算耗尽 → 继续。
 */
export const decideNextStep = (
  state: LoopState,
  predicateResult: PredicateResult | null = null,
  options: { outcome?: LoopOutcome; now?: string } = {},
): LoopDecision => {
  const now = options.now ?? new Date().toISOString();
  const stop = (patch: Partial<LoopState>): LoopDecision => ({
    action: "stop",
    nextState: {
      ...state,
      status: patch.status ?? state.status,
      updatedAt: now,
      ...patch,
    },
  });

  if (state.status !== "running") {
    return { action: "stop", nextState: state };
  }
  if (options.outcome === "aborted") {
    return stop({ status: "stopped", reason: "operator-aborted" });
  }
  if (options.outcome === "error") {
    return stop({ status: "failed", reason: "turn-error" });
  }
  if (predicateResult) {
    if (predicateResult.timedOut) {
      return stop({
        status: "failed",
        reason: "predicate-timeout",
        lastPredicateResult: predicateResult,
      });
    }
    if (
      predicateResult.error ||
      (predicateResult.exitCode !== null && predicateResult.exitCode >= 126)
    ) {
      return stop({
        status: "failed",
        reason: "predicate-error",
        lastPredicateResult: predicateResult,
      });
    }
    if (predicateResult.exitCode === 0) {
      return stop({
        status: "completed",
        reason: "predicate-satisfied",
        lastPredicateResult: predicateResult,
      });
    }
  }
  if (state.turn >= state.maxTurns) {
    return stop({
      status: "stopped",
      reason: "budget-exhausted",
      lastPredicateResult: predicateResult ?? state.lastPredicateResult,
    });
  }
  return {
    action: "continue",
    nextState: {
      ...state,
      turn: state.turn + 1,
      reason: "turn-advanced",
      lastPredicateResult: predicateResult ?? state.lastPredicateResult,
      updatedAt: now,
    },
  };
};

/** 拼给下一轮的提示。只讲目标与判据，不复述用户的原始措辞。 */
export const renderLoopPrompt = (
  state: LoopState,
  turn: number,
  lastPredicate: PredicateResult | null = null,
): string => {
  const parts = [
    `[loop turn ${turn}/${state.maxTurns}]`,
    `Goal: ${state.goal}`,
  ];
  if (state.until) {
    parts.push(
      `Stop predicate: \`${state.until.command}\` (target: exit code 0).`,
    );
  }
  if (lastPredicate && lastPredicate.exitCode !== null) {
    parts.push(
      `Last predicate exit code: ${lastPredicate.exitCode} (goal not satisfied yet).`,
    );
  }
  parts.push(
    "Continue working toward the goal.",
    "Do not commit, push, or open a PR unless the goal asks for it.",
    "State what you changed and what you verified before ending the turn.",
  );
  return parts.join("\n");
};
