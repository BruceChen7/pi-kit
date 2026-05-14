// https://github.com/championswimmer/pi-cache-graph
import {
  type ExtensionAPI,
  SessionManager as PiSessionManager,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { collectAllRepoCacheMetrics } from "./all-repo-metrics.ts";
import { exportStatsCsv } from "./export.ts";
import { openCacheGraphDashboard } from "./glimpse-host.ts";
import { collectCacheSessionMetrics } from "./session-data.ts";
import type { CacheSessionMetrics } from "./types.ts";

type CacheSubcommand = "graph" | "export";

const cacheSubcommands = [
  { value: "graph", label: "graph", description: "Open cache dashboard" },
  { value: "export", label: "export", description: "Export cache CSV" },
];

export function normalizeCacheSubcommand(args: string): CacheSubcommand | null {
  const command = args.trim().toLowerCase();
  if (command === "graph" || command === "export") {
    return command;
  }
  return null;
}

export default function cacheGraphExtension(pi: ExtensionAPI): void {
  pi.registerCommand("cache", {
    description: "Show context cache dashboard or export CSV",
    getArgumentCompletions(prefix) {
      const normalizedPrefix = prefix.toLowerCase();
      const filtered = cacheSubcommands.filter((item) =>
        item.value.startsWith(normalizedPrefix),
      );
      return filtered.length > 0 ? filtered : cacheSubcommands;
    },
    handler: async (args, ctx) => {
      const subcommand = normalizeCacheSubcommand(args);
      if (!subcommand) {
        ctx.ui.notify("Usage: /cache graph | /cache export", "info");
        return;
      }

      const getMetrics = () => collectAllRepoCacheMetrics();
      const exportCsv = () =>
        exportStatsCsv(ctx.cwd, ctx.sessionManager, getMetrics());

      if (subcommand === "export") {
        const filePath = await exportCsv();
        ctx.ui.notify(`Exported cache stats CSV to ${filePath}`, "info");
        return;
      }

      if (!ctx.hasUI) {
        ctx.ui.notify(
          "/cache graph requires interactive UI. Use /cache export in non-interactive mode.",
          "info",
        );
        return;
      }

      try {
        await openCacheGraphDashboard({
          getMetrics,
          exportCsv,
        });
      } catch (error) {
        ctx.ui.notify(
          `Failed to open cache graph dashboard: ${errorMessage(error)}`,
          "error",
        );
      }
    },
  });
}

type SessionReader = Pick<
  SessionManager,
  "getEntries" | "getBranch" | "getSessionFile"
>;

export function collectMetricsWithPersistedFallback(
  sessionManager: SessionReader,
  cwd: string,
): CacheSessionMetrics {
  const metrics = collectCacheSessionMetrics(sessionManager);
  if (metrics.allMessages.length > 0) return metrics;

  const sessionFile = sessionManager.getSessionFile();
  const persistedMetrics = collectPersistedMetrics(sessionFile);
  if (persistedMetrics?.allMessages.length) return persistedMetrics;

  const recentMetrics = collectRecentMetrics(cwd);
  if (recentMetrics?.allMessages.length) return recentMetrics;

  return metrics;
}

function collectPersistedMetrics(
  sessionFile: string | undefined,
): CacheSessionMetrics | null {
  if (!sessionFile) return null;
  try {
    return collectCacheSessionMetrics(PiSessionManager.open(sessionFile));
  } catch {
    return null;
  }
}

function collectRecentMetrics(cwd: string): CacheSessionMetrics | null {
  try {
    return collectCacheSessionMetrics(PiSessionManager.continueRecent(cwd));
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
