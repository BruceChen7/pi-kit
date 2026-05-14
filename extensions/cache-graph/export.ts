import { writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { summarizeHitPercent } from "./format-utils.ts";
import type { AssistantUsageMetric, CacheSessionMetrics } from "./types.ts";

export function csvEscape(
  value: string | number | boolean | null | undefined,
): string {
  const text = value == null ? "" : String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

export function sanitizeFileName(name: string): string {
  const sanitized = name
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");

  return sanitized.length > 0 ? sanitized : "session";
}

type SessionNameReader = Pick<
  SessionManager,
  "getSessionName" | "getSessionFile"
>;

function resolveSessionBaseName(sessionManager: SessionNameReader): string {
  const sessionName = sessionManager.getSessionName()?.trim();
  if (sessionName) return sanitizeFileName(sessionName);

  const sessionFile = sessionManager.getSessionFile();
  if (sessionFile) {
    return sanitizeFileName(basename(sessionFile, extname(sessionFile)));
  }

  return "session";
}

const headers = [
  "row_type",
  "scope",
  "assistant_messages",
  "sequence",
  "active_branch_sequence",
  "is_on_active_branch",
  "entry_id",
  "repo_slug",
  "timestamp",
  "time",
  "provider",
  "model",
  "model_key",
  "prompt_tokens",
  "received_tokens",
  "cache_hit_tokens",
  "cache_write_tokens",
  "total_tokens",
  "cache_hit_percent",
  "delta_sent_tokens",
  "delta_received_tokens",
  "delta_cache_hit_tokens",
  "delta_cache_write_tokens",
  "delta_hit_rate_percent",
  "notes",
] as const;

type CsvHeader = (typeof headers)[number];
type CsvCell = string | number | boolean;
type CsvRow = Partial<Record<CsvHeader, CsvCell>>;

function promptTokens(metric: {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}): number {
  return metric.input + metric.cacheRead + metric.cacheWrite;
}

function totalsSummaryRow(
  scope: "active_branch" | "whole_tree",
  totals: CacheSessionMetrics["activeBranchTotals"],
  notes: string,
): CsvRow {
  return {
    row_type: "summary",
    scope,
    assistant_messages: totals.assistantMessages,
    prompt_tokens: promptTokens(totals),
    received_tokens: totals.output,
    cache_hit_tokens: totals.cacheRead,
    cache_write_tokens: totals.cacheWrite,
    total_tokens: totals.totalTokens,
    cache_hit_percent: summarizeHitPercent(totals),
    notes,
  };
}

function summaryRows(metrics: CacheSessionMetrics): CsvRow[] {
  const treeHitRate = summarizeHitPercent(metrics.treeTotals);
  const branchHitRate = summarizeHitPercent(metrics.activeBranchTotals);

  return [
    totalsSummaryRow(
      "active_branch",
      metrics.activeBranchTotals,
      "Matches active-branch cumulative totals",
    ),
    totalsSummaryRow(
      "whole_tree",
      metrics.treeTotals,
      "Matches whole-tree cumulative totals",
    ),
    {
      row_type: "summary",
      scope: "delta_tree_minus_branch",
      assistant_messages:
        metrics.treeTotals.assistantMessages -
        metrics.activeBranchTotals.assistantMessages,
      delta_sent_tokens:
        metrics.treeTotals.input - metrics.activeBranchTotals.input,
      delta_received_tokens:
        metrics.treeTotals.output - metrics.activeBranchTotals.output,
      delta_cache_hit_tokens:
        metrics.treeTotals.cacheRead - metrics.activeBranchTotals.cacheRead,
      delta_cache_write_tokens:
        metrics.treeTotals.cacheWrite - metrics.activeBranchTotals.cacheWrite,
      delta_hit_rate_percent: treeHitRate - branchHitRate,
      notes: "Delta between whole tree and active branch",
    },
  ];
}

function messageRows(metrics: CacheSessionMetrics): CsvRow[] {
  return metrics.allMessages.map((metric: AssistantUsageMetric) => ({
    row_type: "message",
    scope: metric.isOnActiveBranch ? "active_branch" : "other_branch",
    sequence: metric.sequence,
    active_branch_sequence: metric.activeBranchSequence ?? "",
    is_on_active_branch: metric.isOnActiveBranch,
    entry_id: metric.entryId,
    repo_slug: metric.repoSlug,
    timestamp: metric.timestamp,
    time: metric.timestamp.slice(11, 19),
    provider: metric.provider,
    model: metric.model,
    model_key: `${metric.provider}/${metric.model}`,
    prompt_tokens: promptTokens(metric),
    received_tokens: metric.output,
    cache_hit_tokens: metric.cacheRead,
    cache_write_tokens: metric.cacheWrite,
    total_tokens: metric.totalTokens,
    cache_hit_percent: metric.cacheHitPercent,
    notes: "Per-message cache stats row",
  }));
}

export function buildCsv(metrics: CacheSessionMetrics): string {
  const rows: CsvRow[] = [...summaryRows(metrics), ...messageRows(metrics)];
  const csvRows = [headers.join(",")];

  for (const row of rows) {
    csvRows.push(headers.map((header) => csvEscape(row[header])).join(","));
  }

  return `${csvRows.join("\n")}\n`;
}

export async function exportStatsCsv(
  cwd: string,
  sessionManager: SessionNameReader,
  metrics: CacheSessionMetrics,
): Promise<string> {
  const filePath = join(cwd, `${resolveSessionBaseName(sessionManager)}.csv`);
  await writeFile(filePath, buildCsv(metrics), "utf8");
  return filePath;
}
