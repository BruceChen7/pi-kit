import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

import { listRemoteBranches } from "../../shared/git.js";
import { runWithWorkingLoader } from "../../shared/ui-working.js";
import {
  buildFeatureSwitchCandidates,
  type FeatureSwitchCandidate,
  matchFeatureSwitchCandidate,
} from "../feature-query.js";
import { resolveFeatureCommandRuntime } from "../runtime.js";
import type { FeatureRecord } from "../storage.js";
import {
  ensureFeatureWorktree,
  listSwitchableFeatureRecordsFromWorktree,
} from "../worktree-gateway.js";
import {
  buildFeatureSwitchNotifyMessage,
  commandLog,
  maybeSwitchToWorktreeSession,
  notifyAndLogWtError,
  resolveInferredBaseBranch,
  runIgnoredSyncForCommand,
} from "./shared.js";

export async function runFeatureSwitchCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string[],
): Promise<void> {
  commandLog.debug("feature-switch invoked", {
    cwd: ctx.cwd,
    args,
    hasUI: ctx.hasUI,
  });

  const runtime = resolveFeatureCommandRuntime({ pi, ctx });
  if (!runtime) {
    return;
  }

  const { config, repoRoot, runGit, runWt } = runtime;

  const switchableResult =
    await listSwitchableFeatureRecordsFromWorktree(runWt);
  if (switchableResult.ok === false) {
    notifyAndLogWtError({
      ctx,
      message: switchableResult.message,
      scope: "wt list failed",
      meta: {
        repoRoot,
      },
    });
    return;
  }

  const candidates = buildFeatureSwitchCandidates({
    records: switchableResult.records,
    originBranches: listRemoteBranches(runGit, "origin"),
  });

  if (candidates.length === 0) {
    ctx.ui.notify("No switchable features found", "info");
    return;
  }

  let query = args[0] ?? "";
  let selectedCandidate: FeatureSwitchCandidate | null = null;
  if (!query && ctx.hasUI) {
    const choice = await ctx.ui.select(
      "Switch to feature:",
      candidates.map((candidate) => candidate.displayLabel),
    );
    if (choice === undefined) return;

    query = choice;
    selectedCandidate =
      candidates.find((candidate) => candidate.displayLabel === choice) ?? null;
    if (!selectedCandidate) {
      ctx.ui.notify(`Unknown feature: ${choice}`, "error");
      return;
    }
  }

  if (!selectedCandidate) {
    const match = matchFeatureSwitchCandidate(candidates, query);
    switch (match.kind) {
      case "not-found": {
        ctx.ui.notify(`Unknown feature: ${match.value}`, "error");
        return;
      }
      case "matched":
        selectedCandidate = match.candidate;
        break;
    }
  }

  const branch = selectedCandidate.branch;

  commandLog.debug("feature-switch target resolved", {
    query,
    repoRoot,
    branch,
    source: selectedCandidate.kind,
    remoteRef: selectedCandidate.remoteRef,
  });

  const completedSwitch = await runWithWorkingLoader(ctx, async () => {
    commandLog.debug("feature-switch preparing worktree", {
      repoRoot,
      branch,
      source: selectedCandidate.kind,
    });

    const switchWorktreeResult = await ensureFeatureWorktree(runWt, {
      branch,
      fallbackWorktreePath: selectedCandidate.fallbackWorktreePath,
    });
    if (switchWorktreeResult.ok === false) {
      notifyAndLogWtError({
        ctx,
        message: switchWorktreeResult.message,
        scope: "wt switch failed",
        meta: {
          branch,
          repoRoot,
        },
      });
      return null;
    }

    const worktreePath = switchWorktreeResult.worktreePath;

    commandLog.debug("feature-switch worktree ready", {
      branch,
      worktreePath,
      setupDrivenLifecycle: true,
      source: selectedCandidate.kind,
    });

    const now = new Date().toISOString();
    const updatedRecord: FeatureRecord = selectedCandidate.record
      ? {
          ...selectedCandidate.record,
          worktreePath: worktreePath || selectedCandidate.record.worktreePath,
          updatedAt: now,
        }
      : {
          slug: branch,
          branch,
          worktreePath,
          status: "active",
          createdAt: now,
          updatedAt: now,
        };

    const beforeSyncResult = await runIgnoredSyncForCommand({
      command: "feature-switch",
      phase: "before-session-switch",
      config: config.ignoredSync,
      repoRoot,
      worktreePath: updatedRecord.worktreePath,
      branch: updatedRecord.branch,
      runWt,
      notify: ctx.ui.notify.bind(ctx.ui),
    });
    if (beforeSyncResult.blocked) {
      return null;
    }

    const switchResult = await maybeSwitchToWorktreeSession({
      ctx,
      record: updatedRecord,
      worktreePath: updatedRecord.worktreePath,
      enabled: config.defaults.autoSwitchToWorktreeSession,
    });

    commandLog.debug("feature-switch session result", {
      branch: switchResult.record.branch,
      switched: switchResult.switched,
      skipReason: switchResult.skipReason,
      worktreePath: switchResult.record.worktreePath,
    });

    const inferredBase = resolveInferredBaseBranch({
      runGit,
      branch: switchResult.record.branch,
    }).inference;

    await runIgnoredSyncForCommand({
      command: "feature-switch",
      phase: "after-session-switch",
      config: config.ignoredSync,
      repoRoot,
      worktreePath: switchResult.record.worktreePath,
      branch: switchResult.record.branch,
      runWt,
      notify: ctx.ui.notify.bind(ctx.ui),
    });

    return {
      switchResult,
      inferredBase,
    };
  });
  if (!completedSwitch) {
    return;
  }

  ctx.ui.notify(
    buildFeatureSwitchNotifyMessage({
      result: completedSwitch.switchResult,
      inferredBase: completedSwitch.inferredBase,
    }),
    "info",
  );
}
