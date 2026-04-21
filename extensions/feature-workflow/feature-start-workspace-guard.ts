import type { DirtySummary } from "../shared/git.js";

import { areOnlyFeatureSetupManagedDirtyPaths } from "./setup-dirty-guard.js";

export type FeatureStartWorkspaceGuardResult = {
  allow: boolean;
  notifyLevel?: string;
  notifyMessage?: string;
};

export const evaluateFeatureStartWorkspace = ({
  summary,
  dirtyPaths,
}: {
  summary: DirtySummary;
  dirtyPaths: string[];
}): FeatureStartWorkspaceGuardResult => {
  if (!summary.dirty) {
    return { allow: true };
  }

  if (areOnlyFeatureSetupManagedDirtyPaths(dirtyPaths)) {
    return {
      allow: true,
      notifyLevel: "info",
      notifyMessage: `Workspace has only /feature-setup managed changes (${dirtyPaths.join(", ")}). Continuing /feature-start.`,
    };
  }

  const hasTrackedChanges = summary.staged > 0 || summary.unstaged > 0;
  if (!hasTrackedChanges && summary.untracked > 0 && dirtyPaths.length > 0) {
    return {
      allow: true,
      notifyLevel: "info",
      notifyMessage: `Workspace has only untracked files (${dirtyPaths.join(", ")}). Continuing /feature-start.`,
    };
  }

  return {
    allow: false,
    notifyLevel: "warning",
    notifyMessage: `Repository is dirty (staged ${summary.staged}, unstaged ${summary.unstaged}, untracked ${summary.untracked}). Commit/stash first.`,
  };
};
