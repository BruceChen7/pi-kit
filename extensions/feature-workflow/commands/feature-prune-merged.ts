import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { runWithWorkingLoader } from "../../shared/ui-working.js";
import { resolveFeatureCommandRuntime } from "../runtime.js";
import type { WtRunner } from "../worktree-gateway.js";
import {
  listPruneCandidatesFromWtList,
  type WorktreePruneCandidate,
} from "../wt-list.js";
import { trimToNull } from "./shared.js";

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

async function pruneCandidates(
  runWt: WtRunner,
  candidates: WorktreePruneCandidate[],
): Promise<{ failures: string[]; removed: number }> {
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

  return { failures, removed };
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

  const listResult = await runWithWorkingLoader(ctx, async () => {
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

    return runWt(["list", "--format", "json"]);
  });
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

  const candidates = listPruneCandidatesFromWtList(listResult.stdout);
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

  const { failures, removed } = await runWithWorkingLoader(ctx, () =>
    pruneCandidates(runWt, candidates),
  );

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
