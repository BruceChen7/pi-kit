import fs from "node:fs";
import path from "node:path";

import { isErr } from "../shared/result.js";

import {
  DEFAULT_IGNORED_SYNC_HOOK,
  type FeatureWorkflowIgnoredSyncConfig,
  type IgnoredSyncEnsureOnCommand,
  type IgnoredSyncRule,
} from "./config.js";
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

type RuleStatus = "ok" | "missing" | "not-symlink";

type RuleEvaluation = {
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

const trimToNull = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const shouldRunForPhase = (
  mode: FeatureWorkflowIgnoredSyncConfig["mode"],
  phase: IgnoredSyncLifecyclePhase,
): boolean => {
  if (mode === "quick") {
    return phase === "after-session-switch";
  }
  return phase === "before-session-switch";
};

const evaluateRule = (
  worktreePath: string,
  rule: IgnoredSyncRule,
  deps: RunIgnoredSyncDeps,
): RuleEvaluation => {
  const absolutePath = path.isAbsolute(rule.path)
    ? rule.path
    : path.join(worktreePath, rule.path);

  const state = deps.getPathState(absolutePath);
  if (!state.exists) {
    return {
      rule,
      status: "missing",
    };
  }

  if (rule.strategy === "symlink" && !state.isSymlink) {
    return {
      rule,
      status: "not-symlink",
    };
  }

  return {
    rule,
    status: "ok",
  };
};

const formatRuleIssue = (evaluation: RuleEvaluation): string => {
  const issue =
    evaluation.status === "not-symlink"
      ? "exists but is not a symlink"
      : "missing";
  return `${evaluation.rule.path} (${issue})`;
};

const buildActionKey = (rule: IgnoredSyncRule): string => {
  if (rule.onMissing.action === "run-hook") {
    return `hook:${rule.onMissing.hook ?? DEFAULT_IGNORED_SYNC_HOOK}`;
  }
  return "copy-ignored";
};

const maybeWarnLockfileDrift = async (
  input: IgnoredSyncRunInput,
  deps: RunIgnoredSyncDeps,
): Promise<string | null> => {
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
};

export async function runIgnoredSync(
  input: IgnoredSyncRunInput,
  deps: RunIgnoredSyncDeps = defaultDeps,
): Promise<IgnoredSyncRunResult> {
  const notify = (
    message: string,
    level: NotifyLevel,
    force: boolean = false,
  ): void => {
    if (force || input.config.notifications.enabled) {
      input.notify(message, level);
    }
  };

  if (!input.config.enabled) {
    return {
      executed: false,
      blocked: false,
      missingCount: 0,
      unresolvedCount: 0,
      actionCount: 0,
    };
  }

  if (!input.config.ensureOn.includes(input.command)) {
    return {
      executed: false,
      blocked: false,
      missingCount: 0,
      unresolvedCount: 0,
      actionCount: 0,
    };
  }

  if (!shouldRunForPhase(input.config.mode, input.phase)) {
    return {
      executed: false,
      blocked: false,
      missingCount: 0,
      unresolvedCount: 0,
      actionCount: 0,
    };
  }

  const worktreePath = trimToNull(input.worktreePath);
  if (!worktreePath) {
    notify("Ignored sync skipped: missing worktree path.", "warning");
    return {
      executed: true,
      blocked: false,
      missingCount: 0,
      unresolvedCount: 0,
      actionCount: 0,
    };
  }

  const initialEvaluations = input.config.rules.map((rule) =>
    evaluateRule(worktreePath, rule, deps),
  );
  const missingEvaluations = initialEvaluations.filter(
    (evaluation) => evaluation.status !== "ok",
  );

  const actionKeys = new Set<string>();
  const actionSummaries: string[] = [];
  const actionFailures: string[] = [];

  for (const evaluation of missingEvaluations) {
    const key = buildActionKey(evaluation.rule);
    if (actionKeys.has(key)) {
      continue;
    }
    actionKeys.add(key);

    if (evaluation.rule.onMissing.action === "run-hook") {
      const hook = evaluation.rule.onMissing.hook ?? DEFAULT_IGNORED_SYNC_HOOK;
      const hookResult = await deps.runHook(input.runWt, {
        hookType: "pre-start",
        hook,
        branch: input.branch,
      });

      if (isErr(hookResult)) {
        actionFailures.push(`hook ${hook}: ${hookResult.message}`);
      } else {
        actionSummaries.push(`hook ${hook}`);
      }
      continue;
    }

    const copyResult = await deps.runCopyIgnored(input.runWt, {
      toBranch: input.branch,
      timeoutMs: input.config.fallback.copyIgnoredTimeoutMs,
    });

    if (isErr(copyResult)) {
      actionFailures.push(`wt step copy-ignored: ${copyResult.message}`);
    } else {
      actionSummaries.push("wt step copy-ignored");
    }
  }

  const unresolvedEvaluations = input.config.rules
    .map((rule) => evaluateRule(worktreePath, rule, deps))
    .filter((evaluation) => evaluation.status !== "ok");

  const unresolvedRequired = unresolvedEvaluations.filter(
    (evaluation) => evaluation.rule.required,
  );

  const shouldBlock =
    input.config.mode === "strict" &&
    input.config.fallback.onFailure === "block" &&
    unresolvedRequired.length > 0;

  const lockfileWarning = await maybeWarnLockfileDrift(input, deps);

  if (actionSummaries.length > 0) {
    notify(
      `Ignored sync: triggered ${actionSummaries.length} fallback action(s): ${actionSummaries.join(", ")}.`,
      actionFailures.length > 0 ? "warning" : "info",
    );
  }

  if (actionFailures.length > 0) {
    notify(
      `Ignored sync fallback failed: ${actionFailures.join("; ")}`,
      "warning",
    );
  }

  if (unresolvedEvaluations.length > 0) {
    const issueSummary = unresolvedEvaluations
      .map((evaluation) => formatRuleIssue(evaluation))
      .join(", ");

    const level: NotifyLevel =
      unresolvedRequired.length > 0 ? "warning" : "info";
    notify(`Ignored sync unresolved path(s): ${issueSummary}`, level);
  }

  if (lockfileWarning) {
    notify(lockfileWarning, "warning");
  }

  if (
    input.config.notifications.verbose &&
    actionSummaries.length === 0 &&
    actionFailures.length === 0 &&
    unresolvedEvaluations.length === 0 &&
    !lockfileWarning
  ) {
    notify(
      `Ignored sync: all ${input.config.rules.length} rule(s) already satisfied (${input.config.mode} mode).`,
      "info",
    );
  }

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
    actionCount: actionKeys.size,
  };
}
