/**
 * Best-effort call-flow context for plan/spec reviews.
 *
 * When enabled, the plan submitted to Plannotator gets a condensed
 * `calldiff diff` appendix appended to the review payload only — the plan
 * file on disk is never modified. Any failure (no git repo, missing
 * binary, timeout, no changes) degrades silently to the original content.
 *
 * Pure formatting lives in `formatCallflowAppendix`; the shell that runs
 * the CLI and reads config lives in `attachCallflowContext`.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CalldiffResult } from "../shared/calldiff-json.ts";
import { fetchCalldiffDiff, truncateAscii } from "../shared/callflow.ts";
import { createLogger } from "../shared/logger.ts";
import { loadConfig } from "./config.ts";

const log = createLogger("plannotator-auto", { stderr: null });

export type CallflowAppendixOptions = {
  /** Max entrypoints included (default 5). */
  maxEntries?: number;
  /** Max ascii lines per entry (default 40). */
  maxAsciiLinesPerEntry?: number;
};

const DEFAULT_MAX_ENTRIES = 5;
const DEFAULT_MAX_ASCII_LINES = 40;

/** Pure: calldiff diff result → condensed markdown appendix ("" when nothing changed). */
export const formatCallflowAppendix = (
  result: CalldiffResult,
  options: CallflowAppendixOptions = {},
): string => {
  if (result.mode !== "diff") {
    return "";
  }
  if (result.trees.length === 0) {
    return "";
  }

  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxAsciiLines =
    options.maxAsciiLinesPerEntry ?? DEFAULT_MAX_ASCII_LINES;

  const total = result.trees.reduce(
    (acc, entry) => acc + entry.ascii.split("\n").length,
    0,
  );

  const parts: string[] = [
    "## Call-flow context",
    "",
    `> calldiff diff \`${result.from}\` \`${result.to}\` — ${
      result.trees.length
    } 个入口的调用树发生变化(共约 ${total} 行 ascii 输出,AST 语法级,非类型检查)。`,
    "",
  ];

  for (const entry of result.trees.slice(0, maxEntries)) {
    parts.push(
      `<details>`,
      `<summary>${entry.entry}</summary>`,
      "",
      "```text",
      truncateAscii(entry.ascii, maxAsciiLines),
      "```",
      "",
      "</details>",
      "",
    );
  }

  if (result.trees.length > maxEntries) {
    parts.push(
      `… ${result.trees.length - maxEntries} more entrypoint(s) omitted.`,
    );
  }

  return `${parts.join("\n").trimEnd()}\n`;
};

export type CallflowContextConfig = {
  enabled: boolean;
  from?: string;
};

export type AttachCallflowResult = {
  markdown: string;
  attached: boolean;
  skippedReason?: string;
};

/**
 * Append a calldiff appendix to review content when configured.
 * Never throws; failures return the input unchanged.
 */
export const attachCallflowContext = async (
  ctx: ExtensionContext,
  markdown: string,
): Promise<AttachCallflowResult> => {
  const config = loadConfig(ctx.cwd);
  const callflow = config.callflowContext;
  if (!callflow?.enabled) {
    return { markdown, attached: false, skippedReason: "not-enabled" };
  }

  // Best-effort and silent: bound the wait hard and never trigger the npx
  // download fallback (it can hang for a minute when offline) inside a
  // review submission.
  const fetched = await fetchCalldiffDiff(ctx.cwd, callflow.from, {
    timeoutMs: 15_000,
    preferNpxFallback: false,
  });
  if (fetched.status !== "ok") {
    log.debug("callflow context skipped", {
      cwd: ctx.cwd,
      code: fetched.code,
    });
    return {
      markdown,
      attached: false,
      skippedReason:
        fetched.code === "parse-error"
          ? "calldiff output unparseable"
          : `calldiff unavailable (${fetched.code})`,
    };
  }

  const appendix = formatCallflowAppendix(fetched.result);
  if (appendix.length === 0) {
    return { markdown, attached: false, skippedReason: "no-changes" };
  }

  return {
    markdown: `${markdown.replace(/\s+$/u, "")}\n\n---\n\n${appendix}`,
    attached: true,
  };
};
