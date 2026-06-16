import path from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { formatRepoSlug } from "./all-repo-metrics.ts";
import { collectAllRepoCacheMetricsWithArchive } from "./archive-metrics.ts";
import { exportStatsCsv } from "./export.ts";
import type { CacheSessionMetrics } from "./types.ts";

export type CacheStatsActions = {
  getMetrics: () => Promise<CacheSessionMetrics>;
  exportCsv: () => Promise<string>;
};

type CacheStatsActionsInput = {
  cwd: string;
  sessionManager: Pick<SessionManager, "getSessionName" | "getSessionFile">;
};

export function deriveDefaultRepoSlug(
  sessionFile: string | undefined | null,
): string | undefined {
  if (!sessionFile) return undefined;
  const repoDir = path.basename(path.dirname(sessionFile));
  return formatRepoSlug(repoDir) || undefined;
}

export function createCacheStatsActions({
  cwd,
  sessionManager,
}: CacheStatsActionsInput): CacheStatsActions {
  const getMetrics = collectArchivedMetrics;

  return {
    getMetrics,
    exportCsv: async () =>
      exportStatsCsv(cwd, sessionManager, await getMetrics()),
  };
}

async function collectArchivedMetrics(): Promise<CacheSessionMetrics> {
  const result = await collectAllRepoCacheMetricsWithArchive();
  return result.metrics;
}

export function formatExportSuccess(filePath: string): string {
  return `Exported cache stats CSV to ${filePath}`;
}
