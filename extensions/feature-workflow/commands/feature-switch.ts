import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

import { matchFeatureRecord } from "../feature-query.js";
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

  const records = switchableResult.records;

  if (records.length === 0) {
    ctx.ui.notify("No feature records found", "info");
    return;
  }

  let query = args[0] ?? "";
  if (!query && ctx.hasUI) {
    const choice = await ctx.ui.select(
      "Switch to feature:",
      records.map((record) => record.branch),
    );
    if (choice === undefined) return;
    query = choice;
  }

  const match = matchFeatureRecord(records, query);
  switch (match.kind) {
    case "not-found": {
      ctx.ui.notify(`Unknown feature: ${query}`, "error");
      return;
    }
    case "matched":
      break;
  }

  const record = match.record;

  commandLog.debug("feature-switch target resolved", {
    query,
    repoRoot,
    branch: record.branch,
  });

  commandLog.debug("feature-switch preparing worktree", {
    repoRoot,
    branch: record.branch,
  });

  const switchWorktreeResult = await ensureFeatureWorktree(runWt, {
    branch: record.branch,
    fallbackWorktreePath: record.worktreePath,
  });
  if (switchWorktreeResult.ok === false) {
    notifyAndLogWtError({
      ctx,
      message: switchWorktreeResult.message,
      scope: "wt switch failed",
      meta: {
        branch: record.branch,
        repoRoot,
      },
    });
    return;
  }

  const worktreePath = switchWorktreeResult.worktreePath;

  commandLog.debug("feature-switch worktree ready", {
    branch: record.branch,
    worktreePath,
    setupDrivenLifecycle: true,
  });

  const now = new Date().toISOString();
  const updatedRecord: FeatureRecord = {
    ...record,
    worktreePath: worktreePath || record.worktreePath,
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
    return;
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

  ctx.ui.notify(
    buildFeatureSwitchNotifyMessage({
      result: switchResult,
      inferredBase,
    }),
    "info",
  );

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
}
