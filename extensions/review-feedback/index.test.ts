import { describe, expect, it, vi } from "vitest";

import {
  buildReviewPrompt,
  filterWhitespaceOnlyHunks,
  findLastAssistantMarkdown,
  handleReviewInput,
  type PendingReview,
  readPendingReviewFromBranch,
} from "./index.js";

const createPendingReview = (reviewId = "review-1"): PendingReview => ({
  reviewId,
  reviewDir: "/tmp/pi-session/feedback/session-1/review-1",
  diff: "--- a/original.md\n+++ b/edited.md\n@@ -1 +1 @@\n-old\n+new",
  createdAt: "2026-05-06T00:00:00.000Z",
});

describe("review-feedback helpers", () => {
  it("finds markdown from the latest assistant text blocks", () => {
    const markdown = findLastAssistantMarkdown([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "old answer" }],
        },
      },
      {
        type: "message",
        message: {
          role: "user",
          content: "thanks",
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "latest" },
            { type: "image", source: {} },
            { type: "text", text: "answer" },
          ],
        },
      },
    ]);

    expect(markdown).toBe("latest\n\nanswer");
  });

  it("returns the latest unresolved pending review from branch custom entries", () => {
    const first = createPendingReview("first");
    const second = createPendingReview("second");

    const pending = readPendingReviewFromBranch([
      { type: "custom", customType: "review-feedback-pending", data: first },
      { type: "custom", customType: "review-feedback-pending", data: second },
      {
        type: "custom",
        customType: "review-feedback-resolved",
        data: { reviewId: "first" },
      },
    ]);

    expect(pending).toEqual(second);
  });

  it("builds a review prompt from a diff and optional notes while removing placeholder", () => {
    const prompt = buildReviewPrompt(
      createPendingReview(),
      "[Review feedback]\n\nPlease make the tone more direct.",
    );

    expect(prompt).toContain("Use the unified diff below as feedback");
    expect(prompt).toContain("```diff\n--- a/original.md");
    expect(prompt).toContain("Please make the tone more direct.");
    expect(prompt).not.toContain("[Review feedback]");
  });

  it("discards a pending review when the placeholder is removed", () => {
    const appendEntry = vi.fn();
    const pending = createPendingReview();

    const result = handleReviewInput(pending, "Never mind", appendEntry);

    expect(result).toEqual({ action: "continue", pendingReview: undefined });
    expect(appendEntry).toHaveBeenCalledWith("review-feedback-resolved", {
      reviewId: pending.reviewId,
      resolution: "discarded",
      resolvedAt: expect.any(String),
    });
  });

  it("transforms placeholder input into review feedback and resolves the pending review", () => {
    const appendEntry = vi.fn();
    const pending = createPendingReview();

    const result = handleReviewInput(
      pending,
      "[Review feedback]\n\nFocus on the changed heading.",
      appendEntry,
    );

    expect(result.action).toBe("transform");
    if (result.action !== "transform") {
      throw new Error("expected transform result");
    }
    expect(result.pendingReview).toBeUndefined();
    expect(result.text).toContain("Focus on the changed heading.");
    expect(result.text).toContain(pending.diff);
    expect(appendEntry).toHaveBeenCalledWith("review-feedback-resolved", {
      reviewId: pending.reviewId,
      resolution: "submitted",
      resolvedAt: expect.any(String),
    });
  });
});

describe("filterWhitespaceOnlyHunks", () => {
  const HEADER = [
    "diff --git a/original.md b/edited.md",
    "index abc..def 100644",
    "--- a/original.md",
    "+++ b/edited.md",
  ].join("\n");

  it("filters out a hunk with only trailing whitespace changes", () => {
    const diff = [
      HEADER,
      "@@ -1,3 +1,3 @@",
      " hello",
      "-world ",
      "+world",
      " .",
    ].join("\n");

    expect(filterWhitespaceOnlyHunks(diff)).toBe("");
  });

  it("filters out a hunk with only blank line changes", () => {
    const diff = [HEADER, "@@ -5,6 +5,7 @@", " keep", "-", "+", " keep"].join(
      "\n",
    );

    expect(filterWhitespaceOnlyHunks(diff)).toBe("");
  });

  it("keeps a hunk with semantic changes", () => {
    const diff = [
      HEADER,
      "@@ -1,3 +1,3 @@",
      " hello",
      "-old",
      "+new",
      " .",
    ].join("\n");

    expect(filterWhitespaceOnlyHunks(diff)).toBe(diff);
  });

  it("filters out whitespace-only hunks while keeping semantic hunks", () => {
    const diff = [
      HEADER,
      "@@ -1,3 +1,3 @@",
      " hello",
      "-world ",
      "+world",
      " .",
      "@@ -10,4 +10,4 @@",
      " context",
      "-old",
      "+new",
      " context",
    ].join("\n");

    const result = filterWhitespaceOnlyHunks(diff);

    // First hunk (whitespace-only) should be removed
    expect(result).not.toContain("world ");
    // Second hunk (semantic) should remain
    expect(result).toContain("-old");
    expect(result).toContain("+new");
    // Header should be present
    expect(result).toContain("diff --git a/original.md b/edited.md");
  });

  it("returns empty string when all hunks are whitespace-only", () => {
    const diff = [
      HEADER,
      "@@ -1,2 +1,2 @@",
      "-  hello",
      "+ hello",
      "@@ -3,2 +3,2 @@",
      "-foo ",
      "+foo",
    ].join("\n");

    expect(filterWhitespaceOnlyHunks(diff)).toBe("");
  });

  it("returns empty string unchanged", () => {
    expect(filterWhitespaceOnlyHunks("")).toBe("");
  });

  it("returns a non-hunk diff (fallback format) unchanged", () => {
    const fallback = [
      "--- a/original.md",
      "+++ b/edited.md",
      "@@ full file comparison @@",
      "--- original.md",
      "some content",
      "+++ edited.md",
      "some changed content",
    ].join("\n");

    expect(filterWhitespaceOnlyHunks(fallback)).toBe(fallback);
  });
});
