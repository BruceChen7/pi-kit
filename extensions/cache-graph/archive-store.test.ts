import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CACHE_GRAPH_ARCHIVE_SCHEMA_VERSION,
  type CacheGraphArchive,
  defaultArchivePath,
  type ReadArchiveResult,
  readCacheGraphArchive,
  writeCacheGraphArchive,
} from "./archive-store.ts";

const timestamp = "2026-05-22T00:00:00.000Z";

function archiveFixture(
  overrides: Partial<CacheGraphArchive> = {},
): CacheGraphArchive {
  return {
    header: {
      schemaVersion: CACHE_GRAPH_ARCHIVE_SCHEMA_VERSION,
      createdAt: timestamp,
      updatedAt: timestamp,
      lookbackDays: 31,
    },
    cursors: [
      {
        sessionFileId: "session-a",
        sessionFilePath: "/tmp/session-a.jsonl",
        repoSlug: "repo-a",
        mtimeMs: 1000,
        sizeBytes: 2000,
        lastEntryId: "entry-a",
        lastEntryTimestamp: timestamp,
        processedEntryCount: 2,
        status: "complete",
      },
    ],
    rows: [
      {
        sessionFileId: "session-a",
        entryId: "entry-a",
        repoSlug: "repo-a",
        timestamp,
        provider: "anthropic",
        model: "claude",
        input: 100,
        output: 10,
        cacheRead: 20,
        cacheWrite: 5,
        totalTokens: 135,
        cacheHitPercent: 16,
      },
    ],
    ...overrides,
  };
}

async function tempArchivePath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cache-graph-archive-"));
  return path.join(dir, "nested", "archive.json");
}

function expectOkArchive(result: ReadArchiveResult): CacheGraphArchive {
  expect(result.status).toBe("ok");
  if (result.status !== "ok") {
    throw new Error(`Expected archive read to succeed, got ${result.reason}`);
  }
  return result.archive;
}

describe("cache graph archive store", () => {
  it("uses the Pi agent cache directory by default", () => {
    expect(defaultArchivePath("/home/ming")).toBe(
      path.join(
        "/home/ming",
        ".pi",
        "agent",
        "cache",
        "cache-graph",
        "archive.json",
      ),
    );
  });

  it("roundtrips archive header, cursors, and metric rows", async () => {
    const archivePath = await tempArchivePath();
    const archive = archiveFixture();

    await writeCacheGraphArchive(archive, archivePath);
    const result = await readCacheGraphArchive(archivePath);
    const restored = expectOkArchive(result);

    expect(restored.header.schemaVersion).toBe(
      CACHE_GRAPH_ARCHIVE_SCHEMA_VERSION,
    );
    expect(restored.cursors).toEqual(archive.cursors);
    expect(restored.rows).toEqual(archive.rows);
  });

  it("returns rebuild when the archive is missing", async () => {
    const result = await readCacheGraphArchive(await tempArchivePath());

    expect(result).toEqual({ status: "rebuild", reason: "missing" });
  });

  it("returns rebuild when the schema version is incompatible", async () => {
    const archivePath = await tempArchivePath();
    await writeCacheGraphArchive(
      archiveFixture({
        header: {
          schemaVersion: CACHE_GRAPH_ARCHIVE_SCHEMA_VERSION + 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          lookbackDays: 31,
        },
      }),
      archivePath,
    );

    const result = await readCacheGraphArchive(archivePath);

    expect(result).toEqual({ status: "rebuild", reason: "schema_mismatch" });
  });

  it("returns rebuild when the archive content is corrupt", async () => {
    const archivePath = await tempArchivePath();
    await writeCacheGraphArchive(archiveFixture(), archivePath);
    await writeFile(archivePath, "not json", "utf8");

    const result = await readCacheGraphArchive(archivePath);

    expect(result).toEqual({ status: "rebuild", reason: "corrupt" });
  });

  it("returns rebuild when the archive shape is invalid", async () => {
    const archivePath = await tempArchivePath();
    await writeCacheGraphArchive(archiveFixture(), archivePath);
    await writeFile(archivePath, JSON.stringify({ header: {} }), "utf8");

    const result = await readCacheGraphArchive(archivePath);

    expect(result).toEqual({ status: "rebuild", reason: "corrupt" });
  });
});
