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
import {
  PLAN_REVIEW_FILE_PATTERN,
  SPEC_REVIEW_FILE_PATTERN,
} from "../shared/review-targets.ts";
import {
  type CliReviewResult,
  runPlannotatorAnnotateCli,
  runPlannotatorPlanReviewCli,
} from "./cli.ts";
import { getPlanFileConfig } from "./paths.ts";
import {
  listPendingPlanReviews,
  preprocessPlanMarkdown,
  validateMermaidFences,
} from "./plan-review.ts";
import { getSessionState } from "./session.ts";

const SYNC_REVIEW_TIMEOUT_MS = 4 * 60 * 60 * 1_000;
const MAX_PLAN_FILES = 5;
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
// Pure core: pick top-N files from pending + scanned entries (P1)
// ---------------------------------------------------------------------------

/**
 * Select up to `maxFiles` items giving priority to pending targets.
 * Deduplicates by absolutePath and sorts by mtime descending.
 * Pure function — no IO, testable with table-driven tests.
 */
export function pickTopPlanFiles(
  pendingEntries: FileItem[],
  scannedEntries: FileItem[],
  maxFiles: number,
): FileItem[] {
  const seen = new Set<string>();
  const items: FileItem[] = [];

  // Pending targets first
  for (const entry of pendingEntries) {
    if (seen.has(entry.absolutePath)) {
      continue;
    }
    seen.add(entry.absolutePath);
    items.push(entry);
  }

  // Then scanned entries (dedup against pending)
  for (const entry of scannedEntries) {
    if (seen.has(entry.absolutePath)) {
      continue;
    }
    seen.add(entry.absolutePath);
    items.push(entry);
  }

  // Sort by mtime descending, take top N
  return items.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, maxFiles);
}

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
// Shell: scan plan/spec directories (P1 — IO kept here, filtering delegated)
// Exported for testing.
export const scanPlanFiles = (ctx: ExtensionContext): FileItem[] => {
  const config = getPlanFileConfig(ctx);
  if (!config) {
    return [];
  }

  // 1. Resolve pending targets (with filesystem stat for mtime)
  const pendingEntries: FileItem[] = [];
  for (const pending of listPendingPlanReviews(getSessionState(ctx), ctx.cwd)) {
    try {
      const stats = fs.statSync(pending.resolvedPlanPath);
      pendingEntries.push({
        absolutePath: pending.resolvedPlanPath,
        relativePath: pending.planFile,
        mtimeMs: stats.mtimeMs,
      });
    } catch {
      // stale entry, skip
    }
  }

  // 2. Scan plan/spec directories for matching files
  const scannedEntries: FileItem[] = [];
  const scanDirs = [...config.resolvedPlanPaths, ...config.resolvedSpecPaths];

  for (const dir of scanDirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry);

      // Match against shared regex patterns (P3 fix)
      if (
        !PLAN_REVIEW_FILE_PATTERN.test(entry) &&
        !SPEC_REVIEW_FILE_PATTERN.test(entry)
      ) {
        continue;
      }

      try {
        if (!fs.statSync(fullPath).isFile()) {
          continue;
        }
      } catch {
        continue;
      }

      scannedEntries.push({
        absolutePath: fullPath,
        relativePath: path.relative(ctx.cwd, fullPath),
        mtimeMs: fs.statSync(fullPath).mtimeMs,
      });
    }
  }

  // 3. Scan .pi/teach/<topic>/lessons/ directories for teach lesson files
  const teachRoot = path.join(ctx.cwd, ".pi", "teach");
  let topicDirs: string[];
  try {
    topicDirs = fs.readdirSync(teachRoot);
  } catch {
    topicDirs = [];
  }

  for (const topicDir of topicDirs) {
    const lessonsDir = path.join(teachRoot, topicDir, "lessons");
    let lessonEntries: string[];
    try {
      lessonEntries = fs.readdirSync(lessonsDir);
    } catch {
      continue;
    }

    for (const entry of lessonEntries) {
      if (!entry.endsWith(".html") && !entry.endsWith(".md")) {
        continue;
      }

      const fullPath = path.join(lessonsDir, entry);

      try {
        if (!fs.statSync(fullPath).isFile()) {
          continue;
        }
      } catch {
        continue;
      }

      scannedEntries.push({
        absolutePath: fullPath,
        relativePath: path.relative(ctx.cwd, fullPath),
        mtimeMs: fs.statSync(fullPath).mtimeMs,
      });
    }
  }

  // 4. Pure core: merge, dedup, sort, cap — easily testable
  return pickTopPlanFiles(pendingEntries, scannedEntries, MAX_PLAN_FILES);
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
  const renderHtml = filePath.endsWith(".html");
  let planContent: string;

  try {
    planContent = fs.readFileSync(filePath, "utf-8");
  } catch {
    ctx.ui.notify(`Could not read ${relativePath}.`, "warning");
    return;
  }

  try {
    if (renderHtml) {
      const response = await runPlannotatorAnnotateCli(ctx, filePath, {
        renderHtml: true,
        signal: ctx.signal,
        timeoutMs: SYNC_REVIEW_TIMEOUT_MS,
      });
      await handleCliResult(pi, ctx, response, (result) => {
        if (result.approved) {
          return "# Plan Review\n\nPlan review completed — no changes requested.";
        }
        return result.feedback?.trim()
          ? `# Plan Review\n\n${result.feedback}\n\nPlease address this feedback.`
          : null;
      });
      return;
    }

    // Markdown plan → PermissionRequest hook
    const normalized = preprocessPlanMarkdown(planContent);
    const validationError = validateMermaidFences(normalized);
    if (validationError) {
      ctx.ui.notify(validationError, "warning");
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
 *   Choose a plan/spec file from pending + filesystem scan (max 5)
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

  // Find plan/spec files
  const files = scanPlanFiles(ctx);
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
