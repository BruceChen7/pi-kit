import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { collectAllRepoCacheMetrics } from "./all-repo-metrics.ts";
import { exportStatsCsv } from "./export.ts";
import type { CacheSessionMetrics } from "./types.ts";

export type CacheStatsActions = {
  getMetrics: () => CacheSessionMetrics;
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
  const getMetrics = () => collectAllRepoCacheMetrics();

  return {
    getMetrics,
    exportCsv: () => exportStatsCsv(cwd, sessionManager, getMetrics()),
  };
}

export function formatExportSuccess(filePath: string): string {
  return `Exported cache stats CSV to ${filePath}`;
}
