import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export const PLACEHOLDER = "[Review feedback]";
export const CUSTOM_PENDING = "review-feedback-pending";
export const CUSTOM_RESOLVED = "review-feedback-resolved";

type TextBlock = {
  type: "text";
  text: string;
};

export type PendingReview = {
  reviewId: string;
  reviewDir: string;
  diff: string;
  createdAt: string;
};

type Component = {
  render(width: number): string[];
  invalidate(): void;
};

type TUI = {
  stop(): void;
  start(): void;
  requestRender(full?: boolean): void;
};

type ReviewContext = {
  hasUI: boolean;
  ui: {
    custom<T>(
      factory: (
        tui: TUI,
        theme: unknown,
        keybindings: unknown,
        done: (result: T) => void,
      ) => Component,
    ): Promise<T>;
    notify(message: string, level: "info" | "warning" | "error"): void;
    setEditorText(text: string): void;
  };
  sessionManager: {
    getBranch(): Array<{
      type?: unknown;
      customType?: unknown;
      data?: unknown;
      message?: unknown;
    }>;
    getSessionDir(): string;
    getSessionId(): string;
    getSessionFile(): string | undefined;
  };
  waitForIdle?: () => Promise<void>;
};

type ExternalEditorResult =
  | { ok: true; content: string }
  | { ok: false; reason: string };

type AppendEntry = (customType: string, data: unknown) => void;
type ReviewResolution = "discarded" | "submitted";

export type ReviewInputResult =
  | { action: "continue"; pendingReview: PendingReview | undefined }
  | { action: "transform"; text: string; pendingReview: undefined };

class ExternalEditorLauncher implements Component {
  #started = false;

  readonly #initialText: string;
  readonly #onDone: (result: ExternalEditorResult) => void;
  readonly #tui: TUI;

  constructor(
    tui: TUI,
    initialText: string,
    onDone: (result: ExternalEditorResult) => void,
  ) {
    this.#tui = tui;
    this.#initialText = initialText;
    this.#onDone = onDone;
  }

  render(_width: number): string[] {
    if (!this.#started) {
      this.#started = true;
      setImmediate(() => this.#open());
    }

    return ["Review feedback: opening external editor..."];
  }

  invalidate(): void {}

  #open(): void {
    this.#onDone(openExternalMarkdownEditor(this.#tui, this.#initialText));
  }
}

function isTextBlock(block: unknown): block is TextBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    "type" in block &&
    block.type === "text" &&
    "text" in block &&
    typeof block.text === "string"
  );
}

export function assistantMessageToMarkdown(
  message: unknown,
): string | undefined {
  if (
    typeof message !== "object" ||
    message === null ||
    !("role" in message) ||
    message.role !== "assistant"
  ) {
    return undefined;
  }

  if (!("content" in message) || !Array.isArray(message.content)) {
    return undefined;
  }

  const markdown = message.content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join("\n\n")
    .trimEnd();

  return markdown.length > 0 ? markdown : undefined;
}

export function findLastAssistantMarkdown(
  entries: Array<{ type?: unknown; message?: unknown }>,
): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "message") {
      continue;
    }

    const markdown = assistantMessageToMarkdown(entry.message);
    if (markdown) {
      return markdown;
    }
  }

  return undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function openExternalMarkdownEditor(
  tui: TUI,
  initialText: string,
): ExternalEditorResult {
  const editorCommand = process.env.VISUAL || process.env.EDITOR;
  if (!editorCommand) {
    return { ok: false, reason: "No VISUAL or EDITOR is configured." };
  }

  const tempFile = join(
    tmpdir(),
    `pi-review-feedback-${Date.now()}-${randomUUID()}.md`,
  );
  writeFileSync(tempFile, initialText, "utf8");

  try {
    tui.stop();

    const shell = process.env.SHELL || "/bin/sh";
    const command = `${editorCommand} ${shellQuote(tempFile)}`;
    const result = spawnSync(shell, ["-lc", command], { stdio: "inherit" });

    if (result.status !== 0) {
      return {
        ok: false,
        reason: `Editor exited with status ${result.status ?? "unknown"}.`,
      };
    }

    return { ok: true, content: readFileSync(tempFile, "utf8") };
  } catch (error: unknown) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    tui.start();
    tui.requestRender(true);
  }
}

function createUnifiedDiff(originalPath: string, editedPath: string): string {
  const result = spawnSync(
    "git",
    [
      "diff",
      "--no-index",
      "--no-ext-diff",
      "--no-color",
      "--",
      originalPath,
      editedPath,
    ],
    { encoding: "utf8" },
  );

  if (result.error) {
    return createFallbackDiff(originalPath, editedPath);
  }

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd();
  return output.length > 0
    ? shortenDiffPaths(output, originalPath, editedPath)
    : createFallbackDiff(originalPath, editedPath);
}

function shortenDiffPaths(
  diff: string,
  originalPath: string,
  editedPath: string,
): string {
  return diff
    .replaceAll(originalPath, "original.md")
    .replaceAll(editedPath, "edited.md")
    .replace(
      /^diff --git original\.md edited\.md$/m,
      "diff --git a/original.md b/edited.md",
    )
    .replace(/^--- original\.md$/m, "--- a/original.md")
    .replace(/^\+\+\+ edited\.md$/m, "+++ b/edited.md");
}

function createFallbackDiff(originalPath: string, editedPath: string): string {
  const original = readFileSync(originalPath, "utf8");
  const edited = readFileSync(editedPath, "utf8");

  return [
    `--- a/${basename(originalPath)}`,
    `+++ b/${basename(editedPath)}`,
    "@@ full file comparison @@",
    "--- original.md",
    original,
    "+++ edited.md",
    edited,
  ].join("\n");
}

function hasPlaceholderToken(text: string): boolean {
  return text.split("\n").some((line) => line.trim() === PLACEHOLDER);
}

function removePlaceholderToken(text: string): string {
  return text
    .split("\n")
    .filter((line) => line.trim() !== PLACEHOLDER)
    .join("\n");
}

export function buildReviewPrompt(
  pending: PendingReview,
  userText: string,
): string {
  const sections = [
    "I reviewed your previous message in my editor and made changes.",
    "Use the unified diff below as feedback on that previous message. Infer my intent from additions, removals, rewrites, and comments. Do not mechanically copy my edited text unless that is clearly the right next step.",
    `The review artifact folder is \`${pending.reviewDir}\`. It contains \`original.md\`, \`edited.md\`, \`diff.patch\`, and \`metadata.json\`.`,
    `Unified diff:\n\n\`\`\`diff\n${pending.diff}\n\`\`\``,
  ];

  const additionalFeedback = removePlaceholderToken(userText).trim();
  if (additionalFeedback.length > 0) {
    sections.push(additionalFeedback);
  }

  return sections.join("\n\n");
}

function isPendingReview(value: unknown): value is PendingReview {
  return (
    typeof value === "object" &&
    value !== null &&
    "reviewId" in value &&
    typeof value.reviewId === "string" &&
    "reviewDir" in value &&
    typeof value.reviewDir === "string" &&
    "diff" in value &&
    typeof value.diff === "string" &&
    "createdAt" in value &&
    typeof value.createdAt === "string"
  );
}

function isResolvedReview(value: unknown): value is { reviewId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "reviewId" in value &&
    typeof value.reviewId === "string"
  );
}

export function readPendingReviewFromBranch(
  entries: Array<{ type?: unknown; customType?: unknown; data?: unknown }>,
): PendingReview | undefined {
  const pendingById = new Map<string, PendingReview>();

  for (const entry of entries) {
    if (entry.type !== "custom") {
      continue;
    }

    if (entry.customType === CUSTOM_PENDING && isPendingReview(entry.data)) {
      pendingById.set(entry.data.reviewId, entry.data);
    }

    if (entry.customType === CUSTOM_RESOLVED && isResolvedReview(entry.data)) {
      pendingById.delete(entry.data.reviewId);
    }
  }

  return Array.from(pendingById.values()).at(-1);
}

function appendResolvedReview(
  appendEntry: AppendEntry,
  pendingReview: PendingReview,
  resolution: ReviewResolution,
): void {
  appendEntry(CUSTOM_RESOLVED, {
    reviewId: pendingReview.reviewId,
    resolution,
    resolvedAt: new Date().toISOString(),
  });
}

export function handleReviewInput(
  pendingReview: PendingReview,
  text: string,
  appendEntry: AppendEntry,
): ReviewInputResult {
  if (!hasPlaceholderToken(text)) {
    appendResolvedReview(appendEntry, pendingReview, "discarded");
    return { action: "continue", pendingReview: undefined };
  }

  const prompt = buildReviewPrompt(pendingReview, text);
  appendResolvedReview(appendEntry, pendingReview, "submitted");

  return {
    action: "transform",
    text: prompt,
    pendingReview: undefined,
  };
}

function createReviewArtifact(
  ctx: ReviewContext,
  original: string,
  edited: string,
): PendingReview {
  const sessionDir = ctx.sessionManager.getSessionDir();
  const sessionId = ctx.sessionManager.getSessionId();
  const reviewId = `review_${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}_${randomUUID()}`;
  const reviewDir = join(sessionDir, "feedback", sessionId, reviewId);
  mkdirSync(reviewDir, { recursive: true });

  const originalPath = join(reviewDir, "original.md");
  const editedPath = join(reviewDir, "edited.md");
  const diffPath = join(reviewDir, "diff.patch");

  writeFileSync(originalPath, `${original}\n`, "utf8");
  writeFileSync(editedPath, `${edited}\n`, "utf8");

  const diff = createUnifiedDiff(originalPath, editedPath);
  writeFileSync(diffPath, `${diff}\n`, "utf8");
  writeFileSync(
    join(reviewDir, "metadata.json"),
    `${JSON.stringify(
      {
        version: 1,
        sessionId,
        sessionFile: ctx.sessionManager.getSessionFile(),
        createdAt: new Date().toISOString(),
        placeholder: PLACEHOLDER,
        reviewDir,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    reviewId,
    reviewDir,
    diff,
    createdAt: new Date().toISOString(),
  };
}

export default function reviewFeedbackExtension(pi: ExtensionAPI) {
  let pendingReview: PendingReview | undefined;

  async function stageReview(
    ctx: ReviewContext,
    markdown: string,
  ): Promise<void> {
    if (!ctx.hasUI) {
      return;
    }

    if (pendingReview) {
      ctx.ui.notify(
        "Review feedback is already pending. Submit or discard it before starting another review.",
        "warning",
      );
      return;
    }

    const editorResult = await ctx.ui.custom<ExternalEditorResult>(
      (tui, _theme, _keybindings, done) =>
        new ExternalEditorLauncher(tui, markdown, done),
    );

    if (editorResult.ok === false) {
      ctx.ui.notify(
        `Review feedback skipped: ${editorResult.reason}`,
        "warning",
      );
      return;
    }

    const original = markdown.trimEnd();
    const edited = editorResult.content.trimEnd();
    if (edited.trim().length === 0 || edited === original) {
      return;
    }

    pendingReview = createReviewArtifact(ctx, original, edited);

    pi.appendEntry(CUSTOM_PENDING, pendingReview);
    ctx.ui.setEditorText(`${PLACEHOLDER}\n\n`);
    ctx.ui.notify(
      "Review feedback staged. Add optional notes and submit, or delete the placeholder to discard.",
      "info",
    );
  }

  pi.on("session_start", (_event, ctx) => {
    pendingReview = readPendingReviewFromBranch(ctx.sessionManager.getBranch());
  });

  pi.on("before_agent_start", (event) => {
    return {
      systemPrompt:
        `${event.systemPrompt}\n\n## Review feedback extension\n` +
        "- The user can run /feedback to review your latest assistant message in their editor.\n" +
        "- When review feedback is submitted, it arrives as a normal user message written in the user's voice and may include a unified diff plus additional notes. Treat that message as direct user feedback on your previous answer.",
    };
  });

  pi.registerCommand("feedback", {
    description:
      "Review the latest assistant message in $EDITOR and stage the diff as feedback",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      const markdown = findLastAssistantMarkdown(
        ctx.sessionManager.getBranch(),
      );
      if (!markdown) {
        ctx.ui.notify("No assistant message found to review.", "warning");
        return;
      }

      await stageReview(ctx, markdown);
    },
  });

  pi.on("input", (event) => {
    if (!pendingReview || event.source === "extension") {
      return { action: "continue" };
    }

    const result = handleReviewInput(
      pendingReview,
      event.text,
      (customType, data) => pi.appendEntry(customType, data),
    );
    pendingReview = result.pendingReview;

    if (result.action === "transform") {
      return {
        action: "transform",
        text: result.text,
      };
    }

    return { action: "continue" };
  });
}
