import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePi,
  createTempRepo,
  createTestContext,
  flushMicrotasks,
  mockPlannotatorSpawn,
  removeTempRepo,
} from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Shell integration: scanReviewableFiles (with temp filesystem)
// ---------------------------------------------------------------------------

import { scanReviewableFiles } from "./review-picker.js";

describe("scanReviewableFiles (shell integration)", () => {
  let repoRoot: string;

  afterEach(async () => {
    if (repoRoot) {
      await removeTempRepo(repoRoot);
    }
    vi.restoreAllMocks();
  });

  it("returns empty when .pi does not exist", async () => {
    repoRoot = await createTempRepo("scan-pi-empty");
    fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });

    const ctx = createTestContext(repoRoot);
    const files = scanReviewableFiles(ctx as never);
    expect(files).toEqual([]);
  });

  it("recursively finds .md and .html files under .pi, sorted by mtime", async () => {
    repoRoot = await createTempRepo("scan-pi-found");
    const planDir = path.join(repoRoot, ".pi", "plans", "repo", "plan");
    const htmlDir = path.join(repoRoot, ".pi", "html", "repo");
    const lessonsDir = path.join(repoRoot, ".pi", "teach", "topic", "lessons");
    fs.mkdirSync(planDir, { recursive: true });
    fs.mkdirSync(htmlDir, { recursive: true });
    fs.mkdirSync(lessonsDir, { recursive: true });
    fs.mkdirSync(path.join(repoRoot, ".pi", "agent"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, ".pi", "skills", "demo"), {
      recursive: true,
    });

    // Reviewable: plan md, html artifact, teach lesson md, nested skill md
    fs.writeFileSync(
      path.join(planDir, "2026-01-01-my-plan.md"),
      "# Plan",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(htmlDir, "2026-01-01-overview.html"),
      "<h1>HTML</h1>",
      "utf-8",
    );
    fs.writeFileSync(path.join(lessonsDir, "lesson-1.md"), "# Lesson", "utf-8");
    fs.writeFileSync(
      path.join(repoRoot, ".pi", "skills", "demo", "SKILL.md"),
      "# Skill",
      "utf-8",
    );

    // Not reviewable: non-md/html files
    fs.writeFileSync(
      path.join(repoRoot, ".pi", "agent", "settings.json"),
      "{}",
      "utf-8",
    );
    fs.writeFileSync(path.join(planDir, "notes.txt"), "notes", "utf-8");

    const ctx = createTestContext(repoRoot);
    const files = scanReviewableFiles(ctx as never);

    expect(files).toHaveLength(4);
    expect(files.map((f) => f.relativePath).sort()).toEqual([
      ".pi/html/repo/2026-01-01-overview.html",
      ".pi/plans/repo/plan/2026-01-01-my-plan.md",
      ".pi/skills/demo/SKILL.md",
      ".pi/teach/topic/lessons/lesson-1.md",
    ]);
    // Sorted by mtime descending
    for (let i = 1; i < files.length; i++) {
      expect(files[i - 1].mtimeMs).toBeGreaterThanOrEqual(files[i].mtimeMs);
    }
  });

  it("caps the list at MAX_PLAN_FILES (50)", async () => {
    repoRoot = await createTempRepo("scan-pi-cap");
    const dir = path.join(repoRoot, ".pi", "plans", "repo", "plan");
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 60; i++) {
      fs.writeFileSync(
        path.join(dir, `2026-01-01-plan-${i}.md`),
        `# Plan ${i}`,
        "utf-8",
      );
    }

    const ctx = createTestContext(repoRoot);
    const files = scanReviewableFiles(ctx as never);
    expect(files).toHaveLength(50);
  });
});

// ---------------------------------------------------------------------------
// showPlanFilePicker — UI mode guard
// ---------------------------------------------------------------------------

describe("showPlanFilePicker (no UI)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows warning when UI mode is unavailable", async () => {
    const { showPlanFilePicker } = await import("./review-picker.js");
    const { api } = createFakePi();
    const ctx = createTestContext("/repo", { hasUI: false });

    await showPlanFilePicker(api as never, ctx as never);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Review picker requires UI mode.",
      "warning",
    );
  });
});

// ---------------------------------------------------------------------------
// showPlanFilePicker — plan review path (with temp filesystem + mock CLI)
// ---------------------------------------------------------------------------

describe("showPlanFilePicker (plan review path)", () => {
  let repoRoot: string;

  afterEach(async () => {
    if (repoRoot) {
      await removeTempRepo(repoRoot);
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows warning when no plan files found", async () => {
    repoRoot = await createTempRepo("picker-plan-empty");
    fs.mkdirSync(path.join(repoRoot, ".pi", "plans", "test-repo", "plan"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });

    vi.doMock("../shared/settings.ts", () => ({
      loadGlobalSettings: vi.fn(() => ({
        globalPath: path.join(
          repoRoot,
          ".pi",
          "agent",
          "third_extension_settings.json",
        ),
        global: {},
      })),
      loadSettings: vi.fn(() => ({
        merged: { plannotatorAuto: {} },
      })),
    }));
    vi.doMock("../shared/git.ts", () => ({
      DEFAULT_GIT_TIMEOUT_MS: 1_000,
      getRepoRoot: vi.fn(() => repoRoot),
      getGitCommonDir: vi.fn(() => path.join(repoRoot, ".git")),
    }));
    vi.resetModules();

    const { showPlanFilePicker } = await import("./review-picker.js");
    const { api } = createFakePi();
    const ctx = createTestContext(repoRoot, {
      uiCustom: vi.fn().mockResolvedValueOnce(null as never),
    });

    await showPlanFilePicker(api as never, ctx as never);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringMatching(/No plan or spec files found/i),
      "warning",
    );
  });

  it("executes plan review for a markdown file (PermissionRequest hook)", async () => {
    repoRoot = await createTempRepo("picker-plan-md");
    const slug = path.basename(repoRoot);
    const planDir = path.join(repoRoot, ".pi", "plans", slug, "plan");
    const planFile = path.join(planDir, "2026-01-01-my-plan.md");

    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(planFile, "# Test Plan\n\nSome content", "utf-8");
    fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });

    vi.doMock("../shared/settings.ts", () => ({
      loadGlobalSettings: vi.fn(() => ({
        globalPath: path.join(
          repoRoot,
          ".pi",
          "agent",
          "third_extension_settings.json",
        ),
        global: {},
      })),
      loadSettings: vi.fn(() => ({
        merged: { plannotatorAuto: {} },
      })),
    }));
    vi.doMock("../shared/git.ts", () => ({
      DEFAULT_GIT_TIMEOUT_MS: 1_000,
      getRepoRoot: vi.fn(() => repoRoot),
      getGitCommonDir: vi.fn(() => path.join(repoRoot, ".git")),
    }));

    const spawn = mockPlannotatorSpawn({
      status: 0,
      stdout: JSON.stringify({ decision: "approved" }),
    });
    vi.resetModules();

    const { showPlanFilePicker } = await import("./review-picker.js");
    const { api } = createFakePi();
    const ctx = createTestContext(repoRoot, {
      uiCustom: vi.fn().mockResolvedValueOnce(planFile),
    });

    await showPlanFilePicker(api as never, ctx as never);
    await flushMicrotasks();

    // The plan review CLI (PermissionRequest hook) — spawn with no args, content via stdin
    expect(spawn).toHaveBeenCalledWith(
      "plannotator",
      [],
      expect.objectContaining({ cwd: repoRoot }),
    );
    expect(api.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("Review approved"),
      { deliverAs: "followUp" },
    );
  });

  it("notifies on plan review CLI error", async () => {
    repoRoot = await createTempRepo("picker-plan-err");
    const slug = path.basename(repoRoot);
    const planDir = path.join(repoRoot, ".pi", "plans", slug, "plan");
    const planFile = path.join(planDir, "2026-01-01-my-plan.md");

    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(planFile, "# Test Plan", "utf-8");
    fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });

    vi.doMock("../shared/settings.ts", () => ({
      loadGlobalSettings: vi.fn(() => ({
        globalPath: path.join(
          repoRoot,
          ".pi",
          "agent",
          "third_extension_settings.json",
        ),
        global: {},
      })),
      loadSettings: vi.fn(() => ({
        merged: { plannotatorAuto: {} },
      })),
    }));
    vi.doMock("../shared/git.ts", () => ({
      DEFAULT_GIT_TIMEOUT_MS: 1_000,
      getRepoRoot: vi.fn(() => repoRoot),
      getGitCommonDir: vi.fn(() => path.join(repoRoot, ".git")),
    }));

    mockPlannotatorSpawn({ status: 1, stderr: "CLI error" });
    vi.resetModules();

    const { showPlanFilePicker } = await import("./review-picker.js");
    const { api } = createFakePi();
    const ctx = createTestContext(repoRoot, {
      uiCustom: vi.fn().mockResolvedValueOnce(planFile),
    });

    await showPlanFilePicker(api as never, ctx as never);
    await flushMicrotasks();

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringMatching(/CLI error/),
      "warning",
    );
  });
});
