import type {
  SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  addToTotals,
  computeCacheHitPercent,
  emptyTotals,
} from "./cache-math.ts";
import type { AssistantUsageMetric, CacheSessionMetrics } from "./types.ts";

type SessionReader = Pick<SessionManager, "getEntries" | "getBranch">;

type UsageLike = {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  totalTokens?: unknown;
};

type NormalizedUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
};

type AssistantMessageLike = {
  role?: unknown;
  provider?: unknown;
  model?: unknown;
  usage?: unknown;
};

type MessageEntry = Extract<SessionEntry, { type: "message" }> & {
  message: AssistantMessageLike;
};

export function collectCacheSessionMetrics(
  sessionManager: SessionReader,
): CacheSessionMetrics {
  const allEntries = sessionManager.getEntries();
  const activeBranchIds = new Set(
    sessionManager.getBranch().map((entry) => entry.id),
  );

  const treeTotals = emptyTotals();
  const activeBranchTotals = emptyTotals();
  const allMessages: AssistantUsageMetric[] = [];
  const activeBranchMessages: AssistantUsageMetric[] = [];

  let sequence = 0;
  let activeBranchSequence = 0;

  for (const entry of allEntries) {
    if (!isAssistantMessageEntry(entry)) continue;

    sequence += 1;
    const usage = readUsage(entry.message.usage);
    const metric: AssistantUsageMetric = {
      sequence,
      activeBranchSequence: undefined,
      entryId: entry.id,
      timestamp: readTimestamp(entry.timestamp),
      provider: readString(entry.message.provider, "unknown"),
      model: readString(entry.message.model, "unknown"),
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      totalTokens: usage.totalTokens,
      cacheHitPercent: computeCacheHitPercent(
        usage.input,
        usage.cacheRead,
        usage.cacheWrite,
      ),
      isOnActiveBranch: activeBranchIds.has(entry.id),
    };

    addToTotals(treeTotals, metric);
    allMessages.push(metric);

    if (metric.isOnActiveBranch) {
      activeBranchSequence += 1;
      metric.activeBranchSequence = activeBranchSequence;
      addToTotals(activeBranchTotals, metric);
      activeBranchMessages.push(metric);
    }
  }

  return {
    allMessages,
    activeBranchMessages,
    treeTotals,
    activeBranchTotals,
  };
}

function isAssistantMessageEntry(entry: SessionEntry): entry is MessageEntry {
  return (
    entry.type === "message" &&
    typeof entry.message === "object" &&
    entry.message !== null &&
    (entry.message as AssistantMessageLike).role === "assistant"
  );
}

function readUsage(value: unknown): NormalizedUsage {
  const usage = isRecord(value) ? (value as UsageLike) : {};
  const input = readNumber(usage.input);
  const output = readNumber(usage.output);
  const cacheRead = readNumber(usage.cacheRead);
  const cacheWrite = readNumber(usage.cacheWrite);
  const totalTokens = readNumber(
    usage.totalTokens,
    input + output + cacheRead + cacheWrite,
  );
  return { input, output, cacheRead, cacheWrite, totalTokens };
}

function readTimestamp(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return new Date(value).toISOString();
  return new Date(0).toISOString();
}

function readNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
