import { describe, expect, it } from "vitest";

type ImportedModule = {
  resolvePlanFileForReview?: (
    ctx: { cwd: string },
    planConfig: PlanConfig,
    targetPath: string,
  ) => string | null;
  shouldQueueReviewForToolPath?: (
    planConfig: PlanConfig | null,
    targetPath: string,
  ) => boolean;
  getSessionKey?: (ctx: {
    cwd: string;
    sessionManager: { getSessionFile: () => string | null | undefined };
  }) => string;
};

type PlanConfig = {
  planFile: string;
  resolvedPlanPath: string;
  resolvedPlanPaths: string[];
  resolvedSpecPaths?: string[];
  resolvedHtmlPaths?: string[];
};

async function importPlannotatorAuto(): Promise<ImportedModule> {
  return (await import("./index.js")) as ImportedModule;
}

function createPlanConfig(overrides: Partial<PlanConfig> = {}): PlanConfig {
  return {
    planFile: ".pi/plans/repo/plan",
    resolvedPlanPath: "/repo/.pi/plans/repo/plan",
    resolvedPlanPaths: ["/repo/.pi/plans/repo/plan"],
    resolvedSpecPaths: ["/repo/.pi/plans/repo/specs"],
    resolvedHtmlPaths: [],
    ...overrides,
  };
}

describe("index path helpers", () => {
  describe("resolvePlanFileForReview", () => {
    it.each([
      {
        name: "matches generated plan files",
        config: createPlanConfig(),
        targetPath: "/repo/.pi/plans/repo/plan/2026-04-15-auth-flow.md",
        expected: ".pi/plans/repo/plan/2026-04-15-auth-flow.md",
      },
      {
        name: "matches generated HTML plan files (any .html under .pi is a review target)",
        config: createPlanConfig(),
        targetPath: "/repo/.pi/plans/repo/plan/2026-04-15-auth-flow.html",
        expected: ".pi/plans/repo/plan/2026-04-15-auth-flow.html",
      },
      {
        name: "matches generated design specs",
        config: createPlanConfig(),
        targetPath: "/repo/.pi/plans/repo/specs/2026-04-20-auth-design.md",
        expected: ".pi/plans/repo/specs/2026-04-20-auth-design.md",
      },
      {
        name: "matches HTML design specs (any .html under .pi is a review target)",
        config: createPlanConfig(),
        targetPath: "/repo/.pi/plans/repo/specs/2026-04-20-auth-design.html",
        expected: ".pi/plans/repo/specs/2026-04-20-auth-design.html",
      },
      {
        name: "matches alias plan directories",
        config: createPlanConfig({
          planFile: ".pi/plans/pi-kit/plan",
          resolvedPlanPath: "/repo/.pi/plans/pi-kit/plan",
          resolvedPlanPaths: [
            "/repo/.pi/plans/pi-kit/plan",
            "/repo/.pi/plans/pi-kit.feat-branch/plan",
          ],
          resolvedSpecPaths: [
            "/repo/.pi/plans/pi-kit/specs",
            "/repo/.pi/plans/pi-kit.feat-branch/specs",
          ],
        }),
        targetPath:
          "/repo/.pi/plans/pi-kit.feat-branch/plan/2026-04-15-auth-flow.md",
        expected: ".pi/plans/pi-kit.feat-branch/plan/2026-04-15-auth-flow.md",
      },
      {
        name: "matches wildcard plan roots",
        config: createPlanConfig(),
        targetPath:
          "/repo/.pi/plans/other-worktree/plan/2026-04-15-auth-flow.md",
        expected: ".pi/plans/other-worktree/plan/2026-04-15-auth-flow.md",
      },
      {
        name: "matches wildcard spec roots",
        config: createPlanConfig(),
        targetPath:
          "/repo/.pi/plans/other-worktree/specs/2026-04-20-auth-design.md",
        expected: ".pi/plans/other-worktree/specs/2026-04-20-auth-design.md",
      },
      {
        name: "matches shaping markdown files with any filename",
        config: createPlanConfig(),
        targetPath: "/repo/.pi/plans/repo/shaping/current-notes.md",
        expected: ".pi/plans/repo/shaping/current-notes.md",
      },
      {
        name: "matches wildcard shaping markdown files",
        config: createPlanConfig(),
        targetPath: "/repo/.pi/plans/other-worktree/shaping/breadboard.md",
        expected: ".pi/plans/other-worktree/shaping/breadboard.md",
      },
      {
        name: "matches issue markdown files under a topic directory",
        config: createPlanConfig(),
        targetPath:
          "/repo/.pi/plans/repo/issues/session-switch-lifecycle/cleanup-skill-toggle.md",
        expected:
          ".pi/plans/repo/issues/session-switch-lifecycle/cleanup-skill-toggle.md",
      },
      {
        name: "matches wildcard issue markdown files",
        config: createPlanConfig(),
        targetPath:
          "/repo/.pi/plans/other-worktree/issues/session-switch-lifecycle/01-cleanup.md",
        expected:
          ".pi/plans/other-worktree/issues/session-switch-lifecycle/01-cleanup.md",
      },
      {
        name: "matches issue markdown files without a topic directory (any .pi md)",
        config: createPlanConfig(),
        targetPath: "/repo/.pi/plans/repo/issues/01-root-issue.md",
        expected: ".pi/plans/repo/issues/01-root-issue.md",
      },
      {
        name: "matches nested issue files below topic directories (any .pi md)",
        config: createPlanConfig(),
        targetPath:
          "/repo/.pi/plans/repo/issues/session-switch-lifecycle/nested/01-cleanup.md",
        expected:
          ".pi/plans/repo/issues/session-switch-lifecycle/nested/01-cleanup.md",
      },
      {
        name: "ignores non-markdown issue files",
        config: createPlanConfig(),
        targetPath:
          "/repo/.pi/plans/repo/issues/session-switch-lifecycle/01-cleanup.txt",
        expected: null,
      },
      {
        name: "matches HTML artifacts under .pi/html/<repo>",
        config: createPlanConfig({
          resolvedHtmlPaths: ["/repo/.pi/html/repo"],
        }),
        targetPath: "/repo/.pi/html/repo/2026-04-16-prototype.html",
        expected: ".pi/html/repo/2026-04-16-prototype.html",
      },
      {
        name: "matches HTML artifacts without the dated naming pattern (any .pi html)",
        config: createPlanConfig({
          resolvedHtmlPaths: ["/repo/.pi/html/repo"],
        }),
        targetPath: "/repo/.pi/html/repo/prototype.html",
        expected: ".pi/html/repo/prototype.html",
      },
      {
        name: "matches markdown files under .pi/html/<repo> (any .pi md)",
        config: createPlanConfig({
          resolvedHtmlPaths: ["/repo/.pi/html/repo"],
        }),
        targetPath: "/repo/.pi/html/repo/2026-04-16-prototype.md",
        expected: ".pi/html/repo/2026-04-16-prototype.md",
      },
      {
        name: "matches HTML artifacts under .pi even without configured html dirs",
        config: createPlanConfig(),
        targetPath: "/repo/.pi/html/repo/2026-04-16-prototype.html",
        expected: ".pi/html/repo/2026-04-16-prototype.html",
      },
    ])("$name", async ({ config, targetPath, expected }) => {
      const { resolvePlanFileForReview } = await importPlannotatorAuto();

      expect(
        resolvePlanFileForReview?.({ cwd: "/repo" }, config, targetPath),
      ).toBe(expected);
    });
  });

  describe("shouldQueueReviewForToolPath", () => {
    it.each([
      {
        name: "skips generated plan files",
        config: createPlanConfig(),
        targetPath: "/repo/.pi/plans/repo/plan/2026-04-15-auth-flow.md",
        expected: false,
      },
      {
        name: "skips generated HTML plan files (any .html under .pi is a review target)",
        config: createPlanConfig(),
        targetPath: "/repo/.pi/plans/repo/plan/2026-04-15-auth-flow.html",
        expected: false,
      },
      {
        name: "skips generated design specs",
        config: createPlanConfig(),
        targetPath: "/repo/.pi/plans/repo/specs/2026-04-20-auth-design.md",
        expected: false,
      },
      {
        name: "skips HTML design specs (any .html under .pi is a review target)",
        config: createPlanConfig(),
        targetPath: "/repo/.pi/plans/repo/specs/2026-04-20-auth-design.html",
        expected: false,
      },
      {
        name: "skips wildcard generated plan files",
        config: createPlanConfig(),
        targetPath:
          "/repo/.pi/plans/other-worktree/plan/2026-04-15-auth-flow.md",
        expected: false,
      },
      {
        name: "skips wildcard generated design specs",
        config: createPlanConfig(),
        targetPath:
          "/repo/.pi/plans/other-worktree/specs/2026-04-20-auth-design.md",
        expected: false,
      },
      {
        name: "skips shaping markdown files with any filename",
        config: createPlanConfig(),
        targetPath: "/repo/.pi/plans/repo/shaping/current-notes.md",
        expected: false,
      },
      {
        name: "skips wildcard shaping markdown files",
        config: createPlanConfig(),
        targetPath: "/repo/.pi/plans/other-worktree/shaping/breadboard.md",
        expected: false,
      },
      {
        name: "skips issue markdown files under a topic directory",
        config: createPlanConfig(),
        targetPath:
          "/repo/.pi/plans/repo/issues/session-switch-lifecycle/cleanup-skill-toggle.md",
        expected: false,
      },
      {
        name: "skips wildcard issue markdown files",
        config: createPlanConfig(),
        targetPath:
          "/repo/.pi/plans/other-worktree/issues/session-switch-lifecycle/01-cleanup.md",
        expected: false,
      },
      {
        name: "skips issue markdown files without a topic directory (any .pi md)",
        config: createPlanConfig(),
        targetPath: "/repo/.pi/plans/repo/issues/01-root-issue.md",
        expected: false,
      },
      {
        name: "skips any markdown under .pi",
        config: createPlanConfig(),
        targetPath: "/repo/.pi/notes.md",
        expected: false,
      },
      {
        name: "skips any html under .pi",
        config: createPlanConfig(),
        targetPath: "/repo/.pi/scratch/proto.html",
        expected: false,
      },
      {
        name: "keeps queueing non-markdown files under .pi",
        config: createPlanConfig(),
        targetPath: "/repo/.pi/notes.txt",
        expected: true,
      },
      {
        name: "keeps queueing non-review files",
        config: createPlanConfig(),
        targetPath: "/repo/src/auth.ts",
        expected: true,
      },
      {
        name: "keeps queueing markdown outside .pi",
        config: createPlanConfig(),
        targetPath: "/repo/docs/notes.md",
        expected: true,
      },
    ])("$name", async ({ config, targetPath, expected }) => {
      const { shouldQueueReviewForToolPath } = await importPlannotatorAuto();

      expect(shouldQueueReviewForToolPath?.(config, targetPath)).toBe(expected);
    });
  });

  describe("getSessionKey", () => {
    it("falls back to a cwd-scoped ephemeral key when the session file is unavailable", async () => {
      const { getSessionKey } = await importPlannotatorAuto();

      expect(getSessionKey).toBeTypeOf("function");
      expect(
        getSessionKey?.({
          cwd: "/repo",
          sessionManager: { getSessionFile: () => null },
        }),
      ).toBe("/repo::ephemeral");
    });
  });
});
