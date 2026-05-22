import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectAllRepoCacheMetrics } from "./all-repo-metrics.ts";
import {
  type CacheGraphArchiveDiagnostics,
  collectAllRepoCacheMetricsWithArchive,
} from "./archive-metrics.ts";

type SessionWriteOptions = {
  sessionsRoot: string;
  repoSlug: string;
  fileName: string;
  timestamp: string;
  input: number;
  cacheRead: number;
  assistantId?: string;
};

type AssistantMessageOptions = {
  id: string;
  timestamp: string;
  input: number;
  output?: number;
  cacheRead: number;
  cacheWrite?: number;
};

async function writeSession(options: SessionWriteOptions): Promise<string> {
  const repoDir = path.join(options.sessionsRoot, options.repoSlug);
  const sessionPath = path.join(repoDir, options.fileName);
  await mkdir(repoDir, { recursive: true });
  await writeFile(
    sessionPath,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: `${options.repoSlug}-session`,
        timestamp: options.timestamp,
        cwd: `/work/${options.repoSlug}`,
      }),
      JSON.stringify(
        assistantMessage({
          id: options.assistantId ?? `${options.repoSlug}-assistant`,
          timestamp: options.timestamp,
          input: options.input,
          cacheRead: options.cacheRead,
        }),
      ),
    ].join("\n"),
  );
  return sessionPath;
}

function assistantMessage(options: AssistantMessageOptions): unknown {
  const output = options.output ?? 10;
  const cacheWrite = options.cacheWrite ?? 0;
  return {
    type: "message",
    id: options.id,
    parentId: null,
    timestamp: options.timestamp,
    message: {
      role: "assistant",
      provider: "anthropic",
      model: "claude",
      usage: {
        input: options.input,
        output,
        cacheRead: options.cacheRead,
        cacheWrite,
        totalTokens: options.input + output + options.cacheRead + cacheWrite,
      },
    },
  };
}

function userMessage(id: string, timestamp: string): unknown {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp,
    message: { role: "user", content: "ignored for usage" },
  };
}

async function writeSessionEntries(options: {
  sessionsRoot: string;
  repoSlug: string;
  fileName: string;
  timestamp: string;
  assistantCount: number;
}): Promise<string> {
  const repoDir = path.join(options.sessionsRoot, options.repoSlug);
  const sessionPath = path.join(repoDir, options.fileName);
  await mkdir(repoDir, { recursive: true });
  const entries = [
    {
      type: "session",
      version: 3,
      id: `${options.repoSlug}-${options.fileName}-session`,
      timestamp: options.timestamp,
      cwd: `/work/${options.repoSlug}`,
    },
    ...Array.from({ length: options.assistantCount }, (_value, index) =>
      assistantMessage({
        id: `${options.repoSlug}-${options.fileName}-assistant-${index + 1}`,
        timestamp: options.timestamp,
        input: 10 + index,
        cacheRead: index,
      }),
    ),
  ];
  await writeFile(sessionPath, jsonl(entries), "utf8");
  return sessionPath;
}

async function createArchiveFixture(): Promise<{
  sessionsRoot: string;
  archivePath: string;
  repoASessionPath: string;
}> {
  const root = await mkdtemp(
    path.join(tmpdir(), "cache-graph-archive-metrics-"),
  );
  const sessionsRoot = path.join(root, "sessions");
  const repoASessionPath = await writeSession({
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

  return {
    sessionsRoot,
    archivePath: path.join(root, "cache", "archive.json"),
    repoASessionPath,
  };
}

async function createBenchmarkFixture(): Promise<{
  sessionsRoot: string;
  archivePath: string;
  firstSessionPath: string;
}> {
  const root = await mkdtemp(
    path.join(tmpdir(), "cache-graph-archive-benchmark-"),
  );
  const sessionsRoot = path.join(root, "sessions");
  const firstSessionPath = await writeSessionEntries({
    sessionsRoot,
    repoSlug: "repo-a",
    fileName: "a1.jsonl",
    timestamp: "2026-05-12T00:00:00.000Z",
    assistantCount: 2,
  });
  await writeSessionEntries({
    sessionsRoot,
    repoSlug: "repo-a",
    fileName: "a2.jsonl",
    timestamp: "2026-05-13T00:00:00.000Z",
    assistantCount: 2,
  });
  await writeSessionEntries({
    sessionsRoot,
    repoSlug: "repo-b",
    fileName: "b1.jsonl",
    timestamp: "2026-05-14T00:00:00.000Z",
    assistantCount: 2,
  });

  return {
    sessionsRoot,
    archivePath: path.join(root, "cache", "archive.json"),
    firstSessionPath,
  };
}

async function appendEntries(
  sessionPath: string,
  entries: unknown[],
): Promise<void> {
  await appendFile(sessionPath, `\n${jsonl(entries)}`, "utf8");
}

function jsonl(entries: unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n");
}

function expectedDiagnostics(
  overrides: Partial<CacheGraphArchiveDiagnostics>,
): CacheGraphArchiveDiagnostics {
  return {
    filesScanned: 0,
    entriesParsed: 0,
    metricsLoadedFromArchive: 0,
    metricsParsedFromSessions: 0,
    sessionFilesLoadedFromArchive: 0,
    sessionFilesParsed: 0,
    sessionFilesRebuilt: 0,
    sessionFilesSkipped: 0,
    archiveRebuildReason: undefined,
    ...overrides,
  };
}

describe("collectAllRepoCacheMetricsWithArchive", () => {
  it("records cold, hot, and append diagnostics for a multi-repo fixture", async () => {
    const { sessionsRoot, archivePath, firstSessionPath } =
      await createBenchmarkFixture();
    const options = { sessionsRoot, archivePath };

    const cold = await collectAllRepoCacheMetricsWithArchive(options);
    const hot = await collectAllRepoCacheMetricsWithArchive(options);
    await appendEntries(firstSessionPath, [
      userMessage("repo-a-a1-user-2", "2026-05-15T00:00:00.000Z"),
      assistantMessage({
        id: "repo-a-a1-assistant-3",
        timestamp: "2026-05-15T00:00:01.000Z",
        input: 20,
        cacheRead: 2,
      }),
    ]);
    const appended = await collectAllRepoCacheMetricsWithArchive(options);
    const fullScan = collectAllRepoCacheMetrics({ sessionsRoot });

    expect(cold.diagnostics).toEqual(
      expectedDiagnostics({
        filesScanned: 3,
        entriesParsed: 6,
        metricsParsedFromSessions: 6,
        sessionFilesParsed: 3,
        archiveRebuildReason: "missing",
      }),
    );
    expect(hot.diagnostics).toEqual(
      expectedDiagnostics({
        metricsLoadedFromArchive: 6,
        sessionFilesLoadedFromArchive: 3,
      }),
    );
    expect(appended.diagnostics).toEqual(
      expectedDiagnostics({
        filesScanned: 1,
        entriesParsed: 2,
        metricsLoadedFromArchive: 6,
        metricsParsedFromSessions: 1,
        sessionFilesLoadedFromArchive: 2,
        sessionFilesParsed: 1,
      }),
    );
    expect(appended.metrics).toEqual(fullScan);
  });

  it("builds the archive on first collection and reuses unchanged sessions", async () => {
    const { sessionsRoot, archivePath } = await createArchiveFixture();
    const options = { sessionsRoot, archivePath };

    const first = await collectAllRepoCacheMetricsWithArchive(options);
    const archive = JSON.parse(await readFile(archivePath, "utf8"));
    const second = await collectAllRepoCacheMetricsWithArchive(options);
    const fullScan = collectAllRepoCacheMetrics({ sessionsRoot });

    expect(first.diagnostics).toEqual(
      expectedDiagnostics({
        filesScanned: 2,
        entriesParsed: 2,
        metricsParsedFromSessions: 2,
        sessionFilesParsed: 2,
        archiveRebuildReason: "missing",
      }),
    );
    expect(archive.summaries).toHaveLength(2);
    expect(archive.summaries[0]).toMatchObject({
      messageCount: 1,
      totalTokens: 130,
    });
    expect(second.diagnostics).toEqual(
      expectedDiagnostics({
        metricsLoadedFromArchive: 2,
        sessionFilesLoadedFromArchive: 2,
      }),
    );
    expect(second.metrics).toEqual(fullScan);
  });

  it("rebuilds details from sessions when summary-first archive omits rows", async () => {
    const { sessionsRoot, archivePath } = await createArchiveFixture();
    const options = { sessionsRoot, archivePath };

    await collectAllRepoCacheMetricsWithArchive(options);
    const archive = JSON.parse(await readFile(archivePath, "utf8"));
    delete archive.rows;
    await writeFile(archivePath, JSON.stringify(archive), "utf8");

    const rebuilt = await collectAllRepoCacheMetricsWithArchive(options);
    const fullScan = collectAllRepoCacheMetrics({ sessionsRoot });

    expect(rebuilt.diagnostics).toEqual(
      expectedDiagnostics({
        filesScanned: 2,
        entriesParsed: 2,
        metricsParsedFromSessions: 2,
        sessionFilesParsed: 2,
      }),
    );
    expect(rebuilt.metrics).toEqual(fullScan);
  });

  it("only parses entries appended after the stored cursor", async () => {
    const { sessionsRoot, archivePath, repoASessionPath } =
      await createArchiveFixture();
    const options = { sessionsRoot, archivePath };

    await collectAllRepoCacheMetricsWithArchive(options);
    await appendEntries(repoASessionPath, [
      userMessage("repo-a-user-2", "2026-05-14T00:00:00.000Z"),
      assistantMessage({
        id: "repo-a-assistant-2",
        timestamp: "2026-05-14T00:00:01.000Z",
        input: 50,
        cacheRead: 5,
      }),
    ]);

    const appended = await collectAllRepoCacheMetricsWithArchive(options);
    const unchangedAfterAppend =
      await collectAllRepoCacheMetricsWithArchive(options);
    const fullScan = collectAllRepoCacheMetrics({ sessionsRoot });

    expect(appended.diagnostics).toEqual(
      expectedDiagnostics({
        filesScanned: 1,
        entriesParsed: 2,
        metricsLoadedFromArchive: 2,
        metricsParsedFromSessions: 1,
        sessionFilesLoadedFromArchive: 1,
        sessionFilesParsed: 1,
      }),
    );
    expect(appended.metrics).toEqual(fullScan);
    expect(unchangedAfterAppend.diagnostics).toEqual(
      expectedDiagnostics({
        metricsLoadedFromArchive: 3,
        sessionFilesLoadedFromArchive: 2,
      }),
    );
  });

  it("rebuilds only the truncated session when its size shrinks", async () => {
    const { sessionsRoot, archivePath, repoASessionPath } =
      await createArchiveFixture();
    const options = { sessionsRoot, archivePath };

    await collectAllRepoCacheMetricsWithArchive(options);
    await writeFile(
      repoASessionPath,
      jsonl([
        {
          type: "session",
          version: 3,
          id: "repo-a-session",
          timestamp: "2026-05-12T00:00:00.000Z",
          cwd: "/work/repo-a",
        },
        userMessage("repo-a-user-only", "2026-05-12T00:00:01.000Z"),
      ]),
      "utf8",
    );

    const rebuilt = await collectAllRepoCacheMetricsWithArchive(options);
    const fullScan = collectAllRepoCacheMetrics({ sessionsRoot });

    expect(rebuilt.diagnostics).toEqual(
      expectedDiagnostics({
        filesScanned: 1,
        entriesParsed: 1,
        metricsLoadedFromArchive: 1,
        sessionFilesLoadedFromArchive: 1,
        sessionFilesParsed: 1,
        sessionFilesRebuilt: 1,
      }),
    );
    expect(rebuilt.metrics).toEqual(fullScan);
  });

  it("rebuilds only the changed session when the cursor cannot be trusted", async () => {
    const { sessionsRoot, archivePath } = await createArchiveFixture();
    const options = { sessionsRoot, archivePath };

    await collectAllRepoCacheMetricsWithArchive(options);
    await writeSession({
      sessionsRoot,
      repoSlug: "repo-a",
      fileName: "a.jsonl",
      timestamp: "2026-05-15T00:00:00.000Z",
      input: 10,
      cacheRead: 1,
      assistantId: "repo-a-rewritten-assistant",
    });

    const rebuilt = await collectAllRepoCacheMetricsWithArchive(options);
    const fullScan = collectAllRepoCacheMetrics({ sessionsRoot });

    expect(rebuilt.diagnostics).toEqual(
      expectedDiagnostics({
        filesScanned: 1,
        entriesParsed: 1,
        metricsLoadedFromArchive: 1,
        metricsParsedFromSessions: 1,
        sessionFilesLoadedFromArchive: 1,
        sessionFilesParsed: 1,
        sessionFilesRebuilt: 1,
      }),
    );
    expect(rebuilt.metrics).toEqual(fullScan);
  });

  it("skips a single bad session file without blocking other repos", async () => {
    const { sessionsRoot, archivePath, repoASessionPath } =
      await createArchiveFixture();
    const options = { sessionsRoot, archivePath };

    await collectAllRepoCacheMetricsWithArchive(options);
    await writeFile(repoASessionPath, "not json", "utf8");

    const collected = await collectAllRepoCacheMetricsWithArchive(options);
    const fullScan = collectAllRepoCacheMetrics({ sessionsRoot });

    expect(collected.diagnostics).toEqual(
      expectedDiagnostics({
        metricsLoadedFromArchive: 1,
        sessionFilesLoadedFromArchive: 1,
        sessionFilesSkipped: 1,
      }),
    );
    expect(collected.metrics).toEqual(fullScan);
  });

  it("rebuilds from sessions when the archive is corrupt", async () => {
    const { sessionsRoot, archivePath } = await createArchiveFixture();
    const options = { sessionsRoot, archivePath };

    await collectAllRepoCacheMetricsWithArchive(options);
    await writeFile(archivePath, "not json", "utf8");

    const rebuilt = await collectAllRepoCacheMetricsWithArchive(options);
    const fullScan = collectAllRepoCacheMetrics({ sessionsRoot });

    expect(rebuilt.diagnostics).toEqual(
      expectedDiagnostics({
        filesScanned: 2,
        entriesParsed: 2,
        metricsParsedFromSessions: 2,
        sessionFilesParsed: 2,
        archiveRebuildReason: "corrupt",
      }),
    );
    expect(rebuilt.metrics).toEqual(fullScan);
  });

  it("rebuilds from sessions when the archive schema changes", async () => {
    const { sessionsRoot, archivePath } = await createArchiveFixture();
    const options = { sessionsRoot, archivePath };

    await collectAllRepoCacheMetricsWithArchive(options);
    await writeFile(
      archivePath,
      JSON.stringify({
        header: {
          schemaVersion: 999,
          createdAt: "2026-05-22T00:00:00.000Z",
          updatedAt: "2026-05-22T00:00:00.000Z",
          lookbackDays: 31,
        },
        cursors: [],
        rows: [],
      }),
      "utf8",
    );

    const rebuilt = await collectAllRepoCacheMetricsWithArchive(options);
    const fullScan = collectAllRepoCacheMetrics({ sessionsRoot });

    expect(rebuilt.diagnostics).toEqual(
      expectedDiagnostics({
        filesScanned: 2,
        entriesParsed: 2,
        metricsParsedFromSessions: 2,
        sessionFilesParsed: 2,
        archiveRebuildReason: "schema_mismatch",
      }),
    );
    expect(rebuilt.metrics).toEqual(fullScan);
  });
});
