/**
 * Shared call-flow pipeline glue (thin, deep): runs `calldiff diff` and
 * parses the JSON result in one step, plus the ascii truncation idiom
 * every formatter uses.
 *
 * Consumers (plan-mode summary, plannotator review context, visual-artifact
 * bridge) previously re-implemented the run → parse → degrade sequence and
 * the "… N more lines omitted" truncation in three places. This module is
 * the shared seam for that glue: value in / value out, no IO of its own —
 * the CLI spawn lives in calldiff-runner.ts, the JSON shapes in
 * calldiff-json.ts.
 */

import { type CalldiffResult, parseCalldiffJson } from "./calldiff-json.ts";
import {
  type CalldiffRunErrorCode,
  type CalldiffRunOptions,
  runCalldiffJson,
} from "./calldiff-runner.ts";

export type FetchCalldiffDiffResult =
  | { status: "ok"; result: CalldiffResult }
  | { status: "error"; code: CalldiffRunErrorCode | "parse-error" };

export type FetchCalldiffDiffOptions = Pick<
  CalldiffRunOptions,
  "timeoutMs" | "preferNpxFallback" | "signal"
>;

/**
 * Run `calldiff diff` and parse the JSON result in one step.
 * Failures (no git repo, missing binary, timeout, abort, unparseable
 * output) come back as typed outcomes — callers decide how to degrade.
 */
export const fetchCalldiffDiff = async (
  cwd: string,
  from: string | undefined,
  options: FetchCalldiffDiffOptions = {},
): Promise<FetchCalldiffDiffResult> => {
  const outcome = await runCalldiffJson({
    cwd,
    mode: "diff",
    from,
    ...options,
  });
  if (outcome.status === "error") {
    return { status: "error", code: outcome.code };
  }
  const parsed = parseCalldiffJson(outcome.stdout);
  if (parsed.status !== "ok") {
    return { status: "error", code: "parse-error" };
  }
  return { status: "ok", result: parsed.result };
};

/**
 * Truncate multi-line ascii output to `maxLines`, appending an omission
 * marker. Returns the original string when within the limit.
 */
export const truncateAscii = (ascii: string, maxLines: number): string => {
  const lines = ascii.replace(/\r\n/g, "\n").split("\n");
  if (lines.length <= maxLines) {
    return ascii;
  }
  return `${lines.slice(0, maxLines).join("\n")}\n… ${lines.length - maxLines} more lines omitted`;
};
