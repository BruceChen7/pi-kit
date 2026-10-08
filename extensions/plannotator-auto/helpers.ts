import {
  classifyToolCall,
  isMcpToolName,
  type ToolAnnotationHints,
} from "../shared/tool-policy.ts";

/**
 * Tools whose writes the review gates follow: pi's own `write` / `edit` /
 * `bash`, plus MCP tools that may write and name file paths. Declared
 * read-only MCP tools (and MCP calls without file paths) are ignored, so a
 * `read_file` or an issue-tracker call never queues a review.
 */
export const isReviewTrackedToolCall = (
  toolName: string,
  args: unknown,
  annotations?: ToolAnnotationHints,
): boolean => {
  if (toolName === "write" || toolName === "edit" || toolName === "bash") {
    return true;
  }

  if (!isMcpToolName(toolName)) {
    return false;
  }

  const policy = classifyToolCall({ toolName, args, annotations });
  return policy.kind === "write" && policy.paths.length > 0;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const BASH_OUTPUT_PATH_PATTERN =
  /(?:>>|>|tee\s+(?:-[a-zA-Z]+\s+)*)\s*([^\s;&|]+)/g;

const stripShellQuotes = (value: string): string =>
  value.replace(/^(["'])(.*)\1$/, "$2");

export const extractBashPathCandidates = (args: unknown): string[] => {
  if (!isRecord(args) || typeof args.command !== "string") {
    return [];
  }

  const paths = Array.from(args.command.matchAll(BASH_OUTPUT_PATH_PATTERN))
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value))
    .map(stripShellQuotes);

  return Array.from(new Set(paths));
};

export const summarizeToolArgs = (
  args: unknown,
): {
  argsType: string;
  argKeys: string[] | null;
} => {
  if (isRecord(args)) {
    return {
      argsType: "object",
      argKeys: Object.keys(args),
    };
  }

  if (Array.isArray(args)) {
    return {
      argsType: "array",
      argKeys: null,
    };
  }

  return {
    argsType: typeof args,
    argKeys: null,
  };
};
