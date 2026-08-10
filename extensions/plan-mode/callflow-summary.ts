/**
 * Post-execution call-flow summary for approved plans (best-effort).
 *
 * When `planMode.callflowSummary` is enabled, the controller captures the
 * git HEAD ref at approval time and, when the approved-execution turn
 * ends, runs `calldiff diff <ref>` to show what call flow actually
 * changed. Pure formatting lives in `formatCallflowSummary`; the shell
 * (`maybeSendCallflowSummary`) degrades silently on any failure.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type CalldiffResult,
  countDiffStatuses,
} from "../shared/calldiff-json.ts";
import { fetchCalldiffDiff, truncateAscii } from "../shared/callflow.ts";
import { runGit } from "../shared/git.ts";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("plan-mode", { stderr: null });

export type CallflowSummaryOptions = {
  /** Max entrypoints in the summary (default 8). */
  maxEntries?: number;
  /** Max ascii lines in the code block (default 60; 0 = omit). */
  maxAsciiLines?: number;
};

const DEFAULT_MAX_ENTRIES = 8;
const DEFAULT_MAX_ASCII_LINES = 60;

/**
 * Best-effort capture of the current HEAD ref; null outside git or on
 * failure (shell: git spawned via the shared git seam).
 */
export const captureGitHead = (cwd: string): string | null => {
  const result = runGit(cwd, ["rev-parse", "HEAD"]);
  const head = result.stdout.trim();
  return result.exitCode === 0 && head.length > 0 ? head : null;
};

/** Pure: calldiff diff result → user-facing summary text ("" for non-diff). */
export const formatCallflowSummary = (
  result: CalldiffResult,
  options: CallflowSummaryOptions = {},
): string => {
  if (result.mode !== "diff") {
    return "";
  }

  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxAsciiLines = options.maxAsciiLines ?? DEFAULT_MAX_ASCII_LINES;

  if (result.trees.length === 0) {
    return `本次执行未检测到调用流变化(calldiff diff \`${result.from}\` → \`${result.to}\`)。`;
  }

  const lines: string[] = [
    `执行完成,调用流变化摘要(calldiff diff \`${result.from}\` → \`${result.to}\`,AST 语法级):`,
    "",
  ];
  for (const entry of result.trees.slice(0, maxEntries)) {
    const counts = countDiffStatuses(entry.tree);
    lines.push(`- ${entry.entry}: +${counts.added} / -${counts.removed}`);
  }
  if (result.trees.length > maxEntries) {
    lines.push(`- … 共 ${result.trees.length} 个入口,其余省略`);
  }

  if (maxAsciiLines > 0 && result.ascii.trim().length > 0) {
    lines.push(
      "",
      "```text",
      truncateAscii(result.ascii, maxAsciiLines),
      "```",
    );
  }

  lines.push("", "可视化:调用 `create_calldiff_artifact` 可生成调用流变化图。");
  return lines.join("\n");
};

/**
 * Run the summary and deliver it as a follow-up message.
 * Never throws; returns false when nothing was sent.
 *
 * Runs inside the agent-end event handler, so the wait is bounded hard
 * (15s) and the npx download fallback is disabled — a missing binary or
 * an offline machine must never stall the turn-end loop for a minute.
 */
export const maybeSendCallflowSummary = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  fromRef: string,
): Promise<boolean> => {
  const fetched = await fetchCalldiffDiff(ctx.cwd, fromRef, {
    timeoutMs: 15_000,
    preferNpxFallback: false,
  });
  if (fetched.status !== "ok") {
    log.debug("callflow summary skipped", {
      cwd: ctx.cwd,
      code: fetched.code,
    });
    return false;
  }

  const summary = formatCallflowSummary(fetched.result);
  if (summary.length === 0) {
    return false;
  }

  pi.sendUserMessage(summary, { deliverAs: "followUp" });
  return true;
};
