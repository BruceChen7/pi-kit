import path from "node:path";

import type {
  DiffxCommentStats,
  DiffxComparePresetOption,
  DiffxReviewComment,
  DiffxReviewSession,
  FinishReviewArgs,
  StartReviewArgs,
} from "./types.ts";

export const DIFFX_START_REVIEW_USAGE =
  "/diffx-start-review [--no-open] [--host=<host>] [--port=<n>] [-- <git diff args>]";

export const DIFFX_COMPARE_PRESET_OPTIONS: DiffxComparePresetOption[] = [
  {
    value: "working-tree",
    label: "Working tree",
    description: "Compare the current working tree changes",
  },
  {
    value: "staged",
    label: "Staged",
    description: "Compare only indexed changes",
  },
  {
    value: "base-branch",
    label: "Base branch vs HEAD",
    description: "Compare the current branch against another branch",
  },
  {
    value: "merge-base",
    label: "Merge-base vs HEAD",
    description: "Compare from the common ancestor with another branch",
  },
  {
    value: "single-commit",
    label: "Single commit",
    description: "Review exactly one commit",
  },
  {
    value: "two-commits",
    label: "Two commits",
    description: "Review a commit range",
  },
  {
    value: "custom",
    label: "Custom git diff args",
    description: "Enter raw git diff arguments manually",
  },
];

export const tokenizeArgs = (rawArgs: string): string[] => {
  const trimmed = rawArgs.trim();
  if (!trimmed) return [];

  const tokens = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return tokens.map((token) => token.replace(/^(["'])|(["'])$/g, ""));
};

const parsePort = (value: string): number | null => {
  if (!/^\d+$/.test(value.trim())) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return parsed > 0 && parsed <= 65535 ? parsed : null;
};

export const parseStartReviewArgs = (
  rawArgs: string,
): { value: StartReviewArgs | null; error: string | null } => {
  const tokens = tokenizeArgs(rawArgs);
  const value: StartReviewArgs = {
    noOpen: false,
    host: null,
    port: null,
    diffArgs: [],
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === "--") {
      value.diffArgs = tokens.slice(index + 1);
      return { value, error: null };
    }

    if (token === "--no-open") {
      value.noOpen = true;
      continue;
    }

    if (token === "--host") {
      const next = tokens[index + 1];
      if (!next) {
        return { value: null, error: "Missing value for --host" };
      }
      value.host = next;
      index += 1;
      continue;
    }

    if (token.startsWith("--host=")) {
      value.host = token.slice("--host=".length) || null;
      if (!value.host) {
        return { value: null, error: "Missing value for --host" };
      }
      continue;
    }

    if (token === "--port") {
      const next = tokens[index + 1];
      if (!next) {
        return { value: null, error: "Missing value for --port" };
      }
      const port = parsePort(next);
      if (port === null) {
        return { value: null, error: `Invalid port: ${next}` };
      }
      value.port = port;
      index += 1;
      continue;
    }

    if (token.startsWith("--port=")) {
      const port = parsePort(token.slice("--port=".length));
      if (port === null) {
        return {
          value: null,
          error: `Invalid port: ${token.slice("--port=".length)}`,
        };
      }
      value.port = port;
      continue;
    }

    return {
      value: null,
      error: `Unknown argument. Usage: ${DIFFX_START_REVIEW_USAGE}`,
    };
  }

  return { value, error: null };
};

export const parseRawDiffArgs = (rawArgs: string): string[] =>
  tokenizeArgs(rawArgs);

export const buildBaseBranchDiffArgs = (branch: string): string[] => [
  `${branch}..HEAD`,
];

export const buildMergeBaseDiffArgs = (branch: string): string[] => [
  `${branch}...HEAD`,
];

export const buildSingleCommitDiffArgs = (sha: string): string[] => [
  `${sha}^!`,
];

export const buildCommitRangeDiffArgs = (
  fromSha: string,
  toSha: string,
): string[] => [`${fromSha}..${toSha}`];

export const buildInteractiveMenuRequiredMessage = (): string =>
  "diffx compare menu requires interactive UI. Pass git diff args explicitly after --.";

export const parseFinishReviewArgs = (
  rawArgs: string,
): { value: FinishReviewArgs | null; error: string | null } => {
  const tokens = tokenizeArgs(rawArgs);
  const value: FinishReviewArgs = {
    resolveAfterReply: false,
  };

  for (const token of tokens) {
    if (token === "--resolve-after-reply") {
      value.resolveAfterReply = true;
      continue;
    }

    return {
      value: null,
      error:
        "Unknown argument. Usage: /diffx-process-review [--resolve-after-reply]",
    };
  }

  return { value, error: null };
};

const indent = (value: string, prefix: string): string =>
  value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const formatCommentXml = (comment: DiffxReviewComment): string => {
  const code = comment.lineContent.trim() || "(no line content)";
  const body = comment.body.trim() || "(empty comment)";
  return [
    `  <comment id="${escapeXml(comment.id)}" file="${escapeXml(comment.filePath)}" line="${comment.lineNumber}" side="${comment.side}">`,
    `    <code>${escapeXml(code)}</code>`,
    `    <body>${escapeXml(body)}</body>`,
    "  </comment>",
  ].join("\n");
};

export const buildFinishReviewPrompt = (input: {
  repoRoot: string;
  session: DiffxReviewSession;
  comments: DiffxReviewComment[];
  resolveAfterReply: boolean;
}): string => {
  const commentsXml = input.comments.map(formatCommentXml).join("\n");

  return [
    `Please address the following diffx review comments for the active repository at ${input.repoRoot}.`,
    "",
    `Review URL: ${input.session.url}`,
    `Open comment count: ${input.comments.length}`,
    "",
    "Workflow:",
    "1. Inspect the affected code and implement the requested fixes.",
    "2. Use diffx_list_comments if you need to refresh the latest review state.",
    "3. For each addressed comment, call diffx_reply_comment with a concise explanation of what changed.",
    input.resolveAfterReply
      ? "4. After replying, resolve each addressed comment with diffx_resolve_comment."
      : "4. Resolve a comment with diffx_resolve_comment once the issue is fully addressed.",
    "5. End with a short summary of completed, skipped, and verified items.",
    "",
    "<diffx-review-comments>",
    commentsXml,
    "</diffx-review-comments>",
  ].join("\n");
};

export const buildStatusMessage = (input: {
  session: DiffxReviewSession;
  stats: DiffxCommentStats;
  healthy: boolean;
}): string => {
  const repoName = path.basename(input.session.repoRoot);
  const ageMinutes = Math.max(
    0,
    Math.round((Date.now() - input.session.startedAt) / 60000),
  );
  return [
    `diffx review ${input.healthy ? "active" : "unhealthy"} for ${repoName}`,
    `URL: ${input.session.url}`,
    `Comments: ${input.stats.open} open / ${input.stats.resolved} resolved / ${input.stats.total} total`,
    `Started: ${ageMinutes}m ago`,
    input.session.diffArgs.length > 0
      ? `Diff args: ${input.session.diffArgs.join(" ")}`
      : "Diff args: (working tree default)",
  ].join(" | ");
};

export const buildNoSessionMessage = (repoRoot: string): string =>
  `No active diffx review session for ${path.basename(repoRoot)}. Run /diffx-start-review first.`;

export const filterComments = (
  comments: DiffxReviewComment[],
  status: "open" | "resolved" | "all",
  filePath?: string,
): DiffxReviewComment[] => {
  return comments.filter((comment) => {
    if (status !== "all" && comment.status !== status) {
      return false;
    }
    if (filePath && comment.filePath !== filePath) {
      return false;
    }
    return true;
  });
};

export const summarizeComment = (comment: DiffxReviewComment): string =>
  `${comment.id} ${comment.filePath}:${comment.lineNumber} - ${comment.body.trim()}`;

export const summarizeCommentsBlock = (
  comments: DiffxReviewComment[],
): string => indent(comments.map(summarizeComment).join("\n"), "- ");
