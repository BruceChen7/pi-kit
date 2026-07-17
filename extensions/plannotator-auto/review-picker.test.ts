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
// Pure function: pickTopPlanFiles
// ---------------------------------------------------------------------------

import { type FileItem, pickTopPlanFiles } from "./review-picker.js";

describe("pickTopPlanFiles", () => {
  it("returns empty when both inputs are empty", () => {
    const result = pickTopPlanFiles([], [], 5);
    expect(result).toEqual([]);
  });

  it("returns pending entries when no scanned files", () => {
    const pending: FileItem[] = [
      {
        absolutePath: "/repo/.pi/plans/repo/plan/2026-01-01-plan.md",
        relativePath: ".pi/plans/repo/plan/2026-01-01-plan.md",
        mtimeMs: 1000,
      },
    ];
    const result = pickTopPlanFiles(pending, [], 5);
    expect(result).toHaveLength(1);
    expect(result[0]?.absolutePath).toBe(pending[0]?.absolutePath);
  });

  it("returns scanned entries when no pending targets", () => {
    const scanned: FileItem[] = [
      {
        absolutePath: "/repo/.pi/plans/repo/plan/2026-01-01-plan.md",
        relativePath: ".pi/plans/repo/plan/2026-01-01-plan.md",
        mtimeMs: 1000,
      },
    ];
    const result = pickTopPlanFiles([], scanned, 5);
    expect(result).toHaveLength(1);
    expect(result[0]?.absolutePath).toBe(scanned[0]?.absolutePath);
  });

  it("deduplicates by absolutePath (pending wins over scanned)", () => {
    const pending: FileItem[] = [
      {
        absolutePath: "/repo/.pi/plans/repo/plan/2026-01-01-plan.md",
        relativePath: "pending-path.md",
        mtimeMs: 100,
      },
    ];
    const scanned: FileItem[] = [
      {
        absolutePath: "/repo/.pi/plans/repo/plan/2026-01-01-plan.md",
        relativePath: "scanned-path.md",
        mtimeMs: 200,
      },
    ];
    const result = pickTopPlanFiles(pending, scanned, 5);

    expect(result).toHaveLength(1);
    expect(result[0]?.absolutePath).toBe(
      "/repo/.pi/plans/repo/plan/2026-01-01-plan.md",
    );
  });

  it("sorts by mtime descending", () => {
    const scanned: FileItem[] = [
      {
        absolutePath: "/repo/a.md",
        relativePath: "a.md",
        mtimeMs: 100,
      },
      {
        absolutePath: "/repo/b.md",
        relativePath: "b.md",
        mtimeMs: 300,
      },
      {
        absolutePath: "/repo/c.md",
        relativePath: "c.md",
        mtimeMs: 200,
      },
    ];
    const result = pickTopPlanFiles([], scanned, 5);
    expect(result).toHaveLength(3);
    expect(result[0]?.relativePath).toBe("b.md");
    expect(result[1]?.relativePath).toBe("c.md");
    expect(result[2]?.relativePath).toBe("a.md");
  });

  it("caps at maxFiles", () => {
    const scanned: FileItem[] = Array.from({ length: 10 }, (_, i) => ({
      absolutePath: `/repo/file-${i}.md`,
      relativePath: `file-${i}.md`,
      mtimeMs: 1000 - i,
    }));
    const result = pickTopPlanFiles([], scanned, 3);
    expect(result).toHaveLength(3);
  });

  it("interleaves pending and scanned entries sorted by mtime", () => {
    const pending: FileItem[] = [
      {
        absolutePath: "/repo/pending-old.md",
        relativePath: "pending-old.md",
        mtimeMs: 10,
      },
    ];
    const scanned: FileItem[] = [
      {
        absolutePath: "/repo/fresh.md",
        relativePath: "fresh.md",
        mtimeMs: 500,
      },
      {
        absolutePath: "/repo/mid.md",
        relativePath: "mid.md",
        mtimeMs: 200,
      },
    ];
    const result = pickTopPlanFiles(pending, scanned, 5);
    expect(result).toHaveLength(3);
    expect(result[0]?.relativePath).toBe("fresh.md");
    expect(result[1]?.relativePath).toBe("mid.md");
    expect(result[2]?.relativePath).toBe("pending-old.md");
  });
});

// ---------------------------------------------------------------------------
// Shell integration: scanPlanFiles (with temp filesystem)
// ---------------------------------------------------------------------------

describe("scanPlanFiles (shell integration)", () => {
  let repoRoot: string;

  afterEach(async () => {
    if (repoRoot) {
      await removeTempRepo(repoRoot);
    }
    vi.restoreAllMocks();
  });

  it("returns empty when plan dir does not exist", async () => {
    repoRoot = await createTempRepo("scan-plan-empty");
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
    const { scanPlanFiles } = await import("./review-picker.js");
    const ctx = createTestContext(repoRoot);

    const files = scanPlanFiles(ctx);
    expect(files).toEqual([]);
  });

  it("finds plan files in default plan directory", async () => {
    repoRoot = await createTempRepo("scan-plan-found");
    const slug = path.basename(repoRoot);
    const planDir = path.join(repoRoot, ".pi", "plans", slug, "plan");
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(
      path.join(planDir, "2026-01-01-my-plan.md"),
      "# Plan",
      "utf-8",
    );
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
    const { scanPlanFiles } = await import("./review-picker.js");
    const ctx = createTestContext(repoRoot);

    const files = scanPlanFiles(ctx);
    expect(files).toHaveLength(1);
    expect(files[0]?.relativePath).toContain("2026-01-01-my-plan.md");
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
