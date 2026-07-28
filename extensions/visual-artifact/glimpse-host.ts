/**
 * Glimpse host — create HTML, open window, attach bridge.
 */

import os from "node:os";
import path from "node:path";
import {
  type GlimpseWindow,
  type GlimpseWindowOptions,
  openGlimpseWindow,
  withRedirectedOpenWindowStderr,
} from "../shared/glimpse-window.ts";
import { attachVisualArtifactBridge, type BridgeContext } from "./ui-bridge.ts";
import {
  createVisualArtifactHtml,
  type VisualArtifactBootData,
} from "./ui-html.ts";

export type { VisualArtifactBootData };

type OpenWindowFn = (
  html: string,
  options: typeof GLIMPSE_WINDOW_OPTIONS,
) => GlimpseWindow;

export type OpenVisualArtifactWindowOptions = {
  bootData: VisualArtifactBootData;
  projectRoot: string;
  projectName: string;
  openWindow?: OpenWindowFn;
  glimpseStderrLogPath?: string;
  uiDistDir?: string;
};

const GLIMPSE_WINDOW_OPTIONS = {
  width: 1200,
  height: 800,
  title: "Visual Artifact",
} satisfies GlimpseWindowOptions;

function defaultGlimpseStderrLogPath(): string {
  return path.join(
    os.homedir(),
    ".pi",
    "agent",
    "visual-artifact",
    "glimpse-stderr.log",
  );
}

/**
 * Create an inline HTML page with boot data injected.
 */
export async function createWindowHtml(
  bootData: VisualArtifactBootData,
  uiDistDir?: string,
): Promise<string> {
  return createVisualArtifactHtml({ bootData, uiDistDir });
}

/**
 * Open a Glimpse window for Visual Artifact.
 *
 * This function:
 * 1. Creates inline HTML with boot data
 * 2. Opens a Glimpse native window
 * 3. Attaches the bridge for bidirectional communication
 */
export async function openVisualArtifactWindow(
  options: OpenVisualArtifactWindowOptions,
): Promise<void> {
  const openWindow = options.openWindow ?? openGlimpseWindow;
  const html = await createVisualArtifactHtml({
    bootData: options.bootData,
    uiDistDir: options.uiDistDir,
  });

  const glimpseStderrLogPath =
    options.glimpseStderrLogPath ?? defaultGlimpseStderrLogPath();

  const window = withRedirectedOpenWindowStderr(glimpseStderrLogPath, () =>
    openWindow(html, GLIMPSE_WINDOW_OPTIONS),
  );

  const bridgeContext: BridgeContext = {
    window,
    projectRoot: options.projectRoot,
    projectName: options.projectName,
  };

  attachVisualArtifactBridge(bridgeContext);
}
