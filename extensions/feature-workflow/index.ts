import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { createLogger } from "../shared/logger.js";

import { runFeatureListCommand } from "./commands/feature-list.js";
import { runFeatureSetupCommand } from "./commands/feature-setup.js";
import { runFeatureStartCommand } from "./commands/feature-start.js";
import { runFeatureSwitchCommand } from "./commands/feature-switch.js";
import { runFeatureValidateCommand } from "./commands/feature-validate.js";
import { loadFeatureWorkflowConfig } from "./config.js";
import { matchFeatureRecord } from "./feature-query.js";
import { checkBaseBranchFreshness } from "./guards.js";
import {
  type InferredBaseBranchResult,
  inferBaseBranch,
} from "./infer-base-branch.js";
import { buildFeatureBranchName, isFeatureSlug } from "./naming.js";
import { forkSessionForWorktree } from "./session-fork.js";
import {
  applyFeatureWorkflowSetupProfile,
  DEFAULT_FEATURE_WORKFLOW_SETUP_PROFILE_ID,
  FEATURE_WORKFLOW_RECOMMENDED_WORKTREE_PATH_TEMPLATE,
  FEATURE_WORKFLOW_SETUP_TARGETS,
  FEATURE_WORKFLOW_SETUP_USAGE,
  type FeatureWorkflowSetupProfile,
  type FeatureWorkflowSetupTarget,
  getFeatureWorkflowSetupMissingFiles,
  getFeatureWorkflowSetupProfile,
  getFeatureWorkflowSetupTargetMeta,
  getFeatureWorkflowWorktrunkUserConfigStatus,
  listFeatureWorkflowSetupProfiles,
  parseFeatureWorkflowSetupArgs,
  resolveFeatureWorkflowSetupTargets,
} from "./setup.js";
import { areOnlyFeatureSetupManagedDirtyPaths } from "./setup-dirty-guard.js";
import {
  type FeatureRecord,
  hasActiveFeatureBranchConflict,
} from "./storage.js";
import {
  createFeatureWorktree,
  createWtRunner,
  ensureFeatureWorktree,
  listFeatureRecordsFromWorktree,
  type WtRunner,
} from "./worktree-gateway.js";

const log = createLogger("feature-workflow", {
  minLevel: "debug",
  stderr: null,
});

function parseCommandArgs(rawArgs: string): string[] {
  const trimmed = rawArgs.trim();
  if (!trimmed) return [];

  const tokens = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return tokens.map((token) => token.replace(/^["']|["']$/g, ""));
};

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
};

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

function buildFeatureSwitchNotifyMessage(input: {
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

async function maybeSwitchToWorktreeSession(input: {
  ctx: ExtensionCommandContext;
  record: FeatureRecord;
  worktreePath: string;
  enabled: boolean;
}): Promise<WorktreeSessionSwitchResult> {
  log.debug("worktree session switch requested", {
    branch: input.record.branch,
    enabled: input.enabled,
    worktreePath: input.worktreePath,
  });

  if (!input.enabled) {
    log.debug("worktree session switch skipped", {
      branch: input.record.branch,
      reason: "disabled",
    });
    return {
      switched: false,
      record: input.record,
      skipReason: "disabled",
    };
  }

  const worktreePath = trimToNull(input.worktreePath);
  if (!worktreePath) {
    log.debug("worktree session switch skipped", {
      branch: input.record.branch,
      reason: "missing-worktree-path",
    });
    return {
      switched: false,
      record: input.record,
      skipReason: "missing-worktree-path",
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
    log.warn("worktree session switch unavailable", {
      branch: input.record.branch,
      currentSessionFile,
    });
    return {
      switched: false,
      record: input.record,
      skipReason: "ephemeral-session",
    };
  }

  try {
    log.debug("worktree session fork started", {
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
      log.error("worktree session fork failed", {
        branch: input.record.branch,
        currentSessionFile,
        sourceOnDisk: fs.existsSync(currentSessionFile),
        worktreePath,
      });
      return {
        switched: false,
        record: input.record,
        skipReason: "session-fork-failed",
      };
    }

    const updated: FeatureRecord = {
      ...input.record,
      worktreePath,
      updatedAt: new Date().toISOString(),
    };

    const result = await input.ctx.switchSession(sessionPath);
    const switched = !result.cancelled;
    log.debug("worktree session switch finished", {
      branch: input.record.branch,
      switched,
      skipReason: switched ? null : "cancelled",
    });
    return {
      switched,
      record: updated,
      skipReason: switched ? null : "cancelled",
    };
  } catch (error) {
    input.ctx.ui.notify(
      `Failed to create/switch worktree session: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    log.error("worktree session switch failed", {
      branch: input.record.branch,
      worktreePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      switched: false,
      record: input.record,
      skipReason: "session-switch-failed",
    };
  }
}

async function loadFeatureRecordsFromWt(input: {
  ctx: ExtensionCommandContext;
  repoRoot: string;
  runWt: WtRunner;
}): Promise<FeatureRecord[] | null> {
  log.debug("loading feature records", {
    repoRoot: input.repoRoot,
  });

  const result = await listFeatureRecordsFromWorktree(input.runWt);
  if (!result.ok) {
    input.ctx.ui.notify(result.message, "error");
    log.error("wt list failed", {
      repoRoot: input.repoRoot,
      message: result.message,
    });
    return null;
  }

  return result.records;
}

function buildFeatureListNotifyMessage(records: FeatureRecord[]): string {
  if (records.length === 0) {
    return "No feature records found";
  }

  const previewRecords = records.slice(0, 5);
  const preview = previewRecords.map((record) => record.branch).join(", ");
  const remaining = records.length - previewRecords.length;
  const suffix = remaining > 0 ? ` (+${remaining} more)` : "";

  return `Listed ${records.length} feature(s): ${preview}${suffix}`;
}

function buildFeaturePreflightNotifyMessage(messages: string[]): string {
  return `feature preflight: ${messages.join(" | ")}`;
}

function resolveInferredBaseBranch(input: {
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

function buildInferredBaseMessage(result: InferredBaseBranchResult): string {
  switch (result.kind) {
    case "resolved":
      return `inferred base: ${result.branch} (${result.basis}, ${result.confidence})`;
    case "ambiguous":
      return `inferred base: ambiguous (${result.candidates.join(", ")})`;
    case "unknown":
      return `inferred base: unknown (${result.reason})`;
  }
}

async function selectBranchSlug(
  ctx: ExtensionCommandContext,
): Promise<string | null> {
  if (!ctx.hasUI) return null;
  return trimToNull(await ctx.ui.input("Branch slug:", ""));
}

async function selectBaseBranch(input: {
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

function resolveFeatureSetupProfile(profileId: string | null): {
  profile: FeatureWorkflowSetupProfile | null;
  availableProfileIds: string[];
} {
  const profiles = listFeatureWorkflowSetupProfiles();
  const availableProfileIds = profiles.map((profile) => profile.id);

  if (profileId) {
    return {
      profile: getFeatureWorkflowSetupProfile(profileId),
      availableProfileIds,
    };
  }

  return {
    profile:
      getFeatureWorkflowSetupProfile(
        DEFAULT_FEATURE_WORKFLOW_SETUP_PROFILE_ID,
      ) ??
      profiles[0] ??
      null,
    availableProfileIds,
  };
}

async function maybeSelectFeatureSetupProfileInteractively(
  ctx: ExtensionCommandContext,
  initialProfile: FeatureWorkflowSetupProfile | null,
  explicitProfileRequested: boolean,
  skipInteractivePrompts: boolean,
): Promise<FeatureWorkflowSetupProfile | null> {
  if (explicitProfileRequested || skipInteractivePrompts || !ctx.hasUI) {
    return initialProfile;
  }

  const profiles = listFeatureWorkflowSetupProfiles();
  if (profiles.length <= 1) {
    return initialProfile ?? profiles[0] ?? null;
  }

  const options = profiles.map(
    (profile) => `${profile.id} — ${profile.description}`,
  );

  const selected = await ctx.ui.select("feature-setup profile:", options);
  if (selected === undefined) {
    return null;
  }

  const index = options.indexOf(selected);
  if (index < 0) {
    return initialProfile;
  }

  return profiles[index] ?? initialProfile;
}

async function maybeSelectFeatureSetupTargetsInteractively(
  ctx: ExtensionCommandContext,
  input: {
    parsedOnlyTargets: FeatureWorkflowSetupTarget[] | null;
    parsedSkipTargets: FeatureWorkflowSetupTarget[];
    skipInteractivePrompts: boolean;
  },
): Promise<FeatureWorkflowSetupTarget[] | null> {
  if (
    input.skipInteractivePrompts ||
    !ctx.hasUI ||
    input.parsedOnlyTargets !== null ||
    input.parsedSkipTargets.length > 0
  ) {
    return resolveFeatureWorkflowSetupTargets({
      onlyTargets: input.parsedOnlyTargets,
      skipTargets: input.parsedSkipTargets,
    });
  }

  const mode = await ctx.ui.select("feature-setup scope:", [
    "Apply all recommended files",
    "Customize files",
    "Cancel",
  ]);

  if (mode === undefined || mode === "Cancel") {
    return null;
  }

  if (mode === "Apply all recommended files") {
    return resolveFeatureWorkflowSetupTargets({
      onlyTargets: null,
      skipTargets: [],
    });
  }

  const selectedTargets: FeatureWorkflowSetupTarget[] = [];
  for (const target of FEATURE_WORKFLOW_SETUP_TARGETS) {
    const meta = getFeatureWorkflowSetupTargetMeta(target);
    const include = await ctx.ui.confirm(
      `Include ${meta.label}?`,
      meta.description,
    );

    if (include) {
      selectedTargets.push(target);
    }
  }

  return resolveFeatureWorkflowSetupTargets({
    onlyTargets: selectedTargets,
    skipTargets: [],
  });
}

async function maybeConfirmFeatureSetupWorktrunkUserConfig(
  ctx: ExtensionCommandContext,
  input: {
    targets: FeatureWorkflowSetupTarget[];
    skipInteractivePrompts: boolean;
  },
): Promise<FeatureWorkflowSetupTarget[]> {
  if (
    input.skipInteractivePrompts ||
    !ctx.hasUI ||
    !input.targets.includes("wt-user-config")
  ) {
    return input.targets;
  }

  const status = getFeatureWorkflowWorktrunkUserConfigStatus();
  if (!status.needsUpdate) {
    return input.targets;
  }

  const currentTemplate = status.currentTemplate ?? "(not set)";
  const include = await ctx.ui.confirm(
    "Update Worktrunk user worktree-path?",
    [
      `Config: ${status.path}`,
      `Current: ${currentTemplate}`,
      `Recommended: ${FEATURE_WORKFLOW_RECOMMENDED_WORKTREE_PATH_TEMPLATE}`,
    ].join("\n"),
  );

  if (include) {
    return input.targets;
  }

  return input.targets.filter((target) => target !== "wt-user-config");
}

async function runFeatureSetup(ctx: ExtensionCommandContext, args: string[]) {
  const parsedArgs = parseFeatureWorkflowSetupArgs(args);
  if (!parsedArgs.ok) {
    ctx.ui.notify(parsedArgs.message, "error");
    ctx.ui.notify(FEATURE_WORKFLOW_SETUP_USAGE, "info");
    return;
  }

  const repoRoot = getRepoRoot(ctx.cwd, DEFAULT_GIT_TIMEOUT_MS);
  if (!repoRoot) {
    ctx.ui.notify("Not a git repository", "info");
    return;
  }

  const profileResolution = resolveFeatureSetupProfile(
    parsedArgs.value.profileId,
  );
  let profile = profileResolution.profile;

  const explicitProfileRequested = parsedArgs.value.profileId !== null;
  if (!profile && explicitProfileRequested) {
    const profileId = parsedArgs.value.profileId ?? "";
    ctx.ui.notify(
      `Unknown feature-setup profile '${profileId}'. Available: ${profileResolution.availableProfileIds.join(", ")}`,
      "error",
    );
    return;
  }

  profile = await maybeSelectFeatureSetupProfileInteractively(
    ctx,
    profile,
    explicitProfileRequested,
    parsedArgs.value.yes,
  );
  if (!profile) {
    ctx.ui.notify("Cancelled", "info");
    return;
  }

  const targets = await maybeSelectFeatureSetupTargetsInteractively(ctx, {
    parsedOnlyTargets: parsedArgs.value.onlyTargets,
    parsedSkipTargets: parsedArgs.value.skipTargets,
    skipInteractivePrompts: parsedArgs.value.yes,
  });

  if (!targets) {
    ctx.ui.notify("Cancelled", "info");
    return;
  }

  const effectiveTargets = await maybeConfirmFeatureSetupWorktrunkUserConfig(
    ctx,
    {
      targets,
      skipInteractivePrompts: parsedArgs.value.yes,
    },
  );

  if (effectiveTargets.length === 0) {
    ctx.ui.notify("No setup targets selected. Nothing to do.", "warning");
    return;
  }

  const result = applyFeatureWorkflowSetupProfile({
    cwd: ctx.cwd,
    repoRoot,
    profile,
    targets: effectiveTargets,
  });

  ctx.ui.notify(
    result.changedCount > 0
      ? `feature-setup complete: ${result.changedCount} file(s) updated`
      : "feature-setup complete: no file changes needed",
    "info",
  );
}

async function runFeatureStart(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
  log.debug("feature-start invoked", { cwd: ctx.cwd, hasUI: ctx.hasUI });

  const commandContext = resolveFeatureWorkflowCommandContext({
    cwd: ctx.cwd,
    ui: ctx.ui,
  });
  if (!commandContext) {
    return;
  }

  const { config, timeoutMs, repoRoot, runGit } = commandContext;
  const runWt = createWtRunner(pi, repoRoot);

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
    { runGit },
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

  const activeRecords = await loadFeatureRecordsFromWt({
    ctx,
    repoRoot,
    runWt,
  });
  if (!activeRecords) return;

  if (hasActiveFeatureBranchConflict(activeRecords, branch)) {
    ctx.ui.notify(
      `Active feature worktree already exists for branch: ${branch}`,
      "error",
    );
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
  log.debug("feature-start creating worktree", {
    repoRoot,
    branch,
    base,
  });

  const createResult = await createFeatureWorktree(runWt, { branch, base });
  if (!createResult.ok) {
    ctx.ui.notify(createResult.message, "error");
    log.error("wt switch --create failed", {
      branch,
      base,
      repoRoot,
      message: createResult.message,
    });
    return;
  }

  const worktreePath = createResult.worktreePath;

  log.debug("feature-start worktree ready", {
    branch,
    base,
    worktreePath,
    setupDrivenLifecycle: true,
  });

  const now = new Date().toISOString();
  const record: FeatureRecord = {
    name: slug,
    slug,
    branch,
    worktreePath,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };

  const switchResult = await maybeSwitchToWorktreeSession({
    ctx,
    record,
    worktreePath,
    enabled: config.defaults.autoSwitchToWorktreeSession,
  });

  log.debug("feature-start session switch result", {
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
}

async function runFeatureList(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
  const commandContext = resolveFeatureWorkflowCommandContext({
    cwd: ctx.cwd,
    ui: ctx.ui,
  });
  if (!commandContext) {
    return;
  }

  const { repoRoot } = commandContext;
  const runWt = createWtRunner(pi, repoRoot);

  const records = await loadFeatureRecordsFromWt({
    ctx,
    repoRoot,
    runWt,
  });
  if (!records) return;

  ctx.ui.notify(buildFeatureListNotifyMessage(records), "info");
}

async function runFeatureSwitch(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string[],
) {
  log.debug("feature-switch invoked", {
    cwd: ctx.cwd,
    args,
    hasUI: ctx.hasUI,
  });

  const commandContext = resolveFeatureWorkflowCommandContext({
    cwd: ctx.cwd,
    ui: ctx.ui,
  });
  if (!commandContext) {
    return;
  }

  const { config, repoRoot, runGit } = commandContext;
  const runWt = createWtRunner(pi, repoRoot);

  const records = await loadFeatureRecordsFromWt({
    ctx,
    repoRoot,
    runWt,
  });
  if (!records) return;

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

  log.debug("feature-switch target resolved", {
    query,
    repoRoot,
    branch: record.branch,
  });

  log.debug("feature-switch preparing worktree", {
    repoRoot,
    branch: record.branch,
  });

  const switchWorktreeResult = await ensureFeatureWorktree(runWt, {
    branch: record.branch,
    fallbackWorktreePath: record.worktreePath,
  });
  if (!switchWorktreeResult.ok) {
    ctx.ui.notify(switchWorktreeResult.message, "error");
    log.error("wt switch failed", {
      branch: record.branch,
      repoRoot,
      message: switchWorktreeResult.message,
    });
    return;
  }

  const worktreePath = switchWorktreeResult.worktreePath;

  log.debug("feature-switch worktree ready", {
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

  const switchResult = await maybeSwitchToWorktreeSession({
    ctx,
    record: updatedRecord,
    worktreePath: updatedRecord.worktreePath,
    enabled: config.defaults.autoSwitchToWorktreeSession,
  });

  log.debug("feature-switch session result", {
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

  await runIgnoredSync({
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

export default function featureWorkflowExtension(pi: ExtensionAPI): void {
  pi.registerCommand("feature-setup", {
    description:
      "Bootstrap ignored sync defaults + Worktrunk hook/script for this repo",
    handler: async (args, ctx) =>
      runFeatureSetupCommand(ctx, parseCommandArgs(args)),
  });

  pi.registerCommand("feature-start", {
    description: "Create a feature branch + worktree via Worktrunk",
    handler: async (_args, ctx) => runFeatureStartCommand(pi, ctx),
  });

  pi.registerCommand("feature-list", {
    description: "List feature records for this repo",
    handler: async (_args, ctx) => runFeatureListCommand(pi, ctx),
  });

  pi.registerCommand("feature-switch", {
    description: "Prepare switching to an existing feature worktree",
    handler: async (args, ctx) =>
      runFeatureSwitchCommand(pi, ctx, parseCommandArgs(args)),
  });

  pi.registerCommand("feature-validate", {
    description: "Run feature preflight checks",
    handler: async (_args, ctx) => runFeatureValidateCommand(pi, ctx),
  });

  pi.on("session_start", (_event, ctx) => {
    const config = loadFeatureWorkflowConfig(ctx.cwd);
    log.debug("feature-workflow session_start", {
      cwd: ctx.cwd,
      enabled: config.enabled,
    });
    if (!config.enabled) return;
    log.info("feature-workflow enabled", { cwd: ctx.cwd });
  });

  pi.on("session_before_switch", (_event, ctx) => {
    const config = loadFeatureWorkflowConfig(ctx.cwd);
    log.debug("feature-workflow session_before_switch", {
      cwd: ctx.cwd,
      enabled: config.enabled,
    });
  });
}
