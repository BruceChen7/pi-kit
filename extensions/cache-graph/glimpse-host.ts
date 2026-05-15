import {
  type GlimpseWindow,
  type GlimpseWindowOptions,
  openGlimpseWindow,
} from "../shared/glimpse-window.ts";
import { attachCacheGraphBridge } from "./glimpse-bridge.ts";
import type { CacheSessionMetrics } from "./types.ts";
import { createCacheGraphHtml } from "./ui-html.ts";

export type OpenCacheGraphDashboardInput = {
  getMetrics: () => CacheSessionMetrics;
  exportCsv: () => Promise<string>;
  openWindow?: (html: string, options: GlimpseWindowOptions) => GlimpseWindow;
  uiDistDir?: string;
};

const CACHE_GRAPH_WINDOW_OPTIONS = {
  width: 1200,
  height: 760,
  title: "Context Cache Graph",
} satisfies GlimpseWindowOptions;

export async function openCacheGraphDashboard(
  input: OpenCacheGraphDashboardInput,
): Promise<void> {
  const openWindow = input.openWindow ?? openGlimpseWindow;
  const html = await createCacheGraphHtml(
    { metrics: input.getMetrics() },
    { uiDistDir: input.uiDistDir },
  );
  const window = openWindow(html, CACHE_GRAPH_WINDOW_OPTIONS);
  attachCacheGraphBridge({
    window,
    getMetrics: input.getMetrics,
    exportCsv: input.exportCsv,
  });
}
