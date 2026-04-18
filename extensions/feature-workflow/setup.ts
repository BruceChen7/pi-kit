import fs from "node:fs";
import path from "node:path";

import {
  getSettingsPaths,
  readSettingsFile,
  type SettingsRecord,
  writeSettingsFile,
} from "../shared/settings.js";

import {
  DEFAULT_IGNORED_SYNC,
  DEFAULT_IGNORED_SYNC_HOOK,
  type FeatureWorkflowIgnoredSyncConfig,
  type IgnoredSyncEnsureOnCommand,
  type IgnoredSyncRule,
} from "./config.js";

export type FeatureWorkflowSetupTarget =
  | "settings"
  | "gitignore"
  | "worktreeinclude"
  | "hook-script"
  | "wt-toml";

export type FeatureWorkflowSetupProfile = {
  id: string;
  title: string;
  description: string;
  ignoredSyncPreset: FeatureWorkflowIgnoredSyncConfig;
  worktreeIncludeEntries: string[];
  hook: {
    hookType: "pre-start";
    name: string;
    scriptRelativePath: string;
    symlinkPaths: string[];
  };
};

export type FeatureWorkflowSetupCliOptions = {
  profileId: string | null;
  onlyTargets: FeatureWorkflowSetupTarget[] | null;
  skipTargets: FeatureWorkflowSetupTarget[];
  yes: boolean;
};

export type FeatureWorkflowSetupApplyInput = {
  cwd: string;
  repoRoot: string;
  profile: FeatureWorkflowSetupProfile;
  targets: Iterable<FeatureWorkflowSetupTarget>;
};

export type FeatureWorkflowSetupFileChange = {
  target: FeatureWorkflowSetupTarget;
  path: string;
  changed: boolean;
  message: string;
};

export type FeatureWorkflowSetupApplyResult = {
  profileId: string;
  targets: FeatureWorkflowSetupTarget[];
  changes: FeatureWorkflowSetupFileChange[];
  changedCount: number;
};

export type FeatureWorkflowSetupParseResult =
  | { ok: true; value: FeatureWorkflowSetupCliOptions }
  | { ok: false; message: string };

const SETUP_TARGETS: FeatureWorkflowSetupTarget[] = [
  "settings",
  "gitignore",
  "worktreeinclude",
  "hook-script",
  "wt-toml",
];

const SETUP_TARGET_ALIASES: Record<string, FeatureWorkflowSetupTarget> = {
  settings: "settings",
  config: "settings",
  gitignore: "gitignore",
  "git-ignore": "gitignore",
  ignore: "gitignore",
  worktreeinclude: "worktreeinclude",
  "worktree-include": "worktreeinclude",
  include: "worktreeinclude",
  script: "hook-script",
  "hook-script": "hook-script",
  hook: "hook-script",
  wt: "wt-toml",
  "wt-toml": "wt-toml",
  "wt.toml": "wt-toml",
};

const SETUP_TARGET_METADATA: Record<
  FeatureWorkflowSetupTarget,
  { label: string; description: string }
> = {
  settings: {
    label: ".pi/third_extension_settings.json",
    description: "Enable ignoredSync defaults and add missing profile rules.",
  },
  gitignore: {
    label: ".gitignore",
    description: "Ensure .pi/ is ignored for setup-managed artifacts.",
  },
  worktreeinclude: {
    label: ".worktreeinclude",
    description: "Add recommended copy-managed ignored entries.",
  },
  "hook-script": {
    label: ".pi/pi-feature-workflow-links.sh",
    description: "Generate the reusable symlink hook script.",
  },
  "wt-toml": {
    label: ".config/wt.toml",
    description: "Install/update a managed pre-start hook block.",
  },
};

const WORKTREE_INCLUDE_HEADER = [
  "# Files to copy between worktrees (must also be gitignored)",
  "# Used by: wt step copy-ignored",
];

const GITIGNORE_PI_ENTRY = ".pi/";

const WT_TOML_MANAGED_BLOCK_START =
  "# >>> pi-kit feature-workflow setup (managed) >>>";
const WT_TOML_MANAGED_BLOCK_END =
  "# <<< pi-kit feature-workflow setup (managed) <<<";

export const DEFAULT_FEATURE_WORKFLOW_SETUP_PROFILE_ID = "npm";

const cloneRule = (rule: IgnoredSyncRule): IgnoredSyncRule => ({
  ...rule,
  onMissing: {
    ...rule.onMissing,
  },
});

const cloneIgnoredSyncPreset = (
  value: FeatureWorkflowIgnoredSyncConfig,
): FeatureWorkflowIgnoredSyncConfig => ({
  enabled: value.enabled,
  mode: value.mode,
  ensureOn: [...value.ensureOn],
  rules: value.rules.map(cloneRule),
  lockfile: {
    ...value.lockfile,
  },
  fallback: {
    ...value.fallback,
  },
  notifications: {
    ...value.notifications,
  },
});

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
      scriptRelativePath: ".pi/pi-feature-workflow-links.sh",
      symlinkPaths: ["node_modules", ".pi", "AGENTS.md", "CLAUDE.md"],
    },
  },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const trimToNull = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const toRelativeDisplayPath = (
  repoRoot: string,
  absolutePath: string,
): string => {
  const relative = path.relative(repoRoot, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return absolutePath;
  }
  return relative;
};

const uniqueStrings = (values: Iterable<string>): string[] => {
  const deduped: string[] = [];
  for (const value of values) {
    const trimmed = trimToNull(value);
    if (!trimmed || deduped.includes(trimmed)) {
      continue;
    }
    deduped.push(trimmed);
  }
  return deduped;
};

const escapeTomlBasicString = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const quoteShellArg = (value: string): string =>
  `'${value.replace(/'/g, `'"'"'`)}'`;

const cloneProfile = (
  profile: FeatureWorkflowSetupProfile,
): FeatureWorkflowSetupProfile => ({
  id: profile.id,
  title: profile.title,
  description: profile.description,
  ignoredSyncPreset: cloneIgnoredSyncPreset(profile.ignoredSyncPreset),
  worktreeIncludeEntries: [...profile.worktreeIncludeEntries],
  hook: {
    ...profile.hook,
    symlinkPaths: [...profile.hook.symlinkPaths],
  },
});

export const listFeatureWorkflowSetupProfiles =
  (): FeatureWorkflowSetupProfile[] => SETUP_PROFILES.map(cloneProfile);

export const getFeatureWorkflowSetupProfile = (
  profileId: string,
): FeatureWorkflowSetupProfile | null => {
  const normalized = trimToNull(profileId);
  if (!normalized) {
    return null;
  }

  const profile = SETUP_PROFILES.find(
    (item) => item.id.toLowerCase() === normalized.toLowerCase(),
  );

  return profile ? cloneProfile(profile) : null;
};

export const getFeatureWorkflowSetupTargetMeta = (
  target: FeatureWorkflowSetupTarget,
): { label: string; description: string } => ({
  ...SETUP_TARGET_METADATA[target],
});

const parseTargetList = (
  raw: string,
):
  | { ok: true; targets: FeatureWorkflowSetupTarget[] }
  | { ok: false; message: string } => {
  const values = uniqueStrings(
    raw.split(",").map((entry) => entry.toLowerCase()),
  );
  const targets: FeatureWorkflowSetupTarget[] = [];

  for (const value of values) {
    const target = SETUP_TARGET_ALIASES[value];
    if (!target) {
      return {
        ok: false,
        message: `Unknown target '${value}'. Supported targets: settings, gitignore, worktreeinclude, hook-script, wt-toml.`,
      };
    }
    if (!targets.includes(target)) {
      targets.push(target);
    }
  }

  return {
    ok: true,
    targets,
  };
};

const parseOptionValue = (
  token: string,
  args: string[],
  index: number,
):
  | { ok: true; value: string; consumed: number }
  | { ok: false; message: string } => {
  const equalsIndex = token.indexOf("=");
  if (equalsIndex >= 0) {
    const inlineValue = token.slice(equalsIndex + 1).trim();
    if (!inlineValue) {
      return {
        ok: false,
        message: `Missing value for option '${token.slice(0, equalsIndex)}'.`,
      };
    }
    return { ok: true, value: inlineValue, consumed: 1 };
  }

  const next = trimToNull(args[index + 1]);
  if (!next) {
    return {
      ok: false,
      message: `Missing value for option '${token}'.`,
    };
  }

  return {
    ok: true,
    value: next,
    consumed: 2,
  };
};

export const parseFeatureWorkflowSetupArgs = (
  args: string[],
): FeatureWorkflowSetupParseResult => {
  let profileId: string | null = null;
  let onlyTargets: FeatureWorkflowSetupTarget[] | null = null;
  const skipTargets: FeatureWorkflowSetupTarget[] = [];
  let yes = false;

  for (let index = 0; index < args.length; ) {
    const token = trimToNull(args[index]);
    if (!token) {
      index += 1;
      continue;
    }

    if (token === "--yes") {
      yes = true;
      index += 1;
      continue;
    }

    if (token === "--profile" || token.startsWith("--profile=")) {
      const parsedValue = parseOptionValue(token, args, index);
      if (!parsedValue.ok) {
        return parsedValue;
      }
      profileId = parsedValue.value;
      index += parsedValue.consumed;
      continue;
    }

    if (token === "--only" || token.startsWith("--only=")) {
      const parsedValue = parseOptionValue(token, args, index);
      if (!parsedValue.ok) {
        return parsedValue;
      }

      const parsedTargets = parseTargetList(parsedValue.value);
      if (!parsedTargets.ok) {
        return parsedTargets;
      }

      onlyTargets = parsedTargets.targets;
      index += parsedValue.consumed;
      continue;
    }

    if (token === "--skip" || token.startsWith("--skip=")) {
      const parsedValue = parseOptionValue(token, args, index);
      if (!parsedValue.ok) {
        return parsedValue;
      }

      const parsedTargets = parseTargetList(parsedValue.value);
      if (!parsedTargets.ok) {
        return parsedTargets;
      }

      for (const target of parsedTargets.targets) {
        if (!skipTargets.includes(target)) {
          skipTargets.push(target);
        }
      }

      index += parsedValue.consumed;
      continue;
    }

    if (token.startsWith("--")) {
      return {
        ok: false,
        message: `Unknown option '${token}'.`,
      };
    }

    if (profileId) {
      return {
        ok: false,
        message: `Unexpected extra argument '${token}'. Profile is already '${profileId}'.`,
      };
    }

    profileId = token;
    index += 1;
  }

  return {
    ok: true,
    value: {
      profileId,
      onlyTargets,
      skipTargets,
      yes,
    },
  };
};

export const resolveFeatureWorkflowSetupTargets = (
  options: Pick<FeatureWorkflowSetupCliOptions, "onlyTargets" | "skipTargets">,
): FeatureWorkflowSetupTarget[] => {
  const seed = options.onlyTargets ?? SETUP_TARGETS;
  const selected = new Set<FeatureWorkflowSetupTarget>(seed);
  for (const target of options.skipTargets) {
    selected.delete(target);
  }

  if (selected.has("wt-toml")) {
    selected.add("hook-script");
  }

  if (selected.has("hook-script")) {
    selected.add("gitignore");
  }

  return SETUP_TARGETS.filter((target) => selected.has(target));
};

const serializeSettings = (value: SettingsRecord): string =>
  JSON.stringify(value, null, 2);

const mergeEnsureOn = (
  existingValue: unknown,
  presetValue: IgnoredSyncEnsureOnCommand[],
): IgnoredSyncEnsureOnCommand[] => {
  const deduped: IgnoredSyncEnsureOnCommand[] = [];

  if (Array.isArray(existingValue)) {
    for (const item of existingValue) {
      if (
        (item === "feature-start" || item === "feature-switch") &&
        !deduped.includes(item)
      ) {
        deduped.push(item);
      }
    }
  }

  for (const item of presetValue) {
    if (!deduped.includes(item)) {
      deduped.push(item);
    }
  }

  return deduped.length > 0 ? deduped : [...presetValue];
};

const mergeRules = (
  existingValue: unknown,
  presetRules: IgnoredSyncRule[],
): Record<string, unknown>[] => {
  const existingRules: Record<string, unknown>[] = [];
  const seenPaths = new Set<string>();

  if (Array.isArray(existingValue)) {
    for (const item of existingValue) {
      if (!isRecord(item)) {
        continue;
      }

      const rulePath = trimToNull(item.path);
      if (!rulePath || seenPaths.has(rulePath)) {
        continue;
      }

      seenPaths.add(rulePath);
      existingRules.push({
        ...item,
        path: rulePath,
      });
    }
  }

  for (const presetRule of presetRules) {
    if (seenPaths.has(presetRule.path)) {
      continue;
    }

    seenPaths.add(presetRule.path);
    existingRules.push({
      path: presetRule.path,
      strategy: presetRule.strategy,
      required: presetRule.required,
      onMissing: {
        action: presetRule.onMissing.action,
        hook: presetRule.onMissing.hook,
      },
    });
  }

  return existingRules;
};

const mergeRecordWithPreset = (
  existingValue: unknown,
  presetValue: Record<string, unknown>,
): Record<string, unknown> => {
  if (!isRecord(existingValue)) {
    return {
      ...presetValue,
    };
  }

  return {
    ...presetValue,
    ...existingValue,
  };
};

const mergeSettingsWithProfile = (
  settings: SettingsRecord,
  profile: FeatureWorkflowSetupProfile,
): SettingsRecord => {
  const nextSettings: SettingsRecord = {
    ...settings,
  };

  const featureWorkflow = isRecord(nextSettings.featureWorkflow)
    ? ({ ...nextSettings.featureWorkflow } as Record<string, unknown>)
    : {};

  if (typeof featureWorkflow.enabled !== "boolean") {
    featureWorkflow.enabled = true;
  }

  const ignoredSync = isRecord(featureWorkflow.ignoredSync)
    ? ({ ...featureWorkflow.ignoredSync } as Record<string, unknown>)
    : {};

  ignoredSync.enabled = true;
  ignoredSync.mode =
    typeof ignoredSync.mode === "string"
      ? ignoredSync.mode
      : profile.ignoredSyncPreset.mode;
  ignoredSync.ensureOn = mergeEnsureOn(
    ignoredSync.ensureOn,
    profile.ignoredSyncPreset.ensureOn,
  );
  ignoredSync.rules = mergeRules(
    ignoredSync.rules,
    profile.ignoredSyncPreset.rules,
  );
  ignoredSync.lockfile = mergeRecordWithPreset(
    ignoredSync.lockfile,
    profile.ignoredSyncPreset.lockfile as Record<string, unknown>,
  );
  ignoredSync.fallback = mergeRecordWithPreset(
    ignoredSync.fallback,
    profile.ignoredSyncPreset.fallback as Record<string, unknown>,
  );
  ignoredSync.notifications = mergeRecordWithPreset(
    ignoredSync.notifications,
    profile.ignoredSyncPreset.notifications as Record<string, unknown>,
  );

  featureWorkflow.ignoredSync = ignoredSync;
  nextSettings.featureWorkflow = featureWorkflow;
  return nextSettings;
};

const buildWorktreeIncludeContent = (
  existingContent: string | null,
  requiredEntries: string[],
): { content: string; changed: boolean; addedEntries: string[] } => {
  if (existingContent === null) {
    const lines = [...WORKTREE_INCLUDE_HEADER, "", ...requiredEntries];
    return {
      content: `${lines.join("\n")}\n`,
      changed: true,
      addedEntries: [...requiredEntries],
    };
  }

  const lines = existingContent.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const existingEntries = new Set<string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    existingEntries.add(trimmed);
  }

  const missing = requiredEntries.filter(
    (entry) => !existingEntries.has(entry),
  );
  if (missing.length === 0) {
    return {
      content: existingContent,
      changed: false,
      addedEntries: [],
    };
  }

  const next = [...lines];
  if (next.length > 0 && next[next.length - 1] !== "") {
    next.push("");
  }
  next.push(...missing);

  return {
    content: `${next.join("\n")}\n`,
    changed: true,
    addedEntries: missing,
  };
};

const normalizeGitignoreEntry = (value: string): string =>
  value.trim().replace(/\/+$/, "");

const buildGitignoreContent = (
  existingContent: string | null,
): { content: string; changed: boolean; addedEntry: boolean } => {
  const lines = existingContent === null ? [] : existingContent.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const hasPiEntry = lines.some((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return false;
    }

    return normalizeGitignoreEntry(trimmed) === ".pi";
  });

  if (hasPiEntry) {
    return {
      content: existingContent ?? "",
      changed: false,
      addedEntry: false,
    };
  }

  const next = [...lines];
  if (next.length > 0 && next[next.length - 1] !== "") {
    next.push("");
  }
  next.push(GITIGNORE_PI_ENTRY);

  return {
    content: `${next.join("\n")}\n`,
    changed: true,
    addedEntry: true,
  };
};

const buildSymlinkHookScript = (symlinkPaths: string[]): string => {
  const paths = uniqueStrings(symlinkPaths);
  const lines: string[] = [
    "#!/bin/sh",
    "set -eu",
    "",
    "# Generated by /feature-setup (pi-kit feature-workflow)",
    'PRIMARY_WORKTREE_PATH="$1"',
    'if [ -z "$PRIMARY_WORKTREE_PATH" ]; then',
    '  echo "[feature-workflow] skip: missing primary worktree path"',
    "  exit 0",
    "fi",
    "",
    "link_shared_path() {",
    '  relative_path="$1"',
    '  source_path="$PRIMARY_WORKTREE_PATH/$relative_path"',
    '  target_path="$relative_path"',
    "",
    '  if [ ! -e "$source_path" ] && [ ! -L "$source_path" ]; then',
    "    return",
    "  fi",
    "",
    '  if [ -L "$target_path" ]; then',
    '    ln -sfn "$source_path" "$target_path"',
    "    return",
    "  fi",
    "",
    '  if [ ! -e "$target_path" ]; then',
    '    ln -s "$source_path" "$target_path"',
    "    return",
    "  fi",
    "",
    '  echo "[feature-workflow] skip: ./$target_path exists and is not a symlink"',
    "}",
    "",
  ];

  for (const symlinkPath of paths) {
    lines.push(`link_shared_path ${quoteShellArg(symlinkPath)}`);
  }

  return `${lines.join("\n")}\n`;
};

const buildManagedWtTomlBlock = (
  profile: FeatureWorkflowSetupProfile,
): string => {
  const command = `bash ${profile.hook.scriptRelativePath} '{{ primary_worktree_path }}'`;
  const escapedKey = escapeTomlBasicString(profile.hook.name);
  const escapedCommand = escapeTomlBasicString(command);

  return [
    WT_TOML_MANAGED_BLOCK_START,
    "[pre-start]",
    `"${escapedKey}" = "${escapedCommand}"`,
    WT_TOML_MANAGED_BLOCK_END,
  ].join("\n");
};

const upsertManagedWtTomlBlock = (
  existingContent: string | null,
  profile: FeatureWorkflowSetupProfile,
): { content: string; changed: boolean } => {
  const nextBlock = buildManagedWtTomlBlock(profile);
  const source = existingContent ?? "";
  const startIndex = source.indexOf(WT_TOML_MANAGED_BLOCK_START);
  const endIndex = source.indexOf(WT_TOML_MANAGED_BLOCK_END);

  if (startIndex >= 0 && endIndex > startIndex) {
    const replacementEnd = endIndex + WT_TOML_MANAGED_BLOCK_END.length;
    const nextContent =
      source.slice(0, startIndex) + nextBlock + source.slice(replacementEnd);
    return {
      content: nextContent,
      changed: nextContent !== source,
    };
  }

  const prefix = source.trimEnd();
  const withSpacing =
    prefix.length > 0 ? `${prefix}\n\n${nextBlock}\n` : `${nextBlock}\n`;
  return {
    content: withSpacing,
    changed: withSpacing !== source,
  };
};

const writeFileIfChanged = (absolutePath: string, content: string): boolean => {
  const existing = fs.existsSync(absolutePath)
    ? fs.readFileSync(absolutePath, "utf-8")
    : null;

  if (existing === content) {
    return false;
  }

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, "utf-8");
  return true;
};

export const applyFeatureWorkflowSetupProfile = (
  input: FeatureWorkflowSetupApplyInput,
): FeatureWorkflowSetupApplyResult => {
  const targets = resolveFeatureWorkflowSetupTargets({
    onlyTargets: uniqueStrings(input.targets) as FeatureWorkflowSetupTarget[],
    skipTargets: [],
  });

  const changes: FeatureWorkflowSetupFileChange[] = [];

  if (targets.includes("settings")) {
    const { projectPath } = getSettingsPaths(input.cwd);
    const currentSettings = readSettingsFile(projectPath);
    const nextSettings = mergeSettingsWithProfile(
      currentSettings,
      input.profile,
    );

    const changed =
      serializeSettings(currentSettings) !== serializeSettings(nextSettings);

    if (changed) {
      writeSettingsFile(projectPath, nextSettings);
    }

    changes.push({
      target: "settings",
      path: toRelativeDisplayPath(input.repoRoot, projectPath),
      changed,
      message: changed
        ? "Updated featureWorkflow ignored sync settings"
        : "Settings already contain the required profile defaults",
    });
  }

  if (targets.includes("gitignore")) {
    const gitignorePath = path.join(input.repoRoot, ".gitignore");
    const existingContent = fs.existsSync(gitignorePath)
      ? fs.readFileSync(gitignorePath, "utf-8")
      : null;

    const merged = buildGitignoreContent(existingContent);
    if (merged.changed) {
      fs.mkdirSync(path.dirname(gitignorePath), { recursive: true });
      fs.writeFileSync(gitignorePath, merged.content, "utf-8");
    }

    changes.push({
      target: "gitignore",
      path: toRelativeDisplayPath(input.repoRoot, gitignorePath),
      changed: merged.changed,
      message: merged.addedEntry
        ? `Added '${GITIGNORE_PI_ENTRY}' to .gitignore`
        : `'.pi/' is already present in .gitignore`,
    });
  }

  if (targets.includes("worktreeinclude")) {
    const worktreeIncludePath = path.join(input.repoRoot, ".worktreeinclude");
    const existingContent = fs.existsSync(worktreeIncludePath)
      ? fs.readFileSync(worktreeIncludePath, "utf-8")
      : null;

    const merged = buildWorktreeIncludeContent(
      existingContent,
      input.profile.worktreeIncludeEntries,
    );

    if (merged.changed) {
      fs.mkdirSync(path.dirname(worktreeIncludePath), { recursive: true });
      fs.writeFileSync(worktreeIncludePath, merged.content, "utf-8");
    }

    changes.push({
      target: "worktreeinclude",
      path: toRelativeDisplayPath(input.repoRoot, worktreeIncludePath),
      changed: merged.changed,
      message:
        merged.addedEntries.length > 0
          ? `Added entries: ${merged.addedEntries.join(", ")}`
          : "All profile entries already present",
    });
  }

  if (targets.includes("hook-script")) {
    const scriptPath = path.join(
      input.repoRoot,
      input.profile.hook.scriptRelativePath,
    );
    const scriptContent = buildSymlinkHookScript(
      input.profile.hook.symlinkPaths,
    );
    const changed = writeFileIfChanged(scriptPath, scriptContent);

    if (fs.existsSync(scriptPath)) {
      fs.chmodSync(scriptPath, 0o755);
    }

    changes.push({
      target: "hook-script",
      path: toRelativeDisplayPath(input.repoRoot, scriptPath),
      changed,
      message: changed
        ? `Hook script updated for: ${uniqueStrings(input.profile.hook.symlinkPaths).join(", ")}`
        : "Hook script already up to date",
    });
  }

  if (targets.includes("wt-toml")) {
    const wtTomlPath = path.join(input.repoRoot, ".config", "wt.toml");
    const existingContent = fs.existsSync(wtTomlPath)
      ? fs.readFileSync(wtTomlPath, "utf-8")
      : null;

    const merged = upsertManagedWtTomlBlock(existingContent, input.profile);
    if (merged.changed) {
      fs.mkdirSync(path.dirname(wtTomlPath), { recursive: true });
      fs.writeFileSync(wtTomlPath, merged.content, "utf-8");
    }

    changes.push({
      target: "wt-toml",
      path: toRelativeDisplayPath(input.repoRoot, wtTomlPath),
      changed: merged.changed,
      message: merged.changed
        ? `Managed hook '${input.profile.hook.name}' installed/updated`
        : "Managed hook block already up to date",
    });
  }

  return {
    profileId: input.profile.id,
    targets,
    changes,
    changedCount: changes.filter((change) => change.changed).length,
  };
};

export const formatFeatureWorkflowSetupResult = (
  result: FeatureWorkflowSetupApplyResult,
): string => {
  const lines: string[] = [];
  lines.push(`# Feature workflow setup (${result.profileId})`);
  lines.push("");
  lines.push(`- targets: ${result.targets.join(", ") || "none"}`);
  lines.push(`- changed files: ${result.changedCount}`);
  lines.push("");
  lines.push("## Changes");

  for (const change of result.changes) {
    const status = change.changed ? "updated" : "unchanged";
    lines.push(`- [${status}] ${change.path}`);
    lines.push(`  - ${change.message}`);
  }

  lines.push("");
  lines.push("## Next");
  lines.push(
    "- Run `/feature-start` or `/feature-switch` to verify ignored sync behavior.",
  );

  return `${lines.join("\n")}\n`;
};

export const FEATURE_WORKFLOW_SETUP_USAGE =
  "Usage: /feature-setup [profile] [--only=<targets>] [--skip=<targets>] [--yes]";

export const FEATURE_WORKFLOW_SETUP_TARGETS = [...SETUP_TARGETS];
