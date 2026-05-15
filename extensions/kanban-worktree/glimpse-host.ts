import os from "node:os";
import path from "node:path";
import {
  type GlimpseWindow,
  type GlimpseWindowOptions,
  openGlimpseWindow,
  withRedirectedOpenWindowStderr,
} from "../shared/glimpse-window.ts";
import { attachKanbanUiBridge } from "./kanban-ui-bridge.ts";
import { sendJsonLineRequest } from "./protocol.ts";
import { type CreateKanbanHtmlOptions, createKanbanHtml } from "./ui-html.ts";

type RequestFn = (socketPath: string, message: unknown) => Promise<unknown>;

type OpenWindowFn = (
  html: string,
  options: typeof GLIMPSE_WINDOW_OPTIONS,
) => GlimpseWindow;

type CreateGlimpseHtmlOptions = CreateKanbanHtmlOptions;

type OpenGlimpseKanbanOptions = CreateGlimpseHtmlOptions & {
  openWindow?: OpenWindowFn;
  glimpseStderrLogPath?: string;
};

const GLIMPSE_WINDOW_OPTIONS = {
  width: 1100,
  height: 720,
  title: "Kanban Worktree",
} satisfies GlimpseWindowOptions;

function defaultGlimpseStderrLogPath(): string {
  return path.join(
    os.homedir(),
    ".pi",
    "agent",
    "kanban-worktree",
    "glimpse-stderr.log",
  );
}

export async function createGlimpseHtml(
  socketPath: string,
  options: CreateGlimpseHtmlOptions = {},
): Promise<string> {
  return createKanbanHtml(socketPath, options);
}

export async function openGlimpseKanban(
  socketPath: string,
  options: OpenGlimpseKanbanOptions = {},
): Promise<void> {
  const request: RequestFn = options.request ?? sendJsonLineRequest;
  const openWindow = options.openWindow ?? openGlimpseWindow;
  const html = await createKanbanHtml(socketPath, {
    request,
    uiDistDir: options.uiDistDir,
  });
  const glimpseStderrLogPath =
    options.glimpseStderrLogPath ?? defaultGlimpseStderrLogPath();
  const window = withRedirectedOpenWindowStderr(glimpseStderrLogPath, () =>
    openWindow(html, GLIMPSE_WINDOW_OPTIONS),
  );
  attachKanbanUiBridge({ socketPath, request, window });
}
