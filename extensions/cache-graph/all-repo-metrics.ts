import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager as PiSessionManager } from "@earendil-works/pi-coding-agent";
import { addToTotals, emptyTotals } from "./cache-math.ts";
import { collectCacheSessionMetrics } from "./session-data.ts";
import type { AssistantUsageMetric, CacheSessionMetrics } from "./types.ts";

const DEFAULT_LOOKBACK_DAYS = 31;

export type SessionFileCandidate = {
  filePath: string;
  repoSlug: string;
  mtimeMs: number;
  sizeBytes: number;
};

export type CollectAllRepoCacheMetricsOptions = {
  sessionsRoot?: string;
  now?: Date;
  lookbackDays?: number;
};

export function collectAllRepoCacheMetrics(
  options: CollectAllRepoCacheMetricsOptions = {},
): CacheSessionMetrics {
  const sessionFiles = findAllRepoSessionFiles(options);
  return mergeCacheSessionMetrics(sessionFiles.flatMap(collectMetricsForFile));
}

function collectMetricsForFile(
  file: SessionFileCandidate,
): CacheSessionMetrics[] {
  try {
    return [
      collectCacheSessionMetrics(
        PiSessionManager.open(file.filePath),
        file.repoSlug,
      ),
    ];
  } catch {
    return [];
  }
}

export function findAllRepoSessionFiles(
  options: CollectAllRepoCacheMetricsOptions = {},
): SessionFileCandidate[] {
  const sessionsRoot = options.sessionsRoot ?? defaultSessionsRoot();
  const nowMs = (options.now ?? new Date()).getTime();
  const lookbackMs =
    (options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS) * 24 * 60 * 60 * 1000;
  const minMtimeMs = nowMs - lookbackMs;

  const candidates = listDirents(sessionsRoot).flatMap((repoDir) =>
    sessionFileCandidatesForRepo(sessionsRoot, repoDir, minMtimeMs),
  );

  return candidates.sort((left, right) => {
    if (left.mtimeMs !== right.mtimeMs) return left.mtimeMs - right.mtimeMs;
    return left.filePath.localeCompare(right.filePath);
  });
}

function sessionFileCandidatesForRepo(
  sessionsRoot: string,
  repoDir: fs.Dirent,
  minMtimeMs: number,
): SessionFileCandidate[] {
  if (!repoDir.isDirectory()) return [];

  const repoPath = path.join(sessionsRoot, repoDir.name);
  return listDirents(repoPath).flatMap((entry) =>
    sessionFileCandidateForEntry(repoPath, repoDir.name, entry, minMtimeMs),
  );
}

function sessionFileCandidateForEntry(
  repoPath: string,
  repoDirName: string,
  entry: fs.Dirent,
  minMtimeMs: number,
): SessionFileCandidate[] {
  if (!entry.isFile() || !entry.name.endsWith(".jsonl")) return [];

  const filePath = path.join(repoPath, entry.name);
  try {
    const stats = fs.statSync(filePath);
    if (stats.mtimeMs < minMtimeMs) return [];
    return [
      {
        filePath,
        repoSlug: formatRepoSlug(repoDirName),
        mtimeMs: stats.mtimeMs,
        sizeBytes: stats.size,
      },
    ];
  } catch {
    return [];
  }
}

function listDirents(dirPath: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function mergeCacheSessionMetrics(
  metricsList: CacheSessionMetrics[],
): CacheSessionMetrics {
  const allMessages = metricsList
    .flatMap((metrics) => metrics.allMessages)
    .sort(compareMetricTime)
    .map((message, index) => ({
      ...message,
      sequence: index + 1,
      activeBranchSequence: undefined,
      isOnActiveBranch: false,
    }));

  return metricsFromMessages(allMessages);
}

export function metricsFromMessages(
  allMessages: AssistantUsageMetric[],
): CacheSessionMetrics {
  const treeTotals = emptyTotals();
  const activeBranchTotals = emptyTotals();
  for (const message of allMessages) {
    addToTotals(treeTotals, message);
  }

  return {
    allMessages,
    activeBranchMessages: [],
    treeTotals,
    activeBranchTotals,
  };
}

function compareMetricTime(
  left: AssistantUsageMetric,
  right: AssistantUsageMetric,
): number {
  const timeDelta = Date.parse(left.timestamp) - Date.parse(right.timestamp);
  if (Number.isFinite(timeDelta) && timeDelta !== 0) return timeDelta;
  const repoDelta = left.repoSlug.localeCompare(right.repoSlug);
  if (repoDelta !== 0) return repoDelta;
  return left.entryId.localeCompare(right.entryId);
}

function defaultSessionsRoot(): string {
  return path.join(os.homedir(), ".pi", "agent", "sessions");
}

export function formatRepoSlug(directoryName: string): string {
  const trimmed = directoryName.replace(/^--|--$/g, "");
  if (!trimmed) return directoryName;

  const homeSlugPrefix = slugPath(os.homedir());
  if (homeSlugPrefix && trimmed.startsWith(`${homeSlugPrefix}-`)) {
    return trimmed.slice(homeSlugPrefix.length + 1);
  }

  const unixHomePathMatch = /^(?:Users|home)-[^-]+-(.+)$/.exec(trimmed);
  if (unixHomePathMatch) return unixHomePathMatch[1];

  const windowsHomePathMatch = /^[A-Za-z]--Users-[^-]+-(.+)$/.exec(trimmed);
  return windowsHomePathMatch?.[1] || trimmed;
}

function slugPath(filePath: string): string {
  return filePath.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
}
