import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

import { checkRepoDirty, listDirtyPaths } from "../../shared/git.js";

import { buildBaseBranchCandidates } from "../base-branches.js";
import { checkBaseBranchFreshness } from "../guards.js";
import { buildFeatureBranchName, isFeatureSlug } from "../naming.js";
import { upsertManagedFeatureBranch } from "../registry.js";
import { resolveFeatureCommandRuntime } from "../runtime.js";
import { getFeatureWorkflowSetupMissingFiles } from "../setup.js";
import { areOnlyFeatureSetupManagedDirtyPaths } from "../setup-dirty-guard.js";
import type { FeatureRecord } from "../storage.js";
import { createFeatureWorktree } from "../worktree-gateway.js";
import {
  commandLog,
  maybeSwitchToWorktreeSession,
  notifyAndLogWtError,
  resolveInferredBaseBranch,
  runIgnoredSyncForCommand,
  selectBaseBranch,
  selectBranchSlug,
} from "./shared.js";

export async function runFeatureStartCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  commandLog.debug("feature-start invoked", { cwd: ctx.cwd, hasUI: ctx.hasUI });

  const runtime = resolveFeatureCommandRuntime({ pi, ctx });
  if (!runtime) {
    return;
  }

  const { config, timeoutMs, repoRoot, runGit, runWt } = runtime;

  const missingSetupFiles = getFeatureWorkflowSetupMissingFiles(repoRoot);
  if (missingSetupFiles.length > 0) {
    ctx.ui.notify(
      `feature-start requires local setup-managed files that are missing: ${missingSetupFiles.join(", ")}. Run /feature-setup first.`,
      "warning",
    );
    return;
  }

  if (config.guards.requireCleanWorkspace) {
    const dirty = checkRepoDirty(repoRoot, timeoutMs);
    if (!dirty) {
      ctx.ui.notify("Failed to check git status", "warning");
      return;
    }

    if (dirty.summary.dirty) {
      const dirtyPaths = listDirtyPaths(dirty.porcelain);
      const setupOnlyDirty = areOnlyFeatureSetupManagedDirtyPaths(dirtyPaths);

      if (!setupOnlyDirty) {
        ctx.ui.notify(
          `Repository is dirty (staged ${dirty.summary.staged}, unstaged ${dirty.summary.unstaged}, untracked ${dirty.summary.untracked}). Commit/stash first.`,
          "warning",
        );
        return;
      }

      ctx.ui.notify(
        `Workspace has only /feature-setup managed changes (${dirtyPaths.join(", ")}). Continuing /feature-start.`,
        "info",
      );
    }
  }

  if (!ctx.hasUI) {
    ctx.ui.notify("feature-start requires interactive UI", "error");
    return;
  }

  const slug = await selectBranchSlug(ctx);
  if (!slug) {
    ctx.ui.notify("Cancelled", "info");
    return;
  }

  if (!isFeatureSlug(slug)) {
    ctx.ui.notify("Invalid branch slug", "error");
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

  if (config.guards.enforceBranchNaming && branch !== slug) {
    ctx.ui.notify(`Invalid branch name: ${branch}`, "error");
    return;
  }

  if (config.guards.requireFreshBase) {
    const freshness = checkBaseBranchFreshness({ runGit, baseBranch: base });
    if (!freshness.ok) {
      if (freshness.behind !== null) {
        ctx.ui.notify(
          `Base branch '${base}' is behind '${freshness.upstream}' by ${freshness.behind} commits. Update base branch first.`,
          "error",
        );
      } else {
        ctx.ui.notify(
          `Failed to verify freshness for base branch '${base}'.`,
          "error",
        );
      }
      return;
    }
  }

  ctx.ui.notify(`Creating worktree for ${branch}…`, "info");
  commandLog.debug("feature-start creating worktree", {
    repoRoot,
    branch,
    base,
  });

  const createResult = await createFeatureWorktree(runWt, { branch, base });
  if (createResult.ok === false) {
    notifyAndLogWtError({
      ctx,
      message: createResult.message,
      scope: "wt switch --create failed",
      meta: {
        branch,
        base,
        repoRoot,
      },
    });
    return;
  }

  const worktreePath = createResult.worktreePath;

  commandLog.debug("feature-start worktree ready", {
    branch,
    base,
    worktreePath,
    setupDrivenLifecycle: true,
  });

  const now = new Date().toISOString();
  const record: FeatureRecord = {
    slug,
    branch,
    worktreePath,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };

  try {
    upsertManagedFeatureBranch(repoRoot, {
      branch,
      slug,
      timestamp: now,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(
      `Feature worktree created, but failed to update managed feature registry: ${message}`,
      "warning",
    );
    commandLog.warn("feature registry upsert failed", {
      branch,
      base,
      repoRoot,
      message,
    });
  }

  const beforeSyncResult = await runIgnoredSyncForCommand({
    command: "feature-start",
    phase: "before-session-switch",
    config: config.ignoredSync,
    repoRoot,
    worktreePath,
    branch,
    runWt,
    notify: ctx.ui.notify.bind(ctx.ui),
  });
  if (beforeSyncResult.blocked) {
    return;
  }

  const switchResult = await maybeSwitchToWorktreeSession({
    ctx,
    record,
    worktreePath,
    enabled: config.defaults.autoSwitchToWorktreeSession,
  });

  commandLog.debug("feature-start session switch result", {
    branch,
    switched: switchResult.switched,
    worktreePath: switchResult.record.worktreePath,
  });

  ctx.ui.notify(
    switchResult.switched
      ? `Switched to feature worktree session: ${branch}`
      : `Feature worktree created: ${branch}`,
    "info",
  );

  await runIgnoredSyncForCommand({
    command: "feature-start",
    phase: "after-session-switch",
    config: config.ignoredSync,
    repoRoot,
    worktreePath: switchResult.record.worktreePath,
    branch: switchResult.record.branch,
    runWt,
    notify: ctx.ui.notify.bind(ctx.ui),
  });
}
