import type { SessionManager } from "@earendil-works/pi-coding-agent";
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
