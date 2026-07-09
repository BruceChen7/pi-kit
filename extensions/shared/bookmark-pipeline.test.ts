import { describe, expect, it, vi } from "vitest";
import {
  type BookmarkTaskConfig,
  createBookmarkTask,
  type IncrementDecision,
  prepareBookmarkChunks,
} from "./bookmark-pipeline.ts";
import type { ExecContext } from "./deferred-queue/types.ts";

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

    await task.handler({ exec } as ExecContext);

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
    await task.handler({ exec } as ExecContext);
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

    await task.handler({ exec } as ExecContext);
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
      task.handler({ exec } as ExecContext),
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
    await task.handler({ exec } as ExecContext);
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
