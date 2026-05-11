import fs from "node:fs";
import path from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ReplacedSessionContext,
} from "@earendil-works/pi-coding-agent";

import { checkRepoDirty, listDirtyPaths } from "../shared/git.js";
import {
  commandLog,
  maybeSwitchToWorktreeSession,
  notifyAndLogWtError,
  runIgnoredSyncForCommand,
} from "./commands/shared.js";
import { evaluateFeatureStartWorkspace } from "./feature-start-workspace-guard.js";
import { checkBaseBranchFreshness } from "./guards.js";
import { buildFeatureBranchName, isFeatureSlug } from "./naming.js";
import {
  type FeatureCommandRuntime,
  resolveFeatureCommandRuntime,
} from "./runtime.js";
import { getFeatureWorkflowSetupMissingFiles } from "./setup.js";
import type { FeatureRecord } from "./storage.js";
import {
  createFeatureWorktree,
  createProcessWtRunner,
} from "./worktree-gateway.js";

export type StartFeatureWorkflowResult =
  | {
      ok: true;
      record: FeatureRecord;
      switched: boolean;
      notify: ExtensionCommandContext["ui"]["notify"];
      replacementCtx: ReplacedSessionContext | null;
    }
  | {
      ok: false;
    };

export type PreparedFeatureStart = {
  runtime: FeatureCommandRuntime;
};

function shouldWarnOnMissingWorktreeInclude(repoRoot: string): boolean {
  const worktreeIncludePath = path.join(repoRoot, ".worktreeinclude");
  if (fs.existsSync(worktreeIncludePath)) {
    return false;
  }

  const wtTomlPath = path.join(repoRoot, ".config", "wt.toml");
  if (!fs.existsSync(wtTomlPath)) {
    return false;
  }

  const wtToml = fs.readFileSync(wtTomlPath, "utf-8");
  return wtToml.includes("wt step copy-ignored");
}

export function preflightFeatureStart(input: {
  pi: ExtensionAPI;
  ctx: ExtensionCommandContext;
}): PreparedFeatureStart | null {
  const runtime = resolveFeatureCommandRuntime({
    pi: input.pi,
    ctx: input.ctx,
  });
  if (!runtime) {
    return null;
  }

  const { config, timeoutMs, repoRoot } = runtime;
  const missingSetupFiles = getFeatureWorkflowSetupMissingFiles(repoRoot);
  if (missingSetupFiles.length > 0) {
    input.ctx.ui.notify(
      `feature-start requires local setup-managed files that are missing: ${missingSetupFiles.join(", ")}. Run /feature-setup first.`,
      "warning",
    );
    return null;
  }

  if (shouldWarnOnMissingWorktreeInclude(repoRoot)) {
    input.ctx.ui.notify(
      "feature-start: .worktreeinclude is missing, so 'wt step copy-ignored' will copy all gitignored files. Run /feature-setup --only=worktreeinclude to recreate the local whitelist.",
      "warning",
    );
  }

  if (config.guards.requireCleanWorkspace) {
    const dirty = checkRepoDirty(repoRoot, timeoutMs);
    if (!dirty) {
      input.ctx.ui.notify("Failed to check git status", "warning");
      return null;
    }

    if (dirty.summary.dirty) {
      const dirtyPaths = listDirtyPaths(dirty.porcelain);
      const workspaceGuard = evaluateFeatureStartWorkspace({
        summary: dirty.summary,
        dirtyPaths,
      });

      if (
        workspaceGuard.notifyMessage &&
        typeof workspaceGuard.notifyLevel === "string"
      ) {
        input.ctx.ui.notify(
          workspaceGuard.notifyMessage,
          workspaceGuard.notifyLevel,
        );
      }

      if (!workspaceGuard.allow) {
        return null;
      }
    }
  }

  return { runtime };
}

export async function startPreparedFeatureWorkflow(input: {
  ctx: ExtensionCommandContext;
  runtime: FeatureCommandRuntime;
  slug: string;
  base: string;
  beforeSessionSwitch?: () => void | Promise<void>;
}): Promise<StartFeatureWorkflowResult> {
  commandLog.debug("feature-start workflow invoked", {
    cwd: input.ctx.cwd,
    slug: input.slug,
    base: input.base,
  });

  const { config, repoRoot, runGit, runWt } = input.runtime;

  if (!isFeatureSlug(input.slug)) {
    input.ctx.ui.notify("Invalid branch slug", "error");
    return { ok: false };
  }

  const branch = buildFeatureBranchName({ slug: input.slug });
  if (config.guards.enforceBranchNaming && branch !== input.slug) {
    input.ctx.ui.notify(`Invalid branch name: ${branch}`, "error");
    return { ok: false };
  }

  if (config.guards.requireFreshBase) {
    const freshness = checkBaseBranchFreshness({
      runGit,
      baseBranch: input.base,
    });
    if (!freshness.ok) {
      if (freshness.behind !== null) {
        input.ctx.ui.notify(
          `Base branch '${input.base}' is behind '${freshness.upstream}' by ${freshness.behind} commits. Update base branch first.`,
          "error",
        );
      } else {
        input.ctx.ui.notify(
          `Failed to verify freshness for base branch '${input.base}'.`,
          "error",
        );
      }
      return { ok: false };
    }
  }

  const createResult = await createFeatureWorktree(runWt, {
    branch,
    base: input.base,
  });
  if (createResult.ok === false) {
    notifyAndLogWtError({
      ctx: input.ctx,
      message: createResult.message,
      scope: "wt switch --create failed",
      meta: {
        branch,
        base: input.base,
        repoRoot,
      },
    });
    return { ok: false };
  }

  const worktreePath = createResult.worktreePath;
  commandLog.debug("feature-start worktree ready", {
    branch,
    base: input.base,
    worktreePath,
    setupDrivenLifecycle: true,
  });

  const now = new Date().toISOString();
  const record: FeatureRecord = {
    slug: input.slug,
    branch,
    worktreePath,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };

  const beforeSyncResult = await runIgnoredSyncForCommand({
    command: "feature-start",
    phase: "before-session-switch",
    config: config.ignoredSync,
    repoRoot,
    worktreePath,
    branch,
    runWt,
    notify: input.ctx.ui.notify.bind(input.ctx.ui),
  });
  if (beforeSyncResult.blocked) {
    return { ok: false };
  }

  const switchResult = await maybeSwitchToWorktreeSession({
    ctx: input.ctx,
    record,
    worktreePath,
    enabled: config.defaults.autoSwitchToWorktreeSession,
    beforeSwitch: input.beforeSessionSwitch,
  });

  commandLog.debug("feature-start session switch result", {
    branch,
    switched: switchResult.switched,
    worktreePath: switchResult.record.worktreePath,
  });

  const postSwitchRunWt = switchResult.switched
    ? createProcessWtRunner(repoRoot)
    : runWt;

  await runIgnoredSyncForCommand({
    command: "feature-start",
    phase: "after-session-switch",
    config: config.ignoredSync,
    repoRoot,
    worktreePath: switchResult.record.worktreePath,
    branch: switchResult.record.branch,
    runWt: postSwitchRunWt,
    notify: switchResult.notify,
  });

  return {
    ok: true,
    record: switchResult.record,
    switched: switchResult.switched,
    notify: switchResult.notify,
    replacementCtx: switchResult.replacementCtx,
  };
}

export async function startFeatureWorkflow(input: {
  pi: ExtensionAPI;
  ctx: ExtensionCommandContext;
  slug: string;
  base: string;
}): Promise<StartFeatureWorkflowResult> {
  const prepared = preflightFeatureStart({
    pi: input.pi,
    ctx: input.ctx,
  });
  if (!prepared) {
    return { ok: false };
  }

  return startPreparedFeatureWorkflow({
    ctx: input.ctx,
    runtime: prepared.runtime,
    slug: input.slug,
    base: input.base,
  });
}
