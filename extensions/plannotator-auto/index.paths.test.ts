import { describe, expect, it } from "vitest";

type ImportedModule = {
  resolvePlanFileForReview?: (
    ctx: { cwd: string },
    htmlDirs: string[],
    targetPath: string,
  ) => string | null;
  getSessionKey?: (ctx: {
    cwd: string;
    sessionManager: { getSessionFile: () => string | null | undefined };
  }) => string;
};

async function importPlannotatorAuto(): Promise<ImportedModule> {
  return (await import("./index.js")) as ImportedModule;
}

describe("index path helpers", () => {
  describe("resolvePlanFileForReview", () => {
    it.each([
      {
        name: "matches generated plan files",
        htmlDirs: [],
        targetPath: "/repo/.pi/plans/repo/plan/2026-04-15-auth-flow.md",
        expected: ".pi/plans/repo/plan/2026-04-15-auth-flow.md",
      },
      {
        name: "matches generated HTML plan files (plan dir accepts md or html)",
        htmlDirs: [],
        targetPath: "/repo/.pi/plans/repo/plan/2026-04-15-auth-flow.html",
        expected: ".pi/plans/repo/plan/2026-04-15-auth-flow.html",
      },
      {
        name: "matches generated design specs",
        htmlDirs: [],
        targetPath: "/repo/.pi/plans/repo/specs/2026-04-20-auth-design.md",
        expected: ".pi/plans/repo/specs/2026-04-20-auth-design.md",
      },
      {
        name: "rejects HTML design specs (specs dir is md only)",
        htmlDirs: [],
        targetPath: "/repo/.pi/plans/repo/specs/2026-04-20-auth-design.html",
        expected: null,
      },
      {
        name: "matches alias plan directories (dir-name rule, no config)",
        htmlDirs: [],
        targetPath:
          "/repo/.pi/plans/pi-kit.feat-branch/plan/2026-04-15-auth-flow.md",
        expected: ".pi/plans/pi-kit.feat-branch/plan/2026-04-15-auth-flow.md",
      },
      {
        name: "matches plan dirs under any repo slug",
        htmlDirs: [],
        targetPath:
          "/repo/.pi/plans/other-worktree/plan/2026-04-15-auth-flow.md",
        expected: ".pi/plans/other-worktree/plan/2026-04-15-auth-flow.md",
      },
      {
        name: "matches specs dirs under any repo slug",
        htmlDirs: [],
        targetPath:
          "/repo/.pi/plans/other-worktree/specs/2026-04-20-auth-design.md",
        expected: ".pi/plans/other-worktree/specs/2026-04-20-auth-design.md",
      },
      {
        name: "rejects shaping markdown files (not plan/specs)",
        htmlDirs: [],
        targetPath: "/repo/.pi/plans/repo/shaping/current-notes.md",
        expected: null,
      },
      {
        name: "rejects wildcard shaping markdown files",
        htmlDirs: [],
        targetPath: "/repo/.pi/plans/other-worktree/shaping/breadboard.md",
        expected: null,
      },
      {
        name: "rejects issue markdown files under a topic directory",
        htmlDirs: [],
        targetPath:
          "/repo/.pi/plans/repo/issues/session-switch-lifecycle/cleanup-skill-toggle.md",
        expected: null,
      },
      {
        name: "rejects wildcard issue markdown files",
        htmlDirs: [],
        targetPath:
          "/repo/.pi/plans/other-worktree/issues/session-switch-lifecycle/01-cleanup.md",
        expected: null,
      },
      {
        name: "rejects issue markdown files without a topic directory",
        htmlDirs: [],
        targetPath: "/repo/.pi/plans/repo/issues/01-root-issue.md",
        expected: null,
      },
      {
        name: "rejects nested issue files below topic directories",
        htmlDirs: [],
        targetPath:
          "/repo/.pi/plans/repo/issues/session-switch-lifecycle/nested/01-cleanup.md",
        expected: null,
      },
      {
        name: "rejects teach workspace markdown",
        htmlDirs: [],
        targetPath: "/repo/.pi/teach/sideshow-pipe/NOTES.md",
        expected: null,
      },
      {
        name: "rejects teach workspace html lessons",
        htmlDirs: [],
        targetPath:
          "/repo/.pi/teach/sideshow-pipe/lessons/0001-sideshow-pipe-intro.html",
        expected: null,
      },
      {
        name: "ignores non-markdown issue files",
        htmlDirs: [],
        targetPath:
          "/repo/.pi/plans/repo/issues/session-switch-lifecycle/01-cleanup.txt",
        expected: null,
      },
      {
        name: "matches HTML artifacts under .pi/html/<repo>",
        htmlDirs: ["/repo/.pi/html/repo"],
        targetPath: "/repo/.pi/html/repo/2026-04-16-prototype.html",
        expected: ".pi/html/repo/2026-04-16-prototype.html",
      },
      {
        name: "rejects non-dated HTML artifacts (html dir match keeps the dated pattern)",
        htmlDirs: ["/repo/.pi/html/repo"],
        targetPath: "/repo/.pi/html/repo/prototype.html",
        expected: null,
      },
      {
        name: "rejects markdown under .pi/html/<repo> (html dir match is html-only)",
        htmlDirs: ["/repo/.pi/html/repo"],
        targetPath: "/repo/.pi/html/repo/2026-04-16-prototype.md",
        expected: null,
      },
      {
        name: "rejects HTML artifacts outside the html dirs",
        htmlDirs: [],
        targetPath: "/repo/.pi/html/repo/2026-04-16-prototype.html",
        expected: null,
      },
    ])("$name", async ({ htmlDirs, targetPath, expected }) => {
      const { resolvePlanFileForReview } = await importPlannotatorAuto();

      expect(
        resolvePlanFileForReview?.({ cwd: "/repo" }, htmlDirs, targetPath),
      ).toBe(expected);
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
