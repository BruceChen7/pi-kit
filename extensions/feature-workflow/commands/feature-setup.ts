import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import { DEFAULT_GIT_TIMEOUT_MS, getRepoRoot } from "../../shared/git.js";

import {
  applyFeatureWorkflowSetupProfile,
  DEFAULT_FEATURE_WORKFLOW_SETUP_PROFILE_ID,
  FEATURE_WORKFLOW_RECOMMENDED_WORKTREE_PATH_TEMPLATE,
  FEATURE_WORKFLOW_SETUP_TARGETS,
  FEATURE_WORKFLOW_SETUP_USAGE,
  type FeatureWorkflowSetupProfile,
  type FeatureWorkflowSetupTarget,
  getFeatureWorkflowSetupProfile,
  getFeatureWorkflowSetupTargetMeta,
  getFeatureWorkflowWorktrunkUserConfigStatus,
  listFeatureWorkflowSetupProfiles,
  parseFeatureWorkflowSetupArgs,
  resolveFeatureWorkflowSetupTargets,
} from "../setup.js";

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

export async function runFeatureSetupCommand(
  ctx: ExtensionCommandContext,
  args: string[],
): Promise<void> {
  const parsedArgs = parseFeatureWorkflowSetupArgs(args);
  if (parsedArgs.ok === false) {
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
