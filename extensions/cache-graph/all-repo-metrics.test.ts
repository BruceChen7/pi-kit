import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectAllRepoCacheMetrics } from "./all-repo-metrics.ts";

async function writeSession(options: {
  sessionsRoot: string;
  repoSlug: string;
  fileName: string;
  timestamp: string;
  input: number;
  cacheRead: number;
}): Promise<void> {
  const repoDir = path.join(options.sessionsRoot, options.repoSlug);
  await mkdir(repoDir, { recursive: true });
  await writeFile(
    path.join(repoDir, options.fileName),
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: `${options.repoSlug}-session`,
        timestamp: options.timestamp,
        cwd: `/work/${options.repoSlug}`,
      }),
      JSON.stringify({
        type: "message",
        id: `${options.repoSlug}-assistant`,
        parentId: null,
        timestamp: options.timestamp,
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude",
          usage: {
            input: options.input,
            output: 10,
            cacheRead: options.cacheRead,
            cacheWrite: 0,
            totalTokens: options.input + options.cacheRead + 10,
          },
        },
      }),
    ].join("\n"),
  );
}

describe("collectAllRepoCacheMetrics", () => {
  it("collects assistant metrics from all repo session directories", async () => {
    const sessionsRoot = await mkdtemp(
      path.join(tmpdir(), "cache-graph-all-repos-"),
    );
    await writeSession({
      sessionsRoot,
      repoSlug: "repo-a",
      fileName: "a.jsonl",
      timestamp: "2026-05-12T00:00:00.000Z",
      input: 100,
      cacheRead: 20,
    });
    await writeSession({
      sessionsRoot,
      repoSlug: "repo-b",
      fileName: "b.jsonl",
      timestamp: "2026-05-13T00:00:00.000Z",
      input: 200,
      cacheRead: 30,
    });

    const metrics = collectAllRepoCacheMetrics({ sessionsRoot });

    expect(metrics.allMessages.map((message) => message.repoSlug)).toEqual([
      "repo-a",
      "repo-b",
    ]);
    expect(metrics.allMessages.map((message) => message.sequence)).toEqual([
      1, 2,
    ]);
    expect(metrics.treeTotals.input).toBe(300);
    expect(metrics.treeTotals.cacheRead).toBe(50);
  });
});
