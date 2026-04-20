import { describe, expect, it, vi } from "vitest";

import type { FeatureWorkflowIgnoredSyncConfig } from "./config.js";
import { runIgnoredSync } from "./ignored-sync.js";
import type { WtRunner } from "./worktree-gateway.js";

const runWt: WtRunner = vi.fn();

const buildConfig = (
  overrides: Partial<FeatureWorkflowIgnoredSyncConfig> = {},
): FeatureWorkflowIgnoredSyncConfig => ({
  enabled: true,
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
  ...overrides,
});

describe("runIgnoredSync", () => {
  it("skips quick mode before session switch", async () => {
    const notify = vi.fn();

    const result = await runIgnoredSync(
      {
        command: "feature-start",
        phase: "before-session-switch",
        config: buildConfig(),
        repoRoot: "/repo",
        worktreePath: "/repo/.wt/feat-main-checkout-v2",
        branch: "feat/main/checkout-v2",
        runWt,
        notify,
      },
      {
        getPathState: () => ({ exists: false, isSymlink: false }),
        readTextFile: () => null,
        resolvePrimaryWorktreePath: vi.fn().mockResolvedValue({
          ok: true,
          path: "/repo",
        }),
        runHook: vi.fn().mockResolvedValue({ ok: true }),
        runCopyIgnored: vi.fn().mockResolvedValue({ ok: true }),
      },
    );

    expect(result.executed).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it("runs copy-ignored fallback in quick mode after session switch", async () => {
    const notify = vi.fn();
    let hasNodeModules = false;

    const runCopyIgnored = vi.fn().mockImplementation(async () => {
      hasNodeModules = true;
      return { ok: true };
    });

    const result = await runIgnoredSync(
      {
        command: "feature-start",
        phase: "after-session-switch",
        config: buildConfig({
          rules: [
            {
              path: "node_modules",
              strategy: "copy",
              required: false,
              onMissing: {
                action: "copy-ignored",
                hook: null,
              },
            },
          ],
        }),
        repoRoot: "/repo",
        worktreePath: "/repo/.wt/feat-main-checkout-v2",
        branch: "feat/main/checkout-v2",
        runWt,
        notify,
      },
      {
        getPathState: (absolutePath) =>
          absolutePath.endsWith("node_modules")
            ? { exists: hasNodeModules, isSymlink: false }
            : { exists: false, isSymlink: false },
        readTextFile: () => null,
        resolvePrimaryWorktreePath: vi.fn().mockResolvedValue({
          ok: true,
          path: "/repo",
        }),
        runHook: vi.fn().mockResolvedValue({ ok: true }),
        runCopyIgnored,
      },
    );

    expect(runCopyIgnored).toHaveBeenCalledOnce();
    expect(result).toEqual({
      executed: true,
      blocked: false,
      missingCount: 1,
      unresolvedCount: 0,
      actionCount: 1,
    });

    expect(notify).toHaveBeenCalledWith(
      "Ignored sync: triggered 1 fallback action(s): wt step copy-ignored.",
      "info",
    );
  });

  it("blocks strict mode when required paths remain unresolved", async () => {
    const notify = vi.fn();
    const runHook = vi.fn().mockResolvedValue({
      ok: false,
      message: "hook failed",
    });

    const result = await runIgnoredSync(
      {
        command: "feature-switch",
        phase: "before-session-switch",
        config: buildConfig({
          mode: "strict",
          fallback: {
            copyIgnoredTimeoutMs: 15000,
            onFailure: "block",
          },
          rules: [
            {
              path: "node_modules",
              strategy: "symlink",
              required: true,
              onMissing: {
                action: "run-hook",
                hook: "project-deps-link",
              },
            },
          ],
        }),
        repoRoot: "/repo",
        worktreePath: "/repo/.wt/feat-main-checkout-v2",
        branch: "feat/main/checkout-v2",
        runWt,
        notify,
      },
      {
        getPathState: () => ({ exists: false, isSymlink: false }),
        readTextFile: () => null,
        resolvePrimaryWorktreePath: vi.fn().mockResolvedValue({
          ok: true,
          path: "/repo",
        }),
        runHook,
        runCopyIgnored: vi.fn().mockResolvedValue({ ok: true }),
      },
    );

    expect(runHook).toHaveBeenCalledOnce();
    expect(result.blocked).toBe(true);
    expect(result.unresolvedCount).toBe(1);
    expect(notify).toHaveBeenCalledWith(
      "Ignored sync blocked session switch because required paths are not ready.",
      "error",
    );
  });

  it("warns when package-lock drifts from primary worktree", async () => {
    const notify = vi.fn();

    await runIgnoredSync(
      {
        command: "feature-start",
        phase: "after-session-switch",
        config: buildConfig({
          lockfile: {
            enabled: true,
            path: "package-lock.json",
            compareWithPrimary: true,
            onDrift: "warn",
          },
        }),
        repoRoot: "/repo",
        worktreePath: "/repo/.wt/feat-main-checkout-v2",
        branch: "feat/main/checkout-v2",
        runWt,
        notify,
      },
      {
        getPathState: () => ({ exists: true, isSymlink: false }),
        readTextFile: (absolutePath) =>
          absolutePath.includes("/.wt/") ? "B" : "A",
        resolvePrimaryWorktreePath: vi.fn().mockResolvedValue({
          ok: true,
          path: "/repo",
        }),
        runHook: vi.fn().mockResolvedValue({ ok: true }),
        runCopyIgnored: vi.fn().mockResolvedValue({ ok: true }),
      },
    );

    expect(notify).toHaveBeenCalledWith(
      "package-lock.json drift detected vs primary worktree. Run npm ci if dependency mismatch.",
      "warning",
    );
  });

  it("warns when primary worktree cannot be resolved for lockfile drift check", async () => {
    const notify = vi.fn();

    await runIgnoredSync(
      {
        command: "feature-switch",
        phase: "after-session-switch",
        config: buildConfig({
          lockfile: {
            enabled: true,
            path: "package-lock.json",
            compareWithPrimary: true,
            onDrift: "warn",
          },
        }),
        repoRoot: "/repo",
        worktreePath: "/repo/.wt/feat-main-checkout-v2",
        branch: "feat/main/checkout-v2",
        runWt,
        notify,
      },
      {
        getPathState: () => ({ exists: true, isSymlink: false }),
        readTextFile: () => null,
        resolvePrimaryWorktreePath: vi.fn().mockResolvedValue({
          ok: false,
          message: "wt list failed",
        }),
        runHook: vi.fn().mockResolvedValue({ ok: true }),
        runCopyIgnored: vi.fn().mockResolvedValue({ ok: true }),
      },
    );

    expect(notify).toHaveBeenCalledWith(
      "Ignored sync: cannot resolve primary worktree for lockfile drift check (wt list failed).",
      "warning",
    );
  });
});
