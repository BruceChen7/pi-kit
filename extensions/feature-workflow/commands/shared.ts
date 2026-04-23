import fs from "node:fs";

import type {
  ExtensionCommandContext,
  ReplacedSessionContext,
} from "@mariozechner/pi-coding-agent";

import {
  type GitRunner,
  getCurrentBranchName,
  listLocalBranches,
} from "../../shared/git.js";
import { createLogger } from "../../shared/logger.js";
import type { FeatureWorkflowIgnoredSyncConfig } from "../config.js";
import { runIgnoredSync } from "../ignored-sync.js";
import {
  type InferredBaseBranchResult,
  inferBaseBranch,
} from "../infer-base-branch.js";
import { forkSessionForWorktree } from "../session-fork.js";
import type { FeatureRecord } from "../storage.js";
import { trimToNull } from "../utils.js";
import {
  listFeatureRecordsFromWorktree,
  type WtRunner,
} from "../worktree-gateway.js";

const OTHER_BASE_BRANCH = "Other…";

type WorktreeSessionSwitchSkipReason =
  | "disabled"
  | "missing-worktree-path"
  | "cancelled"
  | "ephemeral-session"
  | "session-fork-failed"
  | "session-switch-failed";

type WorktreeSessionSwitchResult = {
  switched: boolean;
  record: FeatureRecord;
  skipReason: WorktreeSessionSwitchSkipReason | null;
  notify: ExtensionCommandContext["ui"]["notify"];
  replacementCtx: ReplacedSessionContext | null;
};

export const commandLog = createLogger("feature-workflow", {
  minLevel: "debug",
  stderr: null,
});

export { trimToNull };

function syncProcessCwd(input: {
  ctx: ExtensionCommandContext;
  branch: string;
  worktreePath: string;
}): void {
  try {
    process.chdir(input.worktreePath);
  } catch (error) {
    const message = `Switched session to ${input.branch}, but failed to align process cwd: ${error instanceof Error ? error.message : String(error)}`;
    input.ctx.ui.notify(message, "warning");
    commandLog.warn("worktree process cwd sync failed", {
      branch: input.branch,
      worktreePath: input.worktreePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function describeWorktreeSessionSkipReason(
  reason: WorktreeSessionSwitchSkipReason | null,
): string {
  switch (reason) {
    case "disabled":
      return "auto-switch is disabled in config";
    case "missing-worktree-path":
      return "missing worktree path";
    case "cancelled":
      return "session switch was cancelled";
    case "ephemeral-session":
      return "current session is ephemeral (--no-session)";
    case "session-fork-failed":
      return "failed to create a worktree session file";
    case "session-switch-failed":
      return "failed to switch to the worktree session";
    default:
      return "unknown reason";
  }
}

function buildFeatureSwitchNextStep(record: FeatureRecord): string {
  const worktreePath = trimToNull(record.worktreePath);
  if (worktreePath) {
    return `cd ${worktreePath} (or: wt switch ${record.branch})`;
  }

  return `wt switch ${record.branch}`;
}

export function buildInferredBaseMessage(
  result: InferredBaseBranchResult,
): string {
  switch (result.kind) {
    case "resolved":
      return `inferred base: ${result.branch} (${result.basis}, ${result.confidence})`;
    case "ambiguous":
      return `inferred base: ambiguous (${result.candidates.join(", ")})`;
    case "unknown":
      return `inferred base: unknown (${result.reason})`;
  }
}

export function buildFeatureSwitchNotifyMessage(input: {
  result: WorktreeSessionSwitchResult;
  inferredBase: InferredBaseBranchResult;
}): string {
  const inference = buildInferredBaseMessage(input.inferredBase);
  if (input.result.switched) {
    return `Switched to feature worktree session: ${input.result.record.branch} (${inference})`;
  }

  const reason = describeWorktreeSessionSkipReason(input.result.skipReason);
  const next = buildFeatureSwitchNextStep(input.result.record);
  return `Worktree ready: ${input.result.record.branch} (${inference}, auto-switch skipped: ${reason}). Next: ${next}`;
}

export function notifyAndLogWtError(input: {
  ctx: ExtensionCommandContext;
  message: string;
  scope: string;
  meta: Record<string, unknown>;
}): void {
  input.ctx.ui.notify(input.message, "error");
  commandLog.error(input.scope, {
    ...input.meta,
    message: input.message,
  });
}

export async function maybeSwitchToWorktreeSession(input: {
  ctx: ExtensionCommandContext;
  record: FeatureRecord;
  worktreePath: string;
  enabled: boolean;
  onSwitched?: (ctx: ReplacedSessionContext) => Promise<void>;
}): Promise<WorktreeSessionSwitchResult> {
  const currentNotify = input.ctx.ui.notify.bind(input.ctx.ui);

  commandLog.debug("worktree session switch requested", {
    branch: input.record.branch,
    enabled: input.enabled,
    worktreePath: input.worktreePath,
  });

  if (!input.enabled) {
    commandLog.debug("worktree session switch skipped", {
      branch: input.record.branch,
      reason: "disabled",
    });
    return {
      switched: false,
      record: input.record,
      skipReason: "disabled",
      notify: currentNotify,
      replacementCtx: null,
    };
  }

  const worktreePath = trimToNull(input.worktreePath);
  if (!worktreePath) {
    commandLog.debug("worktree session switch skipped", {
      branch: input.record.branch,
      reason: "missing-worktree-path",
    });
    return {
      switched: false,
      record: input.record,
      skipReason: "missing-worktree-path",
      notify: currentNotify,
      replacementCtx: null,
    };
  }

  const currentSessionFile = trimToNull(
    input.ctx.sessionManager.getSessionFile(),
  );
  if (!currentSessionFile) {
    input.ctx.ui.notify(
      "Cannot auto-switch to a worktree session because the current session is ephemeral (--no-session).",
      "info",
    );
    commandLog.warn("worktree session switch unavailable", {
      branch: input.record.branch,
      currentSessionFile,
    });
    return {
      switched: false,
      record: input.record,
      skipReason: "ephemeral-session",
      notify: currentNotify,
      replacementCtx: null,
    };
  }

  try {
    commandLog.debug("worktree session fork started", {
      branch: input.record.branch,
      currentSessionFile,
      sourceOnDisk: fs.existsSync(currentSessionFile),
      worktreePath,
    });

    const sessionPath = forkSessionForWorktree({
      currentSessionFile,
      worktreePath,
      sessionManager: input.ctx.sessionManager,
    });
    if (!sessionPath) {
      input.ctx.ui.notify("Failed to create a worktree session file.", "error");
      commandLog.error("worktree session fork failed", {
        branch: input.record.branch,
        currentSessionFile,
        sourceOnDisk: fs.existsSync(currentSessionFile),
        worktreePath,
      });
      return {
        switched: false,
        record: input.record,
        skipReason: "session-fork-failed",
        notify: currentNotify,
        replacementCtx: null,
      };
    }

    const updated: FeatureRecord = {
      ...input.record,
      worktreePath,
      updatedAt: new Date().toISOString(),
    };

    let notify = currentNotify;
    let replacementCtx: ReplacedSessionContext | null = null;
    const result = await input.ctx.switchSession(sessionPath, {
      withSession: async (nextCtx) => {
        replacementCtx = nextCtx;
        notify = nextCtx.ui.notify.bind(nextCtx.ui);
        syncProcessCwd({
          ctx: nextCtx,
          branch: input.record.branch,
          worktreePath,
        });
        await input.onSwitched?.(nextCtx);
      },
    });
    const switched = !result.cancelled;
    commandLog.debug("worktree session switch finished", {
      branch: input.record.branch,
      switched,
      skipReason: switched ? null : "cancelled",
    });
    return {
      switched,
      record: updated,
      skipReason: switched ? null : "cancelled",
      notify,
      replacementCtx,
    };
  } catch (error) {
    input.ctx.ui.notify(
      `Failed to create/switch worktree session: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    commandLog.error("worktree session switch failed", {
      branch: input.record.branch,
      worktreePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      switched: false,
      record: input.record,
      skipReason: "session-switch-failed",
      notify: currentNotify,
      replacementCtx: null,
    };
  }
}

export async function runIgnoredSyncForCommand(input: {
  command: "feature-start" | "feature-switch";
  phase: "before-session-switch" | "after-session-switch";
  config: FeatureWorkflowIgnoredSyncConfig;
  repoRoot: string;
  worktreePath: string;
  branch: string;
  runWt: WtRunner;
  notify: ExtensionCommandContext["ui"]["notify"];
}): Promise<{ blocked: boolean }> {
  const result = await runIgnoredSync({
    command: input.command,
    phase: input.phase,
    config: input.config,
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    branch: input.branch,
    runWt: input.runWt,
    notify: input.notify,
  });

  if (result.blocked) {
    commandLog.warn("ignored-sync blocked workflow", {
      command: input.command,
      phase: input.phase,
      branch: input.branch,
      repoRoot: input.repoRoot,
      worktreePath: input.worktreePath,
    });
  }

  return {
    blocked: result.blocked,
  };
}

export async function loadFeatureRecordsFromWt(input: {
  ctx: ExtensionCommandContext;
  repoRoot: string;
  runWt: WtRunner;
}): Promise<FeatureRecord[] | null> {
  commandLog.debug("loading feature records", {
    repoRoot: input.repoRoot,
  });

  const result = await listFeatureRecordsFromWorktree(input.runWt);
  if (result.ok === false) {
    notifyAndLogWtError({
      ctx: input.ctx,
      message: result.message,
      scope: "wt list failed",
      meta: {
        repoRoot: input.repoRoot,
      },
    });
    return null;
  }

  return result.records;
}

export function buildFeatureListNotifyMessage(
  records: FeatureRecord[],
): string {
  if (records.length === 0) {
    return "No feature records found";
  }

  const previewRecords = records.slice(0, 5);
  const preview = previewRecords.map((record) => record.branch).join(", ");
  const remaining = records.length - previewRecords.length;
  const suffix = remaining > 0 ? ` (+${remaining} more)` : "";

  return `Listed ${records.length} feature(s): ${preview}${suffix}`;
}

export function buildFeaturePreflightNotifyMessage(messages: string[]): string {
  return `feature preflight: ${messages.join(" | ")}`;
}

export function resolveInferredBaseBranch(input: {
  runGit: GitRunner;
  branch?: string | null;
}): {
  currentBranch: string | null;
  localBranches: string[];
  inference: InferredBaseBranchResult;
} {
  const currentBranch = input.branch ?? getCurrentBranchName(input.runGit);
  const localBranches = listLocalBranches(input.runGit);
  return {
    currentBranch,
    localBranches,
    inference: inferBaseBranch({
      currentBranch,
      localBranches,
      runGit: input.runGit,
    }),
  };
}

export async function selectBranchSlug(
  ctx: ExtensionCommandContext,
): Promise<string | null> {
  if (!ctx.hasUI) return null;
  return trimToNull(await ctx.ui.input("Branch slug:", ""));
}

export async function selectBaseBranch(input: {
  ctx: ExtensionCommandContext;
  candidates: string[];
}): Promise<string | null> {
  const { ctx } = input;
  if (!ctx.hasUI) {
    return input.candidates[0] ?? null;
  }

  const options = [
    ...input.candidates.slice(0, 12),
    ...(input.candidates.length > 12 ? [OTHER_BASE_BRANCH] : []),
  ];

  const choice = await ctx.ui.select("Base branch:", options);
  if (choice === undefined) return null;

  if (choice === OTHER_BASE_BRANCH) {
    const manual = await ctx.ui.input("Base branch (local):", "");
    return trimToNull(manual);
  }

  return trimToNull(choice);
}
