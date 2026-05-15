export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const resolveToolPath = (args: unknown): string | null => {
  if (!isRecord(args)) {
    return null;
  }

  const value = args.path;
  return typeof value === "string" ? value : null;
};

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
