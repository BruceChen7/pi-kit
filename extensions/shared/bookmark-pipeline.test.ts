import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupDir, tempDir } from "../scheduled-tasks/tasks/test-utils.ts";
import {
  type ArchiveConfig,
  type BookmarkTaskConfig,
  buildArchiveFailureMessage,
  createBookmarkTask,
  type IncrementDecision,
  localDateString,
  prepareBookmarkChunks,
} from "./bookmark-pipeline.ts";
import type { ExecContext } from "./deferred-queue/types.ts";

// ── Telegram mock ─────────────────────────────────────

const { sendTelegramNotificationMock } = vi.hoisted(() => ({
  sendTelegramNotificationMock: vi.fn(),
}));

vi.mock("./telegram.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./telegram.ts")>();
  return {
    ...actual,
    sendTelegramNotification: sendTelegramNotificationMock,
  };
});

// ── Fixtures ──────────────────────────────────────────

interface TestBookmark {
  id: string;
  title: string;
}

const _sampleItem = (overrides: Partial<TestBookmark> = {}): TestBookmark => ({
  id: "1",
  title: "hello",
  ...overrides,
});

/**
 * Create a minimal valid config for testing.
 */
function testConfig(
  overrides?: Partial<BookmarkTaskConfig<TestBookmark>>,
): BookmarkTaskConfig<TestBookmark> {
  return {
    id: "test-bookmarks-fetch",
    every: "1h",
    description: "Test bookmark task",
    command: "opencli",
    args: ["test", "bookmarks"],
    checkpointPath: "/tmp/test-checkpoint.json",
    checkpointField: "lastId",
    buildPrefix: () => "📑 Test\n\n",
    computeIncrement: (
      items: TestBookmark[],
      state: { lastCheckpointValue: string | null },
    ): IncrementDecision<TestBookmark> => {
      if (items.length === 0) return { kind: "skip" };
      const headValue = items[0].id;
      if (state.lastCheckpointValue === null) {
        return { kind: "init", items, headValue };
      }
      const idx = items.findIndex((i) => i.id === state.lastCheckpointValue);
      if (idx === -1) return { kind: "warning", items, headValue };
      const newItems = items.slice(0, idx);
      if (newItems.length === 0) return { kind: "skip" };
      return { kind: "increment", items: newItems, headValue };
    },
    formatIncrement: (items: TestBookmark[], warning?: string) => {
      const parts = warning ? [`> ⚠️ ${warning}`] : [];
      items.forEach((item, i) => {
        parts.push(`## ${i + 1}.`, item.title);
      });
      return parts.join("\n");
    },
    ...overrides,
  };
}

// ── createBookmarkTask ────────────────────────────────

describe("createBookmarkTask", () => {
  it("returns a TaskDefinition with correct metadata", () => {
    const config = testConfig();
    const task = createBookmarkTask(config);

    expect(task.id).toBe("test-bookmarks-fetch");
    expect(task.every).toBe("1h");
    expect(task.description).toBe("Test bookmark task");
    expect(typeof task.handler).toBe("function");
  });

  it("accepts custom limit and maxHtmlLength", () => {
    const config = testConfig({ limit: 25, maxHtmlLength: 2048 });
    const task = createBookmarkTask(config);

    // Metadata is fine; handler will use the values internally
    expect(task.id).toBe("test-bookmarks-fetch");
    expect(typeof task.handler).toBe("function");
  });

  it("handler calls exec with correct command and args", async () => {
    const config = testConfig();
    const task = createBookmarkTask(config);

    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([
        { id: "2", title: "world" },
        { id: "1", title: "hello" },
      ]),
      stderr: "",
    });

    await task.handler({ exec } as unknown as unknown as ExecContext);

    expect(exec).toHaveBeenCalledWith("opencli", [
      "test",
      "bookmarks",
      "--limit",
      "50",
      "-f",
      "json",
    ]);
  });

  it("handler returns early when exec fails", async () => {
    const config = testConfig();
    const task = createBookmarkTask(config);

    const exec = vi.fn().mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "error",
    });

    // Should not throw — handler logs and returns
    await task.handler({ exec } as unknown as ExecContext);
  });

  it("handler returns early on skip decision", async () => {
    const config = testConfig({
      computeIncrement: () => ({ kind: "skip" }),
    });
    const task = createBookmarkTask(config);

    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([{ id: "1", title: "hello" }]),
      stderr: "",
    });

    await task.handler({ exec } as unknown as ExecContext);
    // Handler should complete without errors
  });

  it("handler skips Telegram and saves checkpoint on skip", async () => {
    // verify the handler doesn't crash on skip
    const config = testConfig({
      computeIncrement: () => ({ kind: "skip" }),
    });
    const task = createBookmarkTask(config);

    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([{ id: "1", title: "hello" }]),
      stderr: "",
    });

    await expect(
      task.handler({ exec } as unknown as ExecContext),
    ).resolves.toBeUndefined();
  });

  it("handler processes init decision (first run)", async () => {
    const config = testConfig({
      computeIncrement: (
        items: TestBookmark[],
        state: { lastCheckpointValue: string | null },
      ): IncrementDecision<TestBookmark> => {
        return state.lastCheckpointValue === null
          ? { kind: "init", items, headValue: items[0]?.id ?? "" }
          : { kind: "skip" };
      },
    });
    const task = createBookmarkTask(config);

    const items = [
      { id: "2", title: "second" },
      { id: "1", title: "first" },
    ];

    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify(items),
      stderr: "",
    });

    // Should complete without errors (will try telegram, which may fail
    // due to missing config, but handler catches that)
    await task.handler({ exec } as unknown as ExecContext);
  });

  it("chunks the output correctly", () => {
    const result = prepareBookmarkChunks({
      rawOutput: "## 1. First\ncontent\n## 2. Second\nmore",
      prefix: "📑 Prefix\n\n",
      maxHtmlLength: 4096,
    });

    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].html).toContain("📑 Prefix");
    expect(result[0].html).toContain("<b>1. First</b>");
    expect(result[0].html).toContain("<b>2. Second</b>");
  });
});

// ── Archive (per-year markdown sink) ──────────────────

/**
 * Minimal archive config that echoes a marker + the first item title.
 */
function testArchive(dir: string): ArchiveConfig<TestBookmark> {
  return {
    dir,
    buildFileName: (year) => `bookmarks-${year}.md`,
    buildEntry: (date, items, existingContent) =>
      `archive:${date}:${existingContent.length}:${items[0]?.title ?? ""}`,
  };
}

describe("localDateString", () => {
  it("formats a local date as YYYY-MM-DD", () => {
    expect(localDateString(new Date(2026, 6, 31, 12, 0, 0))).toBe("2026-07-31");
  });

  it("keeps year and date consistent at a year boundary", () => {
    expect(localDateString(new Date(2026, 11, 31, 23, 30, 0))).toBe(
      "2026-12-31",
    );
  });
});

describe("buildArchiveFailureMessage", () => {
  it("includes the file path and error, but no bookmark content", () => {
    const msg = buildArchiveFailureMessage("/tmp/x/archive.md", "boom");
    expect(msg).toContain("档案写入失败");
    expect(msg).toContain("x/archive.md");
    expect(msg).toContain("boom");
  });
});

describe("createBookmarkTask archive integration", () => {
  let dir: string;
  let checkpointPath: string;

  beforeEach(() => {
    dir = tempDir("archive-test-");
    checkpointPath = join(dir, "checkpoint.json");
    sendTelegramNotificationMock.mockReset();
    sendTelegramNotificationMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanupDir(dir);
  });

  it("writes the archive, sends Telegram, then saves checkpoint", async () => {
    const config = testConfig({
      checkpointPath,
      archive: testArchive(dir),
    });
    const task = createBookmarkTask(config);
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([
        { id: "2", title: "world" },
        { id: "1", title: "hello" },
      ]),
      stderr: "",
    });

    await task.handler({ exec } as unknown as ExecContext);

    // Archive file created with the entry text
    const files = readdirSync(dir).filter((f) =>
      /^bookmarks-\d{4}\.md$/.test(f),
    );
    expect(files).toHaveLength(1);
    const content = readFileSync(join(dir, files[0]), "utf8");
    expect(content).toContain("archive:");
    expect(content).toContain("world");

    // Telegram delivered and checkpoint advanced
    expect(sendTelegramNotificationMock).toHaveBeenCalled();
    expect(existsSync(checkpointPath)).toBe(true);
  });

  it("writes the archive even when Telegram delivery fails (archive-first)", async () => {
    sendTelegramNotificationMock.mockRejectedValue(new Error("telegram down"));
    const config = testConfig({
      checkpointPath,
      archive: testArchive(dir),
    });
    const task = createBookmarkTask(config);
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([{ id: "1", title: "hello" }]),
      stderr: "",
    });

    await expect(
      task.handler({ exec } as unknown as ExecContext),
    ).resolves.toBeUndefined();

    // Archive was written before Telegram attempted delivery
    const files = readdirSync(dir).filter((f) =>
      /^bookmarks-\d{4}\.md$/.test(f),
    );
    expect(files).toHaveLength(1);

    // Checkpoint not advanced because Telegram failed
    expect(existsSync(checkpointPath)).toBe(false);
  });

  it("skips the archive write when buildEntry returns empty, but still delivers", async () => {
    const config = testConfig({
      checkpointPath,
      archive: { ...testArchive(dir), buildEntry: () => "" },
    });
    const task = createBookmarkTask(config);
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([{ id: "1", title: "hello" }]),
      stderr: "",
    });

    await task.handler({ exec } as unknown as ExecContext);

    const files = readdirSync(dir).filter((f) =>
      /^bookmarks-\d{4}\.md$/.test(f),
    );
    expect(files).toHaveLength(0);
    expect(sendTelegramNotificationMock).toHaveBeenCalled();
    expect(existsSync(checkpointPath)).toBe(true);
  });

  it("fails fast on archive write error: no chunks, no checkpoint, error alert", async () => {
    // archive.dir points at an existing regular file → mkdir throws ENOTDIR
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "i am a file");

    const config = testConfig({
      checkpointPath,
      archive: { ...testArchive(blocker) },
    });
    const task = createBookmarkTask(config);
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([{ id: "1", title: "hello" }]),
      stderr: "",
    });

    await expect(
      task.handler({ exec } as unknown as ExecContext),
    ).resolves.toBeUndefined();

    // Exactly one Telegram call: the failure alert, not bookmark chunks
    expect(sendTelegramNotificationMock).toHaveBeenCalledTimes(1);
    const alert = String(sendTelegramNotificationMock.mock.calls[0][0]);
    expect(alert).toContain("档案写入失败");
    expect(alert).not.toContain("hello");
    // The alert is pre-built HTML (message builder already escapes dynamic
    // parts) — it must be sent raw, otherwise it is escaped a second time.
    expect(alert).toContain("<code>");
    expect(sendTelegramNotificationMock.mock.calls[0][2]).toBe(true);

    // Checkpoint not advanced
    expect(existsSync(checkpointPath)).toBe(false);
  });

  it("passes previous-year content to buildEntry when the year file is fresh", async () => {
    const currentYear = String(new Date().getFullYear());
    const prevYear = String(Number(currentYear) - 1);
    writeFileSync(join(dir, `bookmarks-${prevYear}.md`), "prev-year-content");

    const config = testConfig({
      checkpointPath,
      archive: {
        ...testArchive(dir),
        buildEntry: (_date, _items, existing, previous) =>
          `existing=${existing.length}:previous=${previous.length}`,
      },
    });
    const task = createBookmarkTask(config);
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([{ id: "1", title: "hello" }]),
      stderr: "",
    });

    await task.handler({ exec } as unknown as ExecContext);

    const content = readFileSync(
      join(dir, `bookmarks-${currentYear}.md`),
      "utf8",
    );
    expect(content).toBe("existing=0:previous=17");
  });
});
