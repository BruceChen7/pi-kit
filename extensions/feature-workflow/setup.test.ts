import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { clearSettingsCache } from "../shared/settings.js";

import {
  applyFeatureWorkflowSetupProfile,
  FEATURE_WORKFLOW_SETUP_TARGETS,
  getFeatureWorkflowSetupProfile,
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
        "Unknown target 'wat'. Supported targets: settings, gitignore, worktreeinclude, hook-script, wt-toml.",
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

    expect(first.changedCount).toBe(5);

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
    expect(wtToml).not.toContain("[[pre-start]]");
    expect(wtToml).toContain('"project-deps-link"');
    expect(wtToml).toContain(
      'bash \\"$HOME/.pi/pi-feature-workflow-links.sh\\"',
    );
    expect(wtToml).not.toContain("bash .pi/pi-feature-workflow-links.sh");

    const gitignorePath = path.join(repoRoot, ".gitignore");
    const gitignore = fs.readFileSync(gitignorePath, "utf-8");
    expect(gitignore).toContain(".pi/");
    expect(gitignore).toContain(".config/wt.toml");

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
    fs.writeFileSync(gitignorePath, [".pi", "/.config/wt.toml", ""].join("\n"));

    const result = applyFeatureWorkflowSetupProfile({
      cwd: repoRoot,
      repoRoot,
      profile,
      targets: ["gitignore"],
    });

    expect(result.changedCount).toBe(0);
    expect(fs.readFileSync(gitignorePath, "utf-8")).toBe(
      [".pi", "/.config/wt.toml", ""].join("\n"),
    );
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
