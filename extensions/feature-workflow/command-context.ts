import {
  createRepoGitRunner,
  DEFAULT_GIT_TIMEOUT_MS,
  type GitRunner,
  getRepoRoot,
} from "../shared/git.js";

import {
  type FeatureWorkflowConfig,
  loadFeatureWorkflowConfig,
} from "./config.js";

type NotifyLevel = "info" | "warning" | "error";

type CommandUI = {
  notify: (message: string, level: NotifyLevel) => void;
};

type ResolveFeatureWorkflowCommandContextInput = {
  cwd: string;
  ui: CommandUI;
};

export type ResolvedFeatureWorkflowCommandContext = {
  config: FeatureWorkflowConfig;
  timeoutMs: number;
  repoRoot: string;
  runGit: GitRunner;
};

type ResolveFeatureWorkflowCommandContextDeps = {
  loadConfig: (cwd: string) => FeatureWorkflowConfig;
  getRepoRoot: (cwd: string, timeoutMs: number) => string | null;
  createRunGit: (repoRoot: string, timeoutMs: number) => GitRunner;
};

const defaultDeps: ResolveFeatureWorkflowCommandContextDeps = {
  loadConfig: loadFeatureWorkflowConfig,
  getRepoRoot,
  createRunGit: createRepoGitRunner,
};

export function resolveFeatureWorkflowCommandContext(
  input: ResolveFeatureWorkflowCommandContextInput,
  deps: ResolveFeatureWorkflowCommandContextDeps = defaultDeps,
): ResolvedFeatureWorkflowCommandContext | null {
  const config = deps.loadConfig(input.cwd);
  if (!config.enabled) {
    input.ui.notify("feature-workflow is disabled", "info");
    return null;
  }

  const timeoutMs = config.defaults.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const repoRoot = deps.getRepoRoot(input.cwd, timeoutMs);
  if (!repoRoot) {
    input.ui.notify("Not a git repository", "info");
    return null;
  }

  return {
    config,
    timeoutMs,
    repoRoot,
    runGit: deps.createRunGit(repoRoot, timeoutMs),
  };
}
