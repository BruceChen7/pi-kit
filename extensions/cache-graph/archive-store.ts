import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const CACHE_GRAPH_ARCHIVE_SCHEMA_VERSION = 2;

export type ArchiveHeader = {
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  lookbackDays: number;
  generatorVersion?: string;
};

export type SessionCursorStatus = "complete" | "partial" | "invalid";

export type SessionCursor = {
  sessionFileId: string;
  sessionFilePath: string;
  repoSlug: string;
  mtimeMs: number;
  sizeBytes: number;
  lastEntryId: string;
  lastEntryTimestamp: string;
  processedEntryCount: number;
  status: SessionCursorStatus;
};

export type ArchivedMetricRow = {
  sessionFileId: string;
  entryId: string;
  repoSlug: string;
  timestamp: string;
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cacheHitPercent: number;
};

export type ArchiveSummaryRow = {
  sessionFileId: string;
  repoSlug: string;
  firstTimestamp: string;
  lastTimestamp: string;
  messageCount: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
};

export type CacheGraphArchive = {
  header: ArchiveHeader;
  cursors: SessionCursor[];
  summaries: ArchiveSummaryRow[];
  rows?: ArchivedMetricRow[];
};

export type ReadArchiveResult =
  | { status: "ok"; archive: CacheGraphArchive }
  | { status: "rebuild"; reason: ArchiveRebuildReason };

export type ArchiveRebuildReason = "missing" | "corrupt" | "schema_mismatch";

type JsonFieldType = "string" | "number";

const archiveHeaderStringFields = ["createdAt", "updatedAt"] as const;
const archiveHeaderNumberFields = ["schemaVersion", "lookbackDays"] as const;
const sessionCursorStringFields = [
  "sessionFileId",
  "sessionFilePath",
  "repoSlug",
  "lastEntryId",
  "lastEntryTimestamp",
] as const;
const sessionCursorNumberFields = [
  "mtimeMs",
  "sizeBytes",
  "processedEntryCount",
] as const;
const archivedMetricStringFields = [
  "sessionFileId",
  "entryId",
  "repoSlug",
  "timestamp",
  "provider",
  "model",
] as const;
const archivedMetricNumberFields = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "totalTokens",
  "cacheHitPercent",
] as const;
const archiveSummaryStringFields = [
  "sessionFileId",
  "repoSlug",
  "firstTimestamp",
  "lastTimestamp",
] as const;
const archiveSummaryNumberFields = [
  "messageCount",
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "totalTokens",
] as const;

export function defaultArchivePath(homeDir = os.homedir()): string {
  return path.join(
    homeDir,
    ".pi",
    "agent",
    "cache",
    "cache-graph",
    "archive.json",
  );
}

export async function readCacheGraphArchive(
  archivePath = defaultArchivePath(),
): Promise<ReadArchiveResult> {
  let text: string;
  try {
    text = await readFile(archivePath, "utf8");
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return { status: "rebuild", reason: "missing" };
    }
    return { status: "rebuild", reason: "corrupt" };
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    if (!hasCompatibleArchiveHeader(parsed)) {
      return { status: "rebuild", reason: "corrupt" };
    }
    if (parsed.header.schemaVersion !== CACHE_GRAPH_ARCHIVE_SCHEMA_VERSION) {
      return { status: "rebuild", reason: "schema_mismatch" };
    }
    if (!isCacheGraphArchive(parsed)) {
      return { status: "rebuild", reason: "corrupt" };
    }
    return { status: "ok", archive: parsed };
  } catch {
    return { status: "rebuild", reason: "corrupt" };
  }
}

export async function writeCacheGraphArchive(
  archive: CacheGraphArchive,
  archivePath = defaultArchivePath(),
): Promise<void> {
  await mkdir(path.dirname(archivePath), { recursive: true });

  const tempPath = `${archivePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(archive)}\n`, "utf8");
  await rename(tempPath, archivePath);
}

function isCacheGraphArchive(value: unknown): value is CacheGraphArchive {
  if (!isRecord(value)) return false;
  return (
    isArchiveHeader(value.header) &&
    Array.isArray(value.cursors) &&
    value.cursors.every(isSessionCursor) &&
    Array.isArray(value.summaries) &&
    value.summaries.every(isArchiveSummaryRow) &&
    (value.rows === undefined ||
      (Array.isArray(value.rows) && value.rows.every(isArchivedMetricRow)))
  );
}

function hasCompatibleArchiveHeader(
  value: unknown,
): value is { header: ArchiveHeader } {
  return isRecord(value) && isArchiveHeader(value.header);
}

function isArchiveHeader(value: unknown): value is ArchiveHeader {
  if (!isRecord(value)) return false;
  return (
    hasFieldsOfType(value, archiveHeaderStringFields, "string") &&
    hasFieldsOfType(value, archiveHeaderNumberFields, "number") &&
    (value.generatorVersion === undefined ||
      typeof value.generatorVersion === "string")
  );
}

function isSessionCursor(value: unknown): value is SessionCursor {
  if (!isRecord(value)) return false;
  return (
    hasFieldsOfType(value, sessionCursorStringFields, "string") &&
    hasFieldsOfType(value, sessionCursorNumberFields, "number") &&
    isSessionCursorStatus(value.status)
  );
}

function isArchivedMetricRow(value: unknown): value is ArchivedMetricRow {
  if (!isRecord(value)) return false;
  return (
    hasFieldsOfType(value, archivedMetricStringFields, "string") &&
    hasFieldsOfType(value, archivedMetricNumberFields, "number")
  );
}

function isArchiveSummaryRow(value: unknown): value is ArchiveSummaryRow {
  if (!isRecord(value)) return false;
  return (
    hasFieldsOfType(value, archiveSummaryStringFields, "string") &&
    hasFieldsOfType(value, archiveSummaryNumberFields, "number")
  );
}

function isSessionCursorStatus(value: unknown): value is SessionCursorStatus {
  return value === "complete" || value === "partial" || value === "invalid";
}

function hasFieldsOfType(
  value: Record<string, unknown>,
  fields: readonly string[],
  type: JsonFieldType,
): boolean {
  return fields.every((field) => typeof value[field] === type);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
