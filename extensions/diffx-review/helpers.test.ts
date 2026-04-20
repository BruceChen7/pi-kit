import { describe, expect, it } from "vitest";

import {
  buildBaseBranchDiffArgs,
  buildCommitRangeDiffArgs,
  buildFinishReviewPrompt,
  buildInteractiveMenuRequiredMessage,
  buildMergeBaseDiffArgs,
  buildSingleCommitDiffArgs,
  filterComments,
  parseFinishReviewArgs,
  parseRawDiffArgs,
  parseStartReviewArgs,
} from "./helpers.ts";
import type { DiffxReviewComment, DiffxReviewSession } from "./types.ts";

const session: DiffxReviewSession = {
  repoRoot: "/tmp/repo",
  host: "127.0.0.1",
  port: 3433,
  url: "http://127.0.0.1:3433",
  pid: 123,
  startedAt: 1,
  diffArgs: ["main..HEAD"],
  openInBrowser: true,
  cwdAtStart: "/tmp/repo",
  startCommand: "diffx -- main..HEAD",
  lastHealthcheckAt: null,
  lastHealthcheckOk: null,
};

const comments: DiffxReviewComment[] = [
  {
    id: "c1",
    filePath: "src/a.ts",
    side: "additions",
    lineNumber: 10,
    lineContent: "+ const name = x",
    body: "rename x",
    status: "open",
    createdAt: 1,
    replies: [],
  },
  {
    id: "c2",
    filePath: "src/b.ts",
    side: "deletions",
    lineNumber: 20,
    lineContent: "- if (x)",
    body: "restore guard",
    status: "resolved",
    createdAt: 2,
    replies: [],
  },
];

describe("diffx-review helpers", () => {
  it("parses start args with flags and passthrough diff args", () => {
    const parsed = parseStartReviewArgs(
      "--no-open --host=0.0.0.0 --port 8080 -- main..HEAD -- src/",
    );

    expect(parsed.error).toBeNull();
    expect(parsed.value).toEqual({
      noOpen: true,
      host: "0.0.0.0",
      port: 8080,
      diffArgs: ["main..HEAD", "--", "src/"],
    });
  });

  it("parses finish args", () => {
    expect(parseFinishReviewArgs("--resolve-after-reply")).toEqual({
      value: { resolveAfterReply: true },
      error: null,
    });
  });

  it("builds common compare diff args", () => {
    expect(buildBaseBranchDiffArgs("main")).toEqual(["main..HEAD"]);
    expect(buildMergeBaseDiffArgs("main")).toEqual(["main...HEAD"]);
    expect(buildSingleCommitDiffArgs("abc123")).toEqual(["abc123^!"]);
    expect(buildCommitRangeDiffArgs("abc123", "def456")).toEqual([
      "abc123..def456",
    ]);
  });

  it("parses raw diff args for custom mode", () => {
    expect(parseRawDiffArgs("origin/main...HEAD -- src/")).toEqual([
      "origin/main...HEAD",
      "--",
      "src/",
    ]);
  });

  it("builds the interactive-menu-required message", () => {
    expect(buildInteractiveMenuRequiredMessage()).toContain("interactive UI");
    expect(buildInteractiveMenuRequiredMessage()).toContain("--");
  });

  it("filters comments by status and file", () => {
    expect(filterComments(comments, "open")).toEqual([comments[0]]);
    expect(filterComments(comments, "all", "src/b.ts")).toEqual([comments[1]]);
  });

  it("builds the finish-review prompt", () => {
    const prompt = buildFinishReviewPrompt({
      repoRoot: "/tmp/repo",
      session,
      comments: [comments[0]],
      resolveAfterReply: true,
    });

    expect(prompt).toContain(
      "Please address the following diffx review comments",
    );
    expect(prompt).toContain("diffx_reply_comment");
    expect(prompt).toContain("diffx_resolve_comment");
    expect(prompt).toContain('<comment id="c1" file="src/a.ts" line="10"');
  });
});
