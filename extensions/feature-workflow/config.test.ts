import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/settings.js", () => ({
  loadSettings: vi.fn(),
}));

import { loadSettings } from "../shared/settings.js";

import { loadFeatureWorkflowConfig } from "./config.js";

const mockedLoadSettings = vi.mocked(loadSettings);

describe("loadFeatureWorkflowConfig", () => {
  beforeEach(() => {
    mockedLoadSettings.mockReset();
  });

  it("returns defaults when settings are missing", () => {
    mockedLoadSettings.mockReturnValue({
      globalPath: "",
      projectPath: "",
      global: {},
      project: {},
      merged: {},
    });

    const config = loadFeatureWorkflowConfig("/repo");

    expect(config.enabled).toBe(true);
    expect(config.ignoredSync).toEqual({
      enabled: true,
      mode: "quick",
      ensureOn: ["feature-start", "feature-switch"],
      rules: [
        {
          path: "node_modules",
          strategy: "symlink",
          required: false,
          onMissing: {
            action: "run-hook",
            hook: "project-deps-link",
          },
        },
        {
          path: ".pi",
          strategy: "symlink",
          required: false,
          onMissing: {
            action: "run-hook",
            hook: "project-deps-link",
          },
        },
        {
          path: "AGENTS.md",
          strategy: "copy",
          required: false,
          onMissing: {
            action: "run-hook",
            hook: "project-deps-link",
          },
        },
        {
          path: "CLAUDE.md",
          strategy: "copy",
          required: false,
          onMissing: {
            action: "run-hook",
            hook: "project-deps-link",
          },
        },
      ],
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
    });
  });

  it("normalizes ignored sync configuration", () => {
    mockedLoadSettings.mockReturnValue({
      globalPath: "",
      projectPath: "",
      global: {},
      project: {},
      merged: {
        featureWorkflow: {
          ignoredSync: {
            enabled: true,
            mode: "quick",
            ensureOn: ["feature-start", "invalid"],
            rules: [
              {
                path: " node_modules ",
                strategy: "symlink",
                required: true,
                onMissing: {
                  action: "run-hook",
                  hook: " project:deps-link ",
                },
              },
              {
                path: " .env.local ",
                strategy: "copy",
                onMissing: {
                  action: "copy-ignored",
                },
              },
              {
                path: "cache",
                strategy: "symlink",
              },
              {
                path: "   ",
                strategy: "copy",
              },
            ],
            lockfile: {
              enabled: true,
              path: " package-lock.json ",
              compareWithPrimary: false,
              onDrift: "warn",
            },
            fallback: {
              copyIgnoredTimeoutMs: 9000,
              onFailure: "block",
            },
            notifications: {
              enabled: false,
              verbose: true,
            },
          },
        },
      },
    });

    const config = loadFeatureWorkflowConfig("/repo");

    expect(config.ignoredSync.enabled).toBe(true);
    expect(config.ignoredSync.ensureOn).toEqual(["feature-start"]);
    expect(config.ignoredSync.rules).toEqual([
      {
        path: "node_modules",
        strategy: "symlink",
        required: true,
        onMissing: {
          action: "run-hook",
          hook: "project-deps-link",
        },
      },
      {
        path: ".env.local",
        strategy: "copy",
        required: false,
        onMissing: {
          action: "copy-ignored",
          hook: null,
        },
      },
      {
        path: "cache",
        strategy: "symlink",
        required: false,
        onMissing: {
          action: "run-hook",
          hook: "project-deps-link",
        },
      },
    ]);

    expect(config.ignoredSync.lockfile).toEqual({
      enabled: true,
      path: "package-lock.json",
      compareWithPrimary: false,
      onDrift: "warn",
    });

    expect(config.ignoredSync.fallback).toEqual({
      copyIgnoredTimeoutMs: 9000,
      onFailure: "block",
    });

    expect(config.ignoredSync.notifications).toEqual({
      enabled: false,
      verbose: true,
    });
  });
});
