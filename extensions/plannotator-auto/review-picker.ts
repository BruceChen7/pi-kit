import fs from "node:fs";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";
import { type CliReviewResult, runPlannotatorPlanReviewCli } from "./cli.ts";
import { scanMermaidBlocks } from "./mermaid-validator.ts";
import {
  preprocessPlanMarkdown,
  runPlannotatorHtmlReviewOnce,
} from "./plan-review.ts";

const SYNC_REVIEW_TIMEOUT_MS = 4 * 60 * 60 * 1_000;
const MAX_PLAN_FILES = 50;
const SELECT_LIST_MAX_VISIBLE = 10;

// ---------------------------------------------------------------------------
// Public: FileItem type (exported for tests)
// ---------------------------------------------------------------------------

export type FileItem = {
  absolutePath: string;
  relativePath: string;
  mtimeMs: number;
};

// ---------------------------------------------------------------------------
// SelectList theme builder
// ---------------------------------------------------------------------------

const buildSelectListTheme = (theme: {
  fg: (tone: string, text: string) => string;
  bold: (text: string) => string;
}) => ({
  selectedPrefix: (text: string) => theme.fg("accent", text),
  selectedText: (text: string) => theme.fg("accent", text),
  description: (text: string) => theme.fg("muted", text),
  scrollInfo: (text: string) => theme.fg("dim", text),
  noMatch: (text: string) => theme.fg("warning", text),
});

// ---------------------------------------------------------------------------
// Shell: scan .pi recursively for reviewable documents (md/html)
// Exported for testing.
export const scanReviewableFiles = (ctx: ExtensionContext): FileItem[] => {
  const files: FileItem[] = [];
  const stack = [path.join(ctx.cwd, ".pi")];

  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (
        !entry.isFile() ||
        (!entry.name.endsWith(".md") && !entry.name.endsWith(".html"))
      ) {
        continue;
      }

      try {
        files.push({
          absolutePath: fullPath,
          relativePath: path.relative(ctx.cwd, fullPath),
          mtimeMs: fs.statSync(fullPath).mtimeMs,
        });
      } catch {
        // unreadable file — skip
      }
    }
  }

  // Most recently modified first, capped for the picker list
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_PLAN_FILES);
};

// ---------------------------------------------------------------------------
// Level 2: pick a plan/spec file
// ---------------------------------------------------------------------------

const showFileSelector = async (
  ctx: ExtensionContext,
  files: FileItem[],
): Promise<string | null> =>
  ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
    container.addChild(
      new Text(theme.fg("accent", theme.bold("Select Plan/Spec File"))),
    );

    const items: SelectItem[] = files.map((file) => ({
      value: file.absolutePath,
      label: file.relativePath,
    }));

    const selectList = new SelectList(
      items,
      Math.min(items.length, SELECT_LIST_MAX_VISIBLE),
      buildSelectListTheme(theme),
    );
    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(null);

    container.addChild(selectList);
    container.addChild(
      new Text(theme.fg("dim", "↑/↓ navigate • enter select • esc cancel")),
    );
    container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });

// ---------------------------------------------------------------------------
// Shared CLI result handler (P2 — reduces repetitive error/abort/result)
// ---------------------------------------------------------------------------

type ReviewOutcome = {
  approved: boolean;
  feedback?: string;
};

const handleCliResult = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  response: CliReviewResult,
  formatMessage: (result: ReviewOutcome) => string | null,
): Promise<void> => {
  if (response.status === "error") {
    ctx.ui.notify(response.error, "warning");
    return;
  }

  if (response.status === "aborted") {
    ctx.ui.notify("Review interrupted.", "info");
    return;
  }

  const message = formatMessage(response.result);
  if (message) {
    await pi.sendUserMessage(message, { deliverAs: "followUp" });
    return;
  }

  ctx.ui.notify("Review closed (no feedback).", "info");
};

// ---------------------------------------------------------------------------
// Execute plan review (direct CLI, skip pending gate)
// ---------------------------------------------------------------------------

const runPlanReview = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  filePath: string,
): Promise<void> => {
  ctx.ui.notify("Starting plan review…", "info");

  const relativePath = path.relative(ctx.cwd, filePath);
  let planContent: string;

  try {
    planContent = fs.readFileSync(filePath, "utf-8");
  } catch {
    ctx.ui.notify(`Could not read ${relativePath}.`, "warning");
    return;
  }

  try {
    if (filePath.endsWith(".html")) {
      // HTML artifacts review through Plannotator annotate (one-shot).
      await runPlannotatorHtmlReviewOnce(pi, ctx, filePath);
      return;
    }

    // Markdown plan → PermissionRequest hook
    const normalized = preprocessPlanMarkdown(planContent);
    const fenceError = scanMermaidBlocks(normalized).fenceErrors[0];
    if (fenceError) {
      ctx.ui.notify(
        `文件第 ${fenceError.startLine} 行: ${fenceError.message}`,
        "warning",
      );
      return;
    }

    const response = await runPlannotatorPlanReviewCli(ctx, normalized, {
      signal: ctx.signal,
      timeoutMs: SYNC_REVIEW_TIMEOUT_MS,
    });
    await handleCliResult(pi, ctx, response, (result) => {
      if (result.approved) {
        return `# Plan Review\n\nReview approved for **${relativePath}** — no changes requested.`;
      }
      return result.feedback?.trim()
        ? `# Plan Review\n\nReview **not approved** for **${relativePath}**.\n\n${
            result.feedback
          }\n\nPlease address this feedback and revise the plan.`
        : null;
    });
  } catch (error) {
    ctx.ui.notify(
      error instanceof Error ? error.message : "Plan review request failed.",
      "warning",
    );
  }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Show the plan/spec file picker:
 *   Choose any .md/.html file under .pi (most recently modified first, max 5)
 *
 * Execute the selected review directly with Plannotator CLI, bypassing the
 * auto pending-gate flow for plan reviews.
 */
export const showPlanFilePicker = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> => {
  if (!ctx.hasUI) {
    ctx.ui.notify("Review picker requires UI mode.", "warning");
    return;
  }

  // Find reviewable files under .pi
  const files = scanReviewableFiles(ctx);
  if (files.length === 0) {
    ctx.ui.notify(
      "No plan or spec files found for review. " +
        "Write a plan first, then try again.",
      "warning",
    );
    return;
  }

  const selectedPath = await showFileSelector(ctx, files);
  if (!selectedPath) {
    return;
  }

  await runPlanReview(pi, ctx, selectedPath);
};
