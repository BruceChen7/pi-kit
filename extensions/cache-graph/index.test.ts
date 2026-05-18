import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import cacheGraphExtension, {
  collectMetricsWithPersistedFallback,
  normalizeCacheSubcommand,
} from "./index.ts";

type RegisteredCommand = {
  handler: (args: string, ctx: unknown) => Promise<void>;
};

function registerCacheCommand(): RegisteredCommand {
  const registerCommand = vi.fn();
  cacheGraphExtension({ registerCommand } as never);
  return registerCommand.mock.calls[0][1] as RegisteredCommand;
}

describe("cache command", () => {
  it("normalizes graph and export subcommands only", () => {
    expect(normalizeCacheSubcommand(" graph ")).toBe("graph");
    expect(normalizeCacheSubcommand("export")).toBe("export");
    expect(normalizeCacheSubcommand("stats")).toBeNull();
    expect(normalizeCacheSubcommand("unknown")).toBeNull();
  });

  it("shows usage for unknown subcommands", async () => {
    const command = registerCacheCommand();
    const notify = vi.fn();

    await command.handler("wat", {
      ui: { notify },
    });

    expect(notify).toHaveBeenCalledWith(
      "Usage: /cache graph | /cache export",
      "info",
    );
  });

  it("exports cache stats from the command handler", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cache-graph-export-"));
    const command = registerCacheCommand();
    const notify = vi.fn();

    await command.handler("export", {
      cwd: dir,
      sessionManager: {
        getSessionName: () => "Test Session",
        getSessionFile: () => null,
      },
      ui: { notify },
    });

    const filePath = path.join(dir, "Test-Session.csv");
    expect(notify).toHaveBeenCalledWith(
      `Exported cache stats CSV to ${filePath}`,
      "info",
    );
  });

  it("falls back to persisted session file when the live context is empty", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cache-graph-session-"));
    const sessionFile = path.join(dir, "session.jsonl");
    await writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "session",
          timestamp: "2026-05-12T00:00:00.000Z",
          cwd: dir,
        }),
        JSON.stringify({
          type: "message",
          id: "assistant-1",
          parentId: null,
          timestamp: "2026-05-12T00:00:01.000Z",
          message: {
            role: "assistant",
            provider: "openai-codex",
            model: "gpt-5.5",
            usage: {
              input: 100,
              output: 20,
              cacheRead: 300,
              cacheWrite: 0,
              totalTokens: 420,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            content: [],
            stopReason: "stop",
            timestamp: 1778544001000,
          },
        }),
      ].join("\n"),
    );

    const metrics = collectMetricsWithPersistedFallback(
      {
        getEntries: () => [],
        getBranch: () => [],
        getSessionFile: () => sessionFile,
      } as never,
      dir,
    );

    expect(metrics.allMessages).toHaveLength(1);
    expect(metrics.treeTotals.cacheRead).toBe(300);
  });
});
