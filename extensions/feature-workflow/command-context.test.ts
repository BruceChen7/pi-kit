import { describe, expect, it, vi } from "vitest";
import { resolveFeatureWorkflowCommandContext } from "./command-context.js";
import type { FeatureWorkflowConfig } from "./config.js";

const enabledConfig = (
  overrides: Partial<FeatureWorkflowConfig> = {},
): FeatureWorkflowConfig => ({
  enabled: true,
  guards: {
    requireCleanWorkspace: true,
    requireFreshBase: true,
    enforceBranchNaming: true,
    ...overrides.guards,
  },
  defaults: {
    gitTimeoutMs: 5000,
    autoSwitchToWorktreeSession: true,
    ...overrides.defaults,
  },
  ignoredSync: {
    enabled: false,
    mode: "quick",
    ensureOn: ["feature-start", "feature-switch"],
    rules: [],
    lockfile: {
      enabled: false,
      path: "package-lock.json",
      compareWithPrimary: true,
      onDrift: "warn",
    },
    fallback: {
      copyIgnoredTimeoutMs: 15000,
      onFailure: "warn",
    },
    notifications: {
      enabled: true,
      verbose: false,
    },
    ...overrides.ignoredSync,
  },
  ...overrides,
});

describe("resolveFeatureWorkflowCommandContext", () => {
  it("returns null and notifies when feature-workflow is disabled", () => {
    const notify = vi.fn();

    const result = resolveFeatureWorkflowCommandContext(
      {
        cwd: "/repo",
        ui: { notify },
      },
      {
        loadConfig: () => enabledConfig({ enabled: false }),
        getRepoRoot: () => "/repo",
        createRunGit: () => {
          throw new Error("should not be called");
        },
      },
    );

    expect(result).toBeNull();
    expect(notify).toHaveBeenCalledWith("feature-workflow is disabled", "info");
  });

  it("returns null and notifies when cwd is not a git repository", () => {
    const notify = vi.fn();

    const result = resolveFeatureWorkflowCommandContext(
      {
        cwd: "/repo",
        ui: { notify },
      },
      {
        loadConfig: () => enabledConfig(),
        getRepoRoot: () => null,
        createRunGit: () => {
          throw new Error("should not be called");
        },
      },
    );

    expect(result).toBeNull();
    expect(notify).toHaveBeenCalledWith("Not a git repository", "info");
  });

  it("returns resolved config, repoRoot and runGit runner when ready", () => {
    const notify = vi.fn();
    const runGit = vi.fn();

    const result = resolveFeatureWorkflowCommandContext(
      {
        cwd: "/repo",
        ui: { notify },
      },
      {
        loadConfig: () => enabledConfig({ defaults: { gitTimeoutMs: 7000 } }),
        getRepoRoot: () => "/repo/root",
        createRunGit: (repoRoot, timeoutMs) => {
          expect(repoRoot).toBe("/repo/root");
          expect(timeoutMs).toBe(7000);
          return runGit;
        },
      },
    );

    expect(result).toEqual({
      config: enabledConfig({ defaults: { gitTimeoutMs: 7000 } }),
      timeoutMs: 7000,
      repoRoot: "/repo/root",
      runGit,
    });
    expect(notify).not.toHaveBeenCalled();
  });
});
