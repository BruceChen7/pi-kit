import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { clearSettingsCache } from "../shared/settings.js";

import {
  applyFeatureWorkflowSetupProfile,
  FEATURE_WORKFLOW_RECOMMENDED_WORKTREE_PATH_TEMPLATE,
  FEATURE_WORKFLOW_SETUP_TARGETS,
  FEATURE_WORKFLOW_WT_TOML_PATH,
  getFeatureWorkflowSetupMissingFiles,
  getFeatureWorkflowSetupProfile,
  getFeatureWorkflowWorktrunkUserConfigPath,
  getFeatureWorkflowWorktrunkUserConfigStatus,
  parseFeatureWorkflowSetupArgs,
  resolveFeatureWorkflowSetupTargets,
} from "./setup.js";

const tempDirs: string[] = [];

const registerTempDir = (dir: string): string => {
  tempDirs.push(dir);
  return dir;
};

const createTempDir = (prefix: string): string =>
  registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

afterEach(() => {
  clearSettingsCache();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("feature-workflow setup args", () => {
  it("parses profile and target options", () => {
    const parsed = parseFeatureWorkflowSetupArgs([
      "npm",
      "--only=settings,wt",
      "--skip=settings",
      "--yes",
    ]);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.value.profileId).toBe("npm");
    expect(parsed.value.onlyTargets).toEqual(["settings", "wt-toml"]);
    expect(parsed.value.skipTargets).toEqual(["settings"]);
    expect(parsed.value.yes).toBe(true);

    expect(resolveFeatureWorkflowSetupTargets(parsed.value)).toEqual([
      "gitignore",
      "hook-script",
      "wt-toml",
    ]);
  });

  it("returns error for unknown target", () => {
    const parsed = parseFeatureWorkflowSetupArgs(["--only", "settings,wat"]);

    expect(parsed).toEqual({
      ok: false,
      message:
        "Unknown target 'wat'. Supported targets: settings, gitignore, worktreeinclude, hook-script, wt-toml, wt-user-config.",
    });
  });

  it("returns error when option value is missing", () => {
    const parsed = parseFeatureWorkflowSetupArgs(["--profile"]);

    expect(parsed).toEqual({
      ok: false,
      message: "Missing value for option '--profile'.",
    });
  });

  it("returns error when inline option value is empty", () => {
    const parsed = parseFeatureWorkflowSetupArgs(["--only="]);

    expect(parsed).toEqual({
      ok: false,
      message: "Missing value for option '--only'.",
    });
  });
});

describe("applyFeatureWorkflowSetupProfile", () => {
  it("writes recommended files and is idempotent", () => {
    const repoRoot = createTempDir("pi-kit-feature-setup-");
    const userHomePath = createTempDir("pi-kit-feature-setup-home-");
    const profile = getFeatureWorkflowSetupProfile("npm");
    expect(profile).not.toBeNull();
    if (!profile) return;

    const first = applyFeatureWorkflowSetupProfile({
      cwd: repoRoot,
      repoRoot,
      profile,
      targets: FEATURE_WORKFLOW_SETUP_TARGETS,
      userHomePath,
    });

    expect(first.changedCount).toBe(6);

    const settingsPath = path.join(
      repoRoot,
      ".pi",
      "third_extension_settings.json",
    );
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as {
      featureWorkflow: {
        ignoredSync: {
          enabled: boolean;
          rules: Array<{ path: string }>;
        };
      };
    };

    expect(settings.featureWorkflow.ignoredSync.enabled).toBe(true);
    expect(
      settings.featureWorkflow.ignoredSync.rules.map((rule) => rule.path),
    ).toEqual(
      expect.arrayContaining(["node_modules", ".pi", "AGENTS.md", "CLAUDE.md"]),
    );

    const scriptPath = path.join(
      userHomePath,
      ".pi",
      "pi-feature-workflow-links.sh",
    );
    const scriptContent = fs.readFileSync(scriptPath, "utf-8");
    expect(scriptContent).toContain("link_shared_path 'node_modules'");
    expect(scriptContent).toContain("link_shared_path '.pi'");
    expect(scriptContent).toContain("link_shared_path 'AGENTS.md'");
    expect(scriptContent).toContain("link_shared_path 'CLAUDE.md'");

    const wtTomlPath = path.join(repoRoot, ".config", "wt.toml");
    const wtToml = fs.readFileSync(wtTomlPath, "utf-8");
    expect(wtToml).toContain("[pre-start]");
    expect(wtToml).toContain("[post-start]");
    expect(wtToml).not.toContain("[[pre-start]]");
    expect(wtToml).toContain('"project-deps-link"');
    expect(wtToml).toContain('"project-copy-ignored" = "wt step copy-ignored"');
    expect(wtToml).toContain(
      'bash \\"$HOME/.pi/pi-feature-workflow-links.sh\\"',
    );
    expect(wtToml).not.toContain("bash .pi/pi-feature-workflow-links.sh");

    const worktrunkUserConfigPath =
      getFeatureWorkflowWorktrunkUserConfigPath(userHomePath);
    const worktrunkUserConfig = fs.readFileSync(
      worktrunkUserConfigPath,
      "utf-8",
    );
    expect(worktrunkUserConfig).toContain(
      `worktree-path = "${FEATURE_WORKFLOW_RECOMMENDED_WORKTREE_PATH_TEMPLATE}"`,
    );
    expect(
      getFeatureWorkflowWorktrunkUserConfigStatus({ userHomePath }),
    ).toEqual({
      path: worktrunkUserConfigPath,
      currentTemplate: FEATURE_WORKFLOW_RECOMMENDED_WORKTREE_PATH_TEMPLATE,
      needsUpdate: false,
    });

    const gitignorePath = path.join(repoRoot, ".gitignore");
    const gitignore = fs.readFileSync(gitignorePath, "utf-8");
    expect(gitignore).toContain(".pi/");
    expect(gitignore).toContain(".config/wt.toml");
    expect(gitignore).toContain(".worktreeinclude");

    const worktreeIncludePath = path.join(repoRoot, ".worktreeinclude");
    const worktreeInclude = fs.readFileSync(worktreeIncludePath, "utf-8");
    expect(worktreeInclude).toContain(".env");
    expect(worktreeInclude).toContain(".env.local");

    const second = applyFeatureWorkflowSetupProfile({
      cwd: repoRoot,
      repoRoot,
      profile,
      targets: FEATURE_WORKFLOW_SETUP_TARGETS,
      userHomePath,
    });

    expect(second.changedCount).toBe(0);
    expect(second.changes.every((change) => !change.changed)).toBe(true);
  });

  it("treats existing gitignore variants as already satisfied", () => {
    const repoRoot = createTempDir("pi-kit-feature-setup-gitignore-variants-");
    const profile = getFeatureWorkflowSetupProfile("npm");
    expect(profile).not.toBeNull();
    if (!profile) return;

    const gitignorePath = path.join(repoRoot, ".gitignore");
    fs.writeFileSync(
      gitignorePath,
      [".pi", "/.config/wt.toml", ".worktreeinclude", ""].join("\n"),
    );

    const result = applyFeatureWorkflowSetupProfile({
      cwd: repoRoot,
      repoRoot,
      profile,
      targets: ["gitignore"],
    });

    expect(result.changedCount).toBe(0);
    expect(fs.readFileSync(gitignorePath, "utf-8")).toBe(
      [".pi", "/.config/wt.toml", ".worktreeinclude", ""].join("\n"),
    );
  });

  it("recreates missing wt.toml while leaving existing gitignore entries unchanged", () => {
    const repoRoot = createTempDir("pi-kit-feature-setup-recreate-wt-toml-");
    const userHomePath = createTempDir("pi-kit-feature-setup-recreate-home-");
    const profile = getFeatureWorkflowSetupProfile("npm");
    expect(profile).not.toBeNull();
    if (!profile) return;

    fs.writeFileSync(
      path.join(repoRoot, ".gitignore"),
      [".pi/", ".config/wt.toml", ".worktreeinclude", ""].join("\n"),
    );

    const result = applyFeatureWorkflowSetupProfile({
      cwd: repoRoot,
      repoRoot,
      profile,
      targets: ["gitignore", "wt-toml"],
      userHomePath,
    });

    expect(result.changedCount).toBe(2);
    expect(
      result.changes.find((change) => change.target === "gitignore")?.changed,
    ).toBe(false);
    expect(
      result.changes.find((change) => change.target === "wt-toml")?.changed,
    ).toBe(true);
    expect(fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf-8")).toBe(
      [".pi/", ".config/wt.toml", ".worktreeinclude", ""].join("\n"),
    );

    const wtToml = fs.readFileSync(
      path.join(repoRoot, FEATURE_WORKFLOW_WT_TOML_PATH),
      "utf-8",
    );
    expect(wtToml).toContain("[pre-start]");
    expect(wtToml).toContain("[post-start]");
    expect(wtToml).toContain('"project-deps-link"');
    expect(wtToml).toContain('"project-copy-ignored" = "wt step copy-ignored"');
  });

  it("reports missing local wt.toml setup file", () => {
    const repoRoot = createTempDir("pi-kit-feature-setup-missing-files-");

    expect(getFeatureWorkflowSetupMissingFiles(repoRoot)).toEqual([
      FEATURE_WORKFLOW_WT_TOML_PATH,
    ]);

    fs.mkdirSync(path.join(repoRoot, ".config"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, FEATURE_WORKFLOW_WT_TOML_PATH),
      "",
      "utf-8",
    );

    expect(getFeatureWorkflowSetupMissingFiles(repoRoot)).toEqual([]);
  });

  it("removes .pi entries from .worktreeinclude", () => {
    const repoRoot = createTempDir("pi-kit-feature-setup-worktreeinclude-");
    const profile = getFeatureWorkflowSetupProfile("npm");
    expect(profile).not.toBeNull();
    if (!profile) return;

    const worktreeIncludePath = path.join(repoRoot, ".worktreeinclude");
    fs.writeFileSync(
      worktreeIncludePath,
      [".pi", ".pi/", ".env", ""].join("\n"),
    );

    const result = applyFeatureWorkflowSetupProfile({
      cwd: repoRoot,
      repoRoot,
      profile,
      targets: ["worktreeinclude"],
    });

    expect(result.changedCount).toBe(1);

    const updated = fs.readFileSync(worktreeIncludePath, "utf-8");
    expect(updated).not.toMatch(/(^|\n)\.pi\/?(\n|$)/);
    expect(updated).toContain(".env");
    expect(updated).toContain(".env.local");

    const change = result.changes.find(
      (item) => item.target === "worktreeinclude",
    );
    expect(change?.message).toContain("Removed entries:");
  });

  it("replaces an existing top-level worktree-path and preserves other config", () => {
    const repoRoot = createTempDir(
      "pi-kit-feature-setup-worktrunk-user-config-",
    );
    const userHomePath = createTempDir(
      "pi-kit-feature-setup-worktrunk-user-config-home-",
    );
    const profile = getFeatureWorkflowSetupProfile("npm");
    expect(profile).not.toBeNull();
    if (!profile) return;

    const userConfigPath =
      getFeatureWorkflowWorktrunkUserConfigPath(userHomePath);
    fs.mkdirSync(path.dirname(userConfigPath), { recursive: true });
    fs.writeFileSync(
      userConfigPath,
      [
        'worktree-path = "{{ repo_path }}/.worktrees/{{ branch | sanitize }}"',
        "",
        "[switch]",
        "no-cd = true",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = applyFeatureWorkflowSetupProfile({
      cwd: repoRoot,
      repoRoot,
      profile,
      targets: ["wt-user-config"],
      userHomePath,
    });

    expect(result.changedCount).toBe(1);

    const updated = fs.readFileSync(userConfigPath, "utf-8");
    expect(updated).toContain(
      `worktree-path = "${FEATURE_WORKFLOW_RECOMMENDED_WORKTREE_PATH_TEMPLATE}"`,
    );
    expect(updated).toContain("[switch]");
    expect(updated).toContain("no-cd = true");
    expect(updated.match(/^\s*worktree-path\s*=/gm)).toHaveLength(1);
    expect(
      updated.startsWith(
        "# >>> pi-kit feature-workflow worktree-path (managed) >>>",
      ),
    ).toBe(true);
  });

  it("leaves an existing recommended top-level worktree-path unchanged", () => {
    const repoRoot = createTempDir(
      "pi-kit-feature-setup-worktrunk-user-config-same-",
    );
    const userHomePath = createTempDir(
      "pi-kit-feature-setup-worktrunk-user-config-same-home-",
    );
    const profile = getFeatureWorkflowSetupProfile("npm");
    expect(profile).not.toBeNull();
    if (!profile) return;

    const userConfigPath =
      getFeatureWorkflowWorktrunkUserConfigPath(userHomePath);
    fs.mkdirSync(path.dirname(userConfigPath), { recursive: true });
    const existing = [
      `worktree-path = "${FEATURE_WORKFLOW_RECOMMENDED_WORKTREE_PATH_TEMPLATE}"`,
      "",
      "[switch]",
      "no-cd = true",
      "",
    ].join("\n");
    fs.writeFileSync(userConfigPath, existing, "utf-8");

    const result = applyFeatureWorkflowSetupProfile({
      cwd: repoRoot,
      repoRoot,
      profile,
      targets: ["wt-user-config"],
      userHomePath,
    });

    expect(result.changedCount).toBe(0);
    expect(fs.readFileSync(userConfigPath, "utf-8")).toBe(existing);
    expect(
      getFeatureWorkflowWorktrunkUserConfigStatus({ userHomePath }),
    ).toEqual({
      path: userConfigPath,
      currentTemplate: FEATURE_WORKFLOW_RECOMMENDED_WORKTREE_PATH_TEMPLATE,
      needsUpdate: false,
    });
  });

  it("adds missing profile rule without overriding existing node_modules rule", () => {
    const repoRoot = createTempDir("pi-kit-feature-setup-merge-");
    const profile = getFeatureWorkflowSetupProfile("npm");
    expect(profile).not.toBeNull();
    if (!profile) return;

    const settingsPath = path.join(
      repoRoot,
      ".pi",
      "third_extension_settings.json",
    );

    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          featureWorkflow: {
            ignoredSync: {
              enabled: false,
              rules: [
                {
                  path: "node_modules",
                  strategy: "copy",
                  required: true,
                  onMissing: {
                    action: "copy-ignored",
                    hook: null,
                  },
                },
              ],
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    applyFeatureWorkflowSetupProfile({
      cwd: repoRoot,
      repoRoot,
      profile,
      targets: ["settings"],
    });

    const updated = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as {
      featureWorkflow: {
        ignoredSync: {
          enabled: boolean;
          rules: Array<{
            path: string;
            strategy: string;
            required: boolean;
            onMissing: { action: string; hook: string | null };
          }>;
        };
      };
    };

    const nodeModulesRule = updated.featureWorkflow.ignoredSync.rules.find(
      (rule) => rule.path === "node_modules",
    );
    const piRule = updated.featureWorkflow.ignoredSync.rules.find(
      (rule) => rule.path === ".pi",
    );
    const agentsRule = updated.featureWorkflow.ignoredSync.rules.find(
      (rule) => rule.path === "AGENTS.md",
    );
    const claudeRule = updated.featureWorkflow.ignoredSync.rules.find(
      (rule) => rule.path === "CLAUDE.md",
    );

    expect(updated.featureWorkflow.ignoredSync.enabled).toBe(true);
    expect(nodeModulesRule).toMatchObject({
      strategy: "copy",
      required: true,
      onMissing: {
        action: "copy-ignored",
      },
    });
    expect(piRule).toMatchObject({
      strategy: "symlink",
      onMissing: {
        action: "run-hook",
        hook: "project-deps-link",
      },
    });
    expect(agentsRule).toMatchObject({
      strategy: "copy",
      onMissing: {
        action: "run-hook",
        hook: "project-deps-link",
      },
    });
    expect(claudeRule).toMatchObject({
      strategy: "copy",
      onMissing: {
        action: "run-hook",
        hook: "project-deps-link",
      },
    });
  });
});
