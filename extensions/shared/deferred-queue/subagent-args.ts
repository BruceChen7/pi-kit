import { extractAssistantSummary } from "./summary-extractor.ts";
import type { SubagentOptions } from "./types.ts";

/**
 * Subagent spawn options that affect CLI arg construction and summary
 * extraction. A subset of SubagentOptions — only the fields the pure
 * functions below need.
 */
type SubagentArgsOptions = Pick<
  SubagentOptions,
  "extensionPaths" | "promptTemplatePaths" | "model" | "outputMode"
>;

/**
 * Pure: build the pi CLI args for a subagent spawn.
 *
 * Base flags run pi in a minimal non-interactive session. Optional flags
 * are appended in a stable order: --models, -e, --prompt-template.
 * Exported for unit testing — no child process needed.
 */
export function buildSubagentArgs(options: SubagentArgsOptions): string[] {
  const args = [
    "--mode",
    options.outputMode ?? "json",
    "-p",
    "--no-session",
    "--no-extensions",
    "--no-themes",
  ];

  if (options.model) {
    // Explicit --models: pi resolves these patterns instead of the global
    // enabledModels from settings. Without this, enabled models whose
    // provider extension is not loaded (--no-extensions) produce
    // "No models match pattern" warnings on every spawn.
    args.push("--models", options.model);
  }

  if (options.extensionPaths && options.extensionPaths.length > 0) {
    for (const ext of options.extensionPaths) {
      args.push("-e", ext);
    }
  }

  if (options.promptTemplatePaths && options.promptTemplatePaths.length > 0) {
    for (const pt of options.promptTemplatePaths) {
      args.push("--prompt-template", pt);
    }
  }

  return args;
}

/**
 * Pure: extract the summary from subagent output according to output mode.
 *
 * - `text`: stdout carries only the final reply text — use it directly.
 * - `json`: parse the session event stream for the last assistant message.
 * - `fallbackSummary` (captured just before truncation) is used when the
 *   primary extraction yields nothing.
 */
export function extractSubagentSummary(
  outputMode: "json" | "text" | undefined,
  stdout: string,
  fallbackSummary?: string,
): string | undefined {
  if (outputMode === "text") {
    const trimmed = stdout.trim();
    return trimmed || fallbackSummary?.trim() || undefined;
  }
  return extractAssistantSummary(stdout) ?? fallbackSummary;
}
