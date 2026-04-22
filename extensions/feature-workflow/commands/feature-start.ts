import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

import { buildBaseBranchCandidates } from "../base-branches.js";
import { buildFeatureBranchName } from "../naming.js";
import {
  preflightFeatureStart,
  startPreparedFeatureWorkflow,
} from "../start-feature.js";
import {
  commandLog,
  resolveInferredBaseBranch,
  selectBaseBranch,
  selectBranchSlug,
} from "./shared.js";

export async function runFeatureStartCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  commandLog.debug("feature-start invoked", { cwd: ctx.cwd, hasUI: ctx.hasUI });

  const prepared = preflightFeatureStart({ pi, ctx });
  if (!prepared) {
    return;
  }

  const { runGit } = prepared.runtime;

  if (!ctx.hasUI) {
    ctx.ui.notify("feature-start requires interactive UI", "error");
    return;
  }

  const slug = await selectBranchSlug(ctx);
  if (!slug) {
    ctx.ui.notify("Cancelled", "info");
    return;
  }

  const { currentBranch, localBranches, inference } = resolveInferredBaseBranch(
    {
      runGit,
    },
  );
  const candidates = buildBaseBranchCandidates({
    currentBranch,
    localBranches,
    inferredBaseBranch: inference.kind === "resolved" ? inference.branch : null,
  });

  const base = await selectBaseBranch({ ctx, candidates });
  if (!base) {
    ctx.ui.notify("Cancelled", "info");
    return;
  }

  const branch = buildFeatureBranchName({ slug });
  ctx.ui.notify(`Creating worktree for ${branch}…`, "info");

  const startResult = await startPreparedFeatureWorkflow({
    ctx,
    runtime: prepared.runtime,
    slug,
    base,
  });
  if (!startResult.ok) {
    return;
  }

  ctx.ui.notify(
    startResult.switched
      ? `Switched to feature worktree session: ${startResult.record.branch}`
      : `Feature worktree created: ${startResult.record.branch}`,
    "info",
  );
}
