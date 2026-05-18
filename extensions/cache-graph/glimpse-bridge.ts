import type { GlimpseWindow } from "../shared/glimpse-window.ts";
import { formatExportSuccess } from "./cache-actions.ts";
import type { CacheSessionMetrics } from "./types.ts";

export type CacheGraphBridgeInput = {
  window: GlimpseWindow;
  getMetrics: () => CacheSessionMetrics;
  exportCsv: () => Promise<string>;
};

type DashboardResult =
  | { type: "metrics"; ok: true; metrics: CacheSessionMetrics }
  | { type: "export-result"; ok: true; filePath: string; message: string }
  | { type: "error"; ok: false; action: "refresh" | "export"; message: string };

export function attachCacheGraphBridge(input: CacheGraphBridgeInput): void {
  input.window.on("message", async (message: unknown) => {
    if (!isRecord(message) || typeof message.type !== "string") return;

    if (message.type === "refresh") {
      await sendActionResult(input.window, "refresh", () => ({
        type: "metrics",
        ok: true,
        metrics: input.getMetrics(),
      }));
      return;
    }

    if (message.type === "export") {
      await sendActionResult(input.window, "export", async () => {
        const filePath = await input.exportCsv();
        return {
          type: "export-result",
          ok: true,
          filePath,
          message: formatExportSuccess(filePath),
        };
      });
    }
  });
}

async function sendActionResult(
  window: GlimpseWindow,
  action: "refresh" | "export",
  buildResult: () => DashboardResult | Promise<DashboardResult>,
): Promise<void> {
  try {
    sendDashboardResult(window, await buildResult());
  } catch (error) {
    sendDashboardResult(window, {
      type: "error",
      ok: false,
      action,
      message: errorMessage(error),
    });
  }
}

function sendDashboardResult(
  window: GlimpseWindow,
  result: DashboardResult,
): void {
  window.send?.(
    `window.dispatchEvent(new CustomEvent("cache-graph:${result.type}", ` +
      `{ detail: ${escapeScriptJson(result)} }));`,
  );
}

function escapeScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
