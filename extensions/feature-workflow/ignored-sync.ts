import fs from "node:fs";
import path from "node:path";

import { isErr } from "../shared/result.js";

import {
  DEFAULT_IGNORED_SYNC_HOOK,
  type FeatureWorkflowIgnoredSyncConfig,
  type IgnoredSyncEnsureOnCommand,
  type IgnoredSyncRule,
} from "./config.js";
import { trimToNull } from "./utils.js";
import {
  resolvePrimaryWorktreePathFromWt,
  runCopyIgnoredToFeatureWorktree,
  runWorktreeHook,
  type WtRunner,
} from "./worktree-gateway.js";

type NotifyLevel = "info" | "warning" | "error";

export type IgnoredSyncLifecyclePhase =
  | "before-session-switch"
  | "after-session-switch";

export type IgnoredSyncRunInput = {
  command: IgnoredSyncEnsureOnCommand;
  phase: IgnoredSyncLifecyclePhase;
  config: FeatureWorkflowIgnoredSyncConfig;
  repoRoot: string;
  worktreePath: string;
  branch: string;
  runWt: WtRunner;
  notify: (message: string, level: NotifyLevel) => void;
};

export type IgnoredSyncRunResult = {
  executed: boolean;
  blocked: boolean;
  missingCount: number;
  unresolvedCount: number;
  actionCount: number;
};

export type RuleStatus = "ok" | "missing" | "not-symlink";

export type RuleEvaluation = {
  rule: IgnoredSyncRule;
  status: RuleStatus;
};

type PathState = {
  exists: boolean;
  isSymlink: boolean;
};

type RunIgnoredSyncDeps = {
  getPathState: (absolutePath: string) => PathState;
  readTextFile: (absolutePath: string) => string | null;
  resolvePrimaryWorktreePath: (
    runWt: WtRunner,
  ) => Promise<{ ok: true; path: string } | { ok: false; message: string }>;
  runHook: (
    runWt: WtRunner,
    input: {
      hookType: string;
      hook?: string | null;
      branch?: string | null;
    },
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  runCopyIgnored: (
    runWt: WtRunner,
    input: {
      toBranch: string;
      fromBranch?: string | null;
      timeoutMs?: number;
    },
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
};

type IgnoredSyncNotifier = (
  message: string,
  level: NotifyLevel,
  force?: boolean,
) => void;

type ExecutedIgnoredSyncActions = {
  actionCount: number;
  actionSummaries: string[];
  actionFailures: string[];
};

const defaultDeps: RunIgnoredSyncDeps = {
  getPathState: (absolutePath: string): PathState => {
    try {
      const stats = fs.lstatSync(absolutePath);
      return {
        exists: true,
        isSymlink: stats.isSymbolicLink(),
      };
    } catch {
      return {
        exists: false,
        isSymlink: false,
      };
    }
  },
  readTextFile: (absolutePath: string): string | null => {
    try {
      return fs.readFileSync(absolutePath, "utf-8");
    } catch {
      return null;
    }
  },
  resolvePrimaryWorktreePath: resolvePrimaryWorktreePathFromWt,
  runHook: runWorktreeHook,
  runCopyIgnored: runCopyIgnoredToFeatureWorktree,
};

function shouldRunForPhase(
  mode: FeatureWorkflowIgnoredSyncConfig["mode"],
  phase: IgnoredSyncLifecyclePhase,
): boolean {
  if (mode === "quick") {
    return phase === "after-session-switch";
  }
  return phase === "before-session-switch";
}

function createNotifier(input: IgnoredSyncRunInput): IgnoredSyncNotifier {
  return (message, level, force = false): void => {
    if (force || input.config.notifications.enabled) {
      input.notify(message, level);
    }
  };
}

function getRuleStatus(
  worktreePath: string,
  rule: IgnoredSyncRule,
  deps: Pick<RunIgnoredSyncDeps, "getPathState">,
): RuleStatus {
  const absolutePath = path.isAbsolute(rule.path)
    ? rule.path
    : path.join(worktreePath, rule.path);
  const state = deps.getPathState(absolutePath);

  if (!state.exists) {
    return "missing";
  }

  if (rule.strategy === "symlink" && !state.isSymlink) {
    return "not-symlink";
  }

  return "ok";
}

export function evaluateIgnoredSyncRules(input: {
  worktreePath: string;
  rules: IgnoredSyncRule[];
  getPathState: (absolutePath: string) => PathState;
}): RuleEvaluation[] {
  return input.rules.map((rule) => ({
    rule,
    status: getRuleStatus(input.worktreePath, rule, {
      getPathState: input.getPathState,
    }),
  }));
}

function formatRuleIssue(evaluation: RuleEvaluation): string {
  const issue =
    evaluation.status === "not-symlink"
      ? "exists but is not a symlink"
      : "missing";
  return `${evaluation.rule.path} (${issue})`;
}

function buildActionKey(rule: IgnoredSyncRule): string {
  if (rule.onMissing.action === "run-hook") {
    return `hook:${rule.onMissing.hook ?? DEFAULT_IGNORED_SYNC_HOOK}`;
  }
  return "copy-ignored";
}

async function executeFallbackActions(input: {
  evaluations: RuleEvaluation[];
  runInput: IgnoredSyncRunInput;
  deps: RunIgnoredSyncDeps;
}): Promise<ExecutedIgnoredSyncActions> {
  const actionKeys = new Set<string>();
  const actionSummaries: string[] = [];
  const actionFailures: string[] = [];

  for (const evaluation of input.evaluations) {
    const key = buildActionKey(evaluation.rule);
    if (actionKeys.has(key)) {
      continue;
    }
    actionKeys.add(key);

    if (evaluation.rule.onMissing.action === "run-hook") {
      const hook = evaluation.rule.onMissing.hook ?? DEFAULT_IGNORED_SYNC_HOOK;
      const hookResult = await input.deps.runHook(input.runInput.runWt, {
        hookType: "pre-start",
        hook,
        branch: input.runInput.branch,
      });

      if (isErr(hookResult)) {
        actionFailures.push(`hook ${hook}: ${hookResult.message}`);
      } else {
        actionSummaries.push(`hook ${hook}`);
      }
      continue;
    }

    const copyResult = await input.deps.runCopyIgnored(input.runInput.runWt, {
      toBranch: input.runInput.branch,
      timeoutMs: input.runInput.config.fallback.copyIgnoredTimeoutMs,
    });

    if (isErr(copyResult)) {
      actionFailures.push(`wt step copy-ignored: ${copyResult.message}`);
    } else {
      actionSummaries.push("wt step copy-ignored");
    }
  }

  return {
    actionCount: actionKeys.size,
    actionSummaries,
    actionFailures,
  };
}

async function maybeWarnLockfileDrift(
  input: IgnoredSyncRunInput,
  deps: RunIgnoredSyncDeps,
): Promise<string | null> {
  const lockfile = input.config.lockfile;
  if (!lockfile.enabled || lockfile.onDrift !== "warn") {
    return null;
  }

  let baselineRoot = input.repoRoot;
  if (lockfile.compareWithPrimary) {
    const primaryPathResult = await deps.resolvePrimaryWorktreePath(
      input.runWt,
    );
    if (isErr(primaryPathResult)) {
      return `Ignored sync: cannot resolve primary worktree for lockfile drift check (${primaryPathResult.message}).`;
    }
    baselineRoot = primaryPathResult.path;
  }

  const baselineLockfilePath = path.join(baselineRoot, lockfile.path);
  const targetLockfilePath = path.join(input.worktreePath, lockfile.path);

  if (path.resolve(baselineLockfilePath) === path.resolve(targetLockfilePath)) {
    return null;
  }

  const baselineLockfile = deps.readTextFile(baselineLockfilePath);
  const targetLockfile = deps.readTextFile(targetLockfilePath);

  if (baselineLockfile === null && targetLockfile === null) {
    return null;
  }

  if (baselineLockfile === targetLockfile) {
    return null;
  }

  return `${lockfile.path} drift detected vs primary worktree. Run npm ci if dependency mismatch.`;
}

function notifyActionSummary(
  notify: IgnoredSyncNotifier,
  actions: ExecutedIgnoredSyncActions,
): void {
  if (actions.actionSummaries.length === 0) {
    return;
  }

  notify(
    `Ignored sync: triggered ${actions.actionSummaries.length} fallback action(s): ${actions.actionSummaries.join(", ")}.`,
    actions.actionFailures.length > 0 ? "warning" : "info",
  );
}

function notifyActionFailures(
  notify: IgnoredSyncNotifier,
  actions: ExecutedIgnoredSyncActions,
): void {
  if (actions.actionFailures.length === 0) {
    return;
  }

  notify(
    `Ignored sync fallback failed: ${actions.actionFailures.join("; ")}`,
    "warning",
  );
}

function notifyUnresolvedRules(input: {
  notify: IgnoredSyncNotifier;
  unresolvedEvaluations: RuleEvaluation[];
  unresolvedRequired: RuleEvaluation[];
}): void {
  if (input.unresolvedEvaluations.length === 0) {
    return;
  }

  const issueSummary = input.unresolvedEvaluations
    .map((evaluation) => formatRuleIssue(evaluation))
    .join(", ");
  const level: NotifyLevel =
    input.unresolvedRequired.length > 0 ? "warning" : "info";

  input.notify(`Ignored sync unresolved path(s): ${issueSummary}`, level);
}

function notifyVerboseSuccess(input: {
  notify: IgnoredSyncNotifier;
  runInput: IgnoredSyncRunInput;
  actions: ExecutedIgnoredSyncActions;
  unresolvedEvaluations: RuleEvaluation[];
  lockfileWarning: string | null;
}): void {
  if (
    !input.runInput.config.notifications.verbose ||
    input.actions.actionSummaries.length > 0 ||
    input.actions.actionFailures.length > 0 ||
    input.unresolvedEvaluations.length > 0 ||
    input.lockfileWarning
  ) {
    return;
  }

  input.notify(
    `Ignored sync: all ${input.runInput.config.rules.length} rule(s) already satisfied (${input.runInput.config.mode} mode).`,
    "info",
  );
}

function buildSkippedResult(): IgnoredSyncRunResult {
  return {
    executed: false,
    blocked: false,
    missingCount: 0,
    unresolvedCount: 0,
    actionCount: 0,
  };
}

function buildMissingWorktreePathResult(): IgnoredSyncRunResult {
  return {
    executed: true,
    blocked: false,
    missingCount: 0,
    unresolvedCount: 0,
    actionCount: 0,
  };
}

export async function runIgnoredSync(
  input: IgnoredSyncRunInput,
  deps: RunIgnoredSyncDeps = defaultDeps,
): Promise<IgnoredSyncRunResult> {
  const notify = createNotifier(input);

  if (!input.config.enabled) {
    return buildSkippedResult();
  }

  if (!input.config.ensureOn.includes(input.command)) {
    return buildSkippedResult();
  }

  if (!shouldRunForPhase(input.config.mode, input.phase)) {
    return buildSkippedResult();
  }

  const worktreePath = trimToNull(input.worktreePath);
  if (!worktreePath) {
    notify("Ignored sync skipped: missing worktree path.", "warning");
    return buildMissingWorktreePathResult();
  }

  const initialEvaluations = evaluateIgnoredSyncRules({
    worktreePath,
    rules: input.config.rules,
    getPathState: deps.getPathState,
  });
  const missingEvaluations = initialEvaluations.filter(
    (evaluation) => evaluation.status !== "ok",
  );
  const actions = await executeFallbackActions({
    evaluations: missingEvaluations,
    runInput: input,
    deps,
  });

  const unresolvedEvaluations = evaluateIgnoredSyncRules({
    worktreePath,
    rules: input.config.rules,
    getPathState: deps.getPathState,
  }).filter((evaluation) => evaluation.status !== "ok");
  const unresolvedRequired = unresolvedEvaluations.filter(
    (evaluation) => evaluation.rule.required,
  );

  const shouldBlock =
    input.config.mode === "strict" &&
    input.config.fallback.onFailure === "block" &&
    unresolvedRequired.length > 0;

  const lockfileWarning = await maybeWarnLockfileDrift(input, deps);

  notifyActionSummary(notify, actions);
  notifyActionFailures(notify, actions);
  notifyUnresolvedRules({
    notify,
    unresolvedEvaluations,
    unresolvedRequired,
  });

  if (lockfileWarning) {
    notify(lockfileWarning, "warning");
  }

  notifyVerboseSuccess({
    notify,
    runInput: input,
    actions,
    unresolvedEvaluations,
    lockfileWarning,
  });

  if (shouldBlock) {
    notify(
      "Ignored sync blocked session switch because required paths are not ready.",
      "error",
      true,
    );
  }

  return {
    executed: true,
    blocked: shouldBlock,
    missingCount: missingEvaluations.length,
    unresolvedCount: unresolvedEvaluations.length,
    actionCount: actions.actionCount,
  };
}
