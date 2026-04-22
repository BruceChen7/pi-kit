import {
  DEFAULT_IGNORED_SYNC,
  DEFAULT_IGNORED_SYNC_HOOK,
  type FeatureWorkflowIgnoredSyncConfig,
} from "../config.js";
import {
  cloneIgnoredSyncPreset,
  type FeatureWorkflowSetupProfile,
  HOME_HOOK_SCRIPT_PATH,
} from "./shared.js";

const buildNpmIgnoredSyncPreset = (): FeatureWorkflowIgnoredSyncConfig => ({
  ...cloneIgnoredSyncPreset(DEFAULT_IGNORED_SYNC),
  lockfile: {
    enabled: true,
    path: "package-lock.json",
    compareWithPrimary: true,
    onDrift: "warn",
  },
});

const SETUP_PROFILES: FeatureWorkflowSetupProfile[] = [
  {
    id: "npm",
    title: "npm",
    description:
      "Symlink node_modules + .pi + AGENTS.md + CLAUDE.md from primary worktree, warn on package-lock drift.",
    ignoredSyncPreset: buildNpmIgnoredSyncPreset(),
    worktreeIncludeEntries: [".env", ".env.local", ".next/cache/", ".turbo/"],
    hook: {
      hookType: "pre-start",
      name: DEFAULT_IGNORED_SYNC_HOOK,
      scriptRelativePath: HOME_HOOK_SCRIPT_PATH,
      symlinkPaths: ["node_modules", ".pi", "AGENTS.md", "CLAUDE.md"],
    },
  },
];

function cloneProfile(
  profile: FeatureWorkflowSetupProfile,
): FeatureWorkflowSetupProfile {
  return {
    id: profile.id,
    title: profile.title,
    description: profile.description,
    ignoredSyncPreset: cloneIgnoredSyncPreset(profile.ignoredSyncPreset),
    worktreeIncludeEntries: [...profile.worktreeIncludeEntries],
    hook: {
      ...profile.hook,
      symlinkPaths: [...profile.hook.symlinkPaths],
    },
  };
}

export const listFeatureWorkflowSetupProfiles =
  (): FeatureWorkflowSetupProfile[] => SETUP_PROFILES.map(cloneProfile);

export function getFeatureWorkflowSetupProfile(
  profileId: string,
): FeatureWorkflowSetupProfile | null {
  const normalized = profileId.trim();
  if (!normalized) {
    return null;
  }

  const profile = SETUP_PROFILES.find(
    (item) => item.id.toLowerCase() === normalized.toLowerCase(),
  );

  return profile ? cloneProfile(profile) : null;
}
