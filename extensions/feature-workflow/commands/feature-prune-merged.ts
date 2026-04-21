import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

import { resolveFeatureCommandRuntime } from "../runtime.js";
import { trimToNull } from "./shared.js";

type WorktreePruneCandidate = {
  branch: string;
  path: string;
  mainState: string;
};

const PRUNE_ELIGIBLE_MAIN_STATES = new Set(["integrated", "empty"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parsePruneCandidatesFromWtList(
  stdout: string,
): WorktreePruneCandidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const candidates: WorktreePruneCandidate[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) continue;

    const branch = trimToNull(item.branch);
    const path = trimToNull(item.path);
    const mainState = trimToNull(item.main_state);
    const isMain = item.is_main === true;

    if (!branch || !path || !mainState || isMain) {
      continue;
    }

    if (!PRUNE_ELIGIBLE_MAIN_STATES.has(mainState)) {
      continue;
    }

    candidates.push({
      branch,
      path,
      mainState,
    });
  }

  return candidates;
}

function buildPruneCandidatePreview(
  candidates: WorktreePruneCandidate[],
): string {
  return candidates
    .map(
      (candidate) =>
        `- ${candidate.branch} (${candidate.mainState}) @ ${candidate.path}`,
    )
    .join("\n");
}

function buildWtErrorMessage(
  stderr: string,
  stdout: string,
  fallback: string,
): string {
  return trimToNull(stderr) ?? trimToNull(stdout) ?? fallback;
}

export async function runFeaturePruneMergedCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string[],
): Promise<void> {
  const runtime = resolveFeatureCommandRuntime({ pi, ctx });
  if (!runtime) {
    return;
  }

  const { runGit, runWt } = runtime;
  const skipConfirm = args.includes("--yes") || args.includes("-y");
  const skipFetch = args.includes("--no-fetch");

  if (!skipFetch) {
    const fetchResult = runGit(["fetch", "--all", "--prune"]);
    if (fetchResult.exitCode !== 0) {
      const fetchError = buildWtErrorMessage(
        fetchResult.stderr,
        fetchResult.stdout,
        "git fetch failed",
      );
      ctx.ui.notify(
        `feature-prune-merged: git fetch --all --prune failed (${fetchError}). Continuing with local refs.`,
        "warning",
      );
    }
  }

  const listResult = await runWt(["list", "--format", "json"]);
  if (listResult.code !== 0) {
    ctx.ui.notify(
      buildWtErrorMessage(
        listResult.stderr,
        listResult.stdout,
        "wt list failed",
      ),
      "error",
    );
    return;
  }

  const candidates = parsePruneCandidatesFromWtList(listResult.stdout);
  if (candidates.length === 0) {
    ctx.ui.notify("No merged worktrees to prune", "info");
    return;
  }

  const preview = buildPruneCandidatePreview(candidates);
  ctx.ui.notify(
    `feature-prune-merged candidates (${candidates.length}):\n${preview}`,
    "info",
  );

  if (!skipConfirm) {
    if (!ctx.hasUI) {
      ctx.ui.notify(
        "feature-prune-merged requires UI confirmation. Re-run with --yes to continue.",
        "warning",
      );
      return;
    }

    const confirmed = await ctx.ui.confirm(
      `Delete ${candidates.length} merged worktree(s)?`,
      preview,
    );
    if (!confirmed) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }
  }

  let removed = 0;
  const failures: string[] = [];

  for (const candidate of candidates) {
    const removeResult = await runWt([
      "remove",
      candidate.branch,
      "--yes",
      "--foreground",
    ]);

    if (removeResult.code === 0) {
      removed += 1;
      continue;
    }

    failures.push(
      `${candidate.branch}: ${buildWtErrorMessage(removeResult.stderr, removeResult.stdout, "wt remove failed")}`,
    );
  }

  if (failures.length === 0) {
    ctx.ui.notify(
      `feature-prune-merged: removed ${removed}/${candidates.length} worktree(s)`,
      "info",
    );
    return;
  }

  ctx.ui.notify(
    `feature-prune-merged: removed ${removed}/${candidates.length} worktree(s), failed ${failures.length}: ${failures.join(" | ")}`,
    "warning",
  );
}
