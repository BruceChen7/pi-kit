import { createHash } from "node:crypto";
import {
  SessionManager as PiSessionManager,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  findAllRepoSessionFiles,
  mergeCacheSessionMetrics,
  metricsFromMessages,
  type SessionFileCandidate,
} from "./all-repo-metrics.ts";
import {
  type ArchivedMetricRow,
  CACHE_GRAPH_ARCHIVE_SCHEMA_VERSION,
  type CacheGraphArchive,
  readCacheGraphArchive,
  type SessionCursor,
  writeCacheGraphArchive,
} from "./archive-store.ts";
import { collectCacheSessionMetrics } from "./session-data.ts";
import type { AssistantUsageMetric, CacheSessionMetrics } from "./types.ts";

export type CacheGraphArchiveDiagnostics = {
  filesScanned: number;
  entriesParsed: number;
  metricsLoadedFromArchive: number;
  metricsParsedFromSessions: number;
  sessionFilesLoadedFromArchive: number;
  sessionFilesParsed: number;
  sessionFilesRebuilt: number;
  sessionFilesSkipped: number;
  archiveRebuildReason?: "missing" | "corrupt" | "schema_mismatch";
};

export type ArchivedCacheMetricsResult = {
  metrics: CacheSessionMetrics;
  diagnostics: CacheGraphArchiveDiagnostics;
};

export type CollectArchivedCacheMetricsOptions = {
  archivePath?: string;
  sessionsRoot?: string;
  now?: Date;
  lookbackDays?: number;
};

type ParsedSessionFile = {
  cursor: SessionCursor;
  rows: ArchivedMetricRow[];
  metrics: CacheSessionMetrics;
  loadedRows: number;
  entriesParsed: number;
  rebuiltFromArchive: boolean;
};

type CollectionState = {
  metricsList: CacheSessionMetrics[];
  nextCursors: SessionCursor[];
  nextRows: ArchivedMetricRow[];
  diagnostics: CacheGraphArchiveDiagnostics;
};

type SessionArchiveAction =
  | { kind: "reuse"; cursor: SessionCursor; rows: ArchivedMetricRow[] }
  | {
      kind: "scan";
      cursor?: SessionCursor;
      archivedRows: ArchivedMetricRow[];
    };

type EntryScanPlan =
  | { kind: "skip" }
  | { kind: "append"; appendedEntries: SessionEntry[] }
  | { kind: "full"; rebuiltFromArchive: boolean };

type UsableArchive = {
  archive: CacheGraphArchive;
  rebuildReason?: CacheGraphArchiveDiagnostics["archiveRebuildReason"];
};

const DEFAULT_LOOKBACK_DAYS = 31;

export async function collectAllRepoCacheMetricsWithArchive(
  options: CollectArchivedCacheMetricsOptions = {},
): Promise<ArchivedCacheMetricsResult> {
  const lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const sessionFiles = findAllRepoSessionFiles(options);
  const archiveRead = await readUsableArchive(options.archivePath);
  const archive = archiveRead.archive;
  const archiveRowsBySession = rowsBySessionFileId(archive.rows);
  const archiveCursorsBySession = cursorsBySessionFileId(archive.cursors);
  const collection = emptyCollectionState(archiveRead.rebuildReason);

  for (const file of sessionFiles) {
    const sessionFileId = sessionFileIdFor(file);
    const cursor = archiveCursorsBySession.get(sessionFileId);
    const rows = archiveRowsBySession.get(sessionFileId) ?? [];

    const action = planSessionArchiveAction(file, cursor, rows);
    if (action.kind === "reuse") {
      addArchivedSession(collection, action.cursor, action.rows);
      continue;
    }

    const parsed = collectMetricsForSessionFile(
      file,
      sessionFileId,
      action.cursor,
      action.archivedRows,
    );
    if (parsed) {
      addParsedSession(collection, parsed);
    } else {
      addSkippedSession(collection);
    }
  }

  const nextArchive = createArchive(
    lookbackDays,
    collection.nextCursors,
    collection.nextRows,
    archive,
  );
  await writeCacheGraphArchive(nextArchive, options.archivePath);

  return {
    metrics: mergeCacheSessionMetrics(collection.metricsList),
    diagnostics: collection.diagnostics,
  };
}

function planSessionArchiveAction(
  file: SessionFileCandidate,
  cursor: SessionCursor | undefined,
  rows: ArchivedMetricRow[],
): SessionArchiveAction {
  if (cursor && isUnchangedSessionFile(file, cursor)) {
    return { kind: "reuse", cursor, rows };
  }
  return { kind: "scan", cursor, archivedRows: rows };
}

function addArchivedSession(
  collection: CollectionState,
  cursor: SessionCursor,
  rows: ArchivedMetricRow[],
): void {
  collection.diagnostics.sessionFilesLoadedFromArchive += 1;
  collection.diagnostics.metricsLoadedFromArchive += rows.length;
  collection.nextCursors.push(cursor);
  collection.nextRows.push(...rows);
  collection.metricsList.push(metricsFromRows(rows));
}

function addParsedSession(
  collection: CollectionState,
  parsed: ParsedSessionFile,
): void {
  collection.diagnostics.filesScanned += 1;
  collection.diagnostics.entriesParsed += parsed.entriesParsed;
  collection.diagnostics.sessionFilesParsed += 1;
  if (parsed.rebuiltFromArchive) {
    collection.diagnostics.sessionFilesRebuilt += 1;
  }
  collection.diagnostics.metricsLoadedFromArchive += parsed.loadedRows;
  collection.diagnostics.metricsParsedFromSessions +=
    parsed.rows.length - parsed.loadedRows;
  collection.nextCursors.push(parsed.cursor);
  collection.nextRows.push(...parsed.rows);
  collection.metricsList.push(parsed.metrics);
}

function addSkippedSession(collection: CollectionState): void {
  collection.diagnostics.sessionFilesSkipped += 1;
}

async function readUsableArchive(
  archivePath: string | undefined,
): Promise<UsableArchive> {
  const result = await readCacheGraphArchive(archivePath);
  if (result.status === "ok") return { archive: result.archive };
  return {
    archive: createArchive(DEFAULT_LOOKBACK_DAYS, [], []),
    rebuildReason: result.reason,
  };
}

function collectMetricsForSessionFile(
  file: SessionFileCandidate,
  sessionFileId: string,
  cursor: SessionCursor | undefined,
  archivedRows: ArchivedMetricRow[],
): ParsedSessionFile | null {
  try {
    const sessionManager = PiSessionManager.open(file.filePath);
    const entries = sessionManager.getEntries();
    const plan = planEntryScan(file, cursor, entries);
    if (plan.kind === "skip") return null;
    if (plan.kind === "append") {
      return collectAppendedMetrics(
        file,
        sessionFileId,
        archivedRows,
        entries,
        plan.appendedEntries,
      );
    }

    return collectFullSessionMetrics(
      file,
      sessionFileId,
      entries,
      plan.rebuiltFromArchive,
    );
  } catch {
    return null;
  }
}

function planEntryScan(
  file: SessionFileCandidate,
  cursor: SessionCursor | undefined,
  entries: SessionEntry[],
): EntryScanPlan {
  if (entries.length === 0 && file.sizeBytes > 0) return { kind: "skip" };
  if (!cursor || !isAppendCandidate(file, cursor)) {
    return { kind: "full", rebuiltFromArchive: cursor !== undefined };
  }

  const cursorIndex = cursor.processedEntryCount - 1;
  if (cursorIndex < 0 || entries[cursorIndex]?.id !== cursor.lastEntryId) {
    return { kind: "full", rebuiltFromArchive: true };
  }

  return {
    kind: "append",
    appendedEntries: entries.slice(cursor.processedEntryCount),
  };
}

function collectAppendedMetrics(
  file: SessionFileCandidate,
  sessionFileId: string,
  archivedRows: ArchivedMetricRow[],
  entries: SessionEntry[],
  appendedEntries: SessionEntry[],
): ParsedSessionFile {
  const appendedMetrics = collectCacheSessionMetrics(
    sessionReaderForEntries(appendedEntries),
    file.repoSlug,
  );
  const appendedRows = appendedMetrics.allMessages.map((metric) =>
    archiveRowFromMetric(sessionFileId, metric),
  );
  const rows = [...archivedRows, ...appendedRows];

  return {
    cursor: cursorFromSessionFile(file, sessionFileId, entries),
    rows,
    metrics: metricsFromRows(rows),
    loadedRows: archivedRows.length,
    entriesParsed: appendedEntries.length,
    rebuiltFromArchive: false,
  };
}

function collectFullSessionMetrics(
  file: SessionFileCandidate,
  sessionFileId: string,
  entries: SessionEntry[],
  rebuiltFromArchive: boolean,
): ParsedSessionFile {
  const metrics = collectCacheSessionMetrics(
    sessionReaderForEntries(entries),
    file.repoSlug,
  );
  const rows = metrics.allMessages.map((metric) =>
    archiveRowFromMetric(sessionFileId, metric),
  );

  return {
    cursor: cursorFromSessionFile(file, sessionFileId, entries),
    rows,
    metrics,
    loadedRows: 0,
    entriesParsed: entries.length,
    rebuiltFromArchive,
  };
}

function createArchive(
  lookbackDays: number,
  cursors: SessionCursor[],
  rows: ArchivedMetricRow[],
  previous?: CacheGraphArchive,
): CacheGraphArchive {
  const now = new Date().toISOString();
  return {
    header: {
      schemaVersion: CACHE_GRAPH_ARCHIVE_SCHEMA_VERSION,
      createdAt: previous?.header.createdAt ?? now,
      updatedAt: now,
      lookbackDays,
    },
    cursors,
    rows,
  };
}

function cursorFromSessionFile(
  file: SessionFileCandidate,
  sessionFileId: string,
  entries: Array<{ id?: unknown; timestamp?: unknown }>,
): SessionCursor {
  const lastEntry = entries.at(-1);
  return {
    sessionFileId,
    sessionFilePath: file.filePath,
    repoSlug: file.repoSlug,
    mtimeMs: file.mtimeMs,
    sizeBytes: file.sizeBytes,
    lastEntryId: readString(lastEntry?.id),
    lastEntryTimestamp: readTimestamp(lastEntry?.timestamp),
    processedEntryCount: entries.length,
    status: "complete",
  };
}

function isUnchangedSessionFile(
  file: SessionFileCandidate,
  cursor: SessionCursor,
): boolean {
  return (
    cursor.status === "complete" &&
    cursor.sessionFilePath === file.filePath &&
    cursor.repoSlug === file.repoSlug &&
    cursor.mtimeMs === file.mtimeMs &&
    cursor.sizeBytes === file.sizeBytes
  );
}

function isAppendCandidate(
  file: SessionFileCandidate,
  cursor: SessionCursor,
): boolean {
  return (
    cursor.status === "complete" &&
    cursor.sessionFilePath === file.filePath &&
    cursor.repoSlug === file.repoSlug &&
    cursor.mtimeMs <= file.mtimeMs &&
    cursor.sizeBytes <= file.sizeBytes
  );
}

function sessionReaderForEntries(entries: SessionEntry[]): {
  getEntries: () => SessionEntry[];
  getBranch: () => SessionEntry[];
} {
  return {
    getEntries: () => entries,
    getBranch: () => [],
  };
}

function rowsBySessionFileId(
  rows: ArchivedMetricRow[],
): Map<string, ArchivedMetricRow[]> {
  const rowsBySession = new Map<string, ArchivedMetricRow[]>();
  for (const row of rows) {
    const sessionRows = rowsBySession.get(row.sessionFileId) ?? [];
    sessionRows.push(row);
    rowsBySession.set(row.sessionFileId, sessionRows);
  }
  return rowsBySession;
}

function cursorsBySessionFileId(
  cursors: SessionCursor[],
): Map<string, SessionCursor> {
  return new Map(cursors.map((cursor) => [cursor.sessionFileId, cursor]));
}

function archiveRowFromMetric(
  sessionFileId: string,
  metric: AssistantUsageMetric,
): ArchivedMetricRow {
  return {
    sessionFileId,
    entryId: metric.entryId,
    repoSlug: metric.repoSlug,
    timestamp: metric.timestamp,
    provider: metric.provider,
    model: metric.model,
    input: metric.input,
    output: metric.output,
    cacheRead: metric.cacheRead,
    cacheWrite: metric.cacheWrite,
    totalTokens: metric.totalTokens,
    cacheHitPercent: metric.cacheHitPercent,
  };
}

function metricsFromRows(rows: ArchivedMetricRow[]): CacheSessionMetrics {
  return metricsFromMessages(rows.map(metricFromArchiveRow));
}

function metricFromArchiveRow(row: ArchivedMetricRow): AssistantUsageMetric {
  return {
    sequence: 0,
    activeBranchSequence: undefined,
    entryId: row.entryId,
    repoSlug: row.repoSlug,
    timestamp: row.timestamp,
    provider: row.provider,
    model: row.model,
    input: row.input,
    output: row.output,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    totalTokens: row.totalTokens,
    cacheHitPercent: row.cacheHitPercent,
    isOnActiveBranch: false,
  };
}

function sessionFileIdFor(file: SessionFileCandidate): string {
  return createHash("sha256")
    .update(file.repoSlug)
    .update("\0")
    .update(file.filePath)
    .digest("hex");
}

function emptyCollectionState(
  archiveRebuildReason?: CacheGraphArchiveDiagnostics["archiveRebuildReason"],
): CollectionState {
  return {
    metricsList: [],
    nextCursors: [],
    nextRows: [],
    diagnostics: {
      filesScanned: 0,
      entriesParsed: 0,
      metricsLoadedFromArchive: 0,
      metricsParsedFromSessions: 0,
      sessionFilesLoadedFromArchive: 0,
      sessionFilesParsed: 0,
      sessionFilesRebuilt: 0,
      sessionFilesSkipped: 0,
      archiveRebuildReason,
    },
  };
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readTimestamp(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return new Date(value).toISOString();
  return new Date(0).toISOString();
}
