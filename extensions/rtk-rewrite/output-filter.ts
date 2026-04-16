export type CommandOutputFilter = {
  id: string;
  enabled: boolean;
  matches: (command: string) => boolean;
  apply: (output: string, command: string) => string | null;
};

export type TailCaptureLimits = {
  maxLines: number;
  maxChars: number;
};

type CommandFilterOptions = {
  enabled: boolean;
  commands: string[];
  maxLines: number;
  maxChars: number;
};

type TailCaptureOverrides = Partial<TailCaptureLimits>;

export const DEFAULT_OUTPUT_TAIL_MAX_LINES = 30;
export const DEFAULT_OUTPUT_TAIL_MAX_CHARS = 4000;

const TRUNCATION_MARKER = "...[truncated]\n";

const normalizeCommandList = (commands: string[]): string[] => {
  const normalized = commands
    .map((command) => command.trim().toLowerCase())
    .filter((command) => command.length > 0);
  return Array.from(new Set(normalized));
};

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const sanitizePositiveInteger = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
};

const resolveTailCaptureLimits = (
  overrides: TailCaptureOverrides = {},
): TailCaptureLimits => ({
  maxLines: sanitizePositiveInteger(
    overrides.maxLines,
    DEFAULT_OUTPUT_TAIL_MAX_LINES,
  ),
  maxChars: sanitizePositiveInteger(
    overrides.maxChars,
    DEFAULT_OUTPUT_TAIL_MAX_CHARS,
  ),
});

const trimTrailingEmptyLines = (lines: string[]): string[] => {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim().length === 0) {
    end -= 1;
  }
  return lines.slice(0, end);
};

const captureOutputTail = (
  output: string,
  overrides: TailCaptureOverrides = {},
): string => {
  const { maxLines, maxChars } = resolveTailCaptureLimits(overrides);
  const lines = trimTrailingEmptyLines(output.split("\n"));
  const tailText = lines.slice(-maxLines).join("\n");

  if (tailText.length <= maxChars) {
    return tailText;
  }

  if (maxChars <= TRUNCATION_MARKER.length) {
    return TRUNCATION_MARKER.slice(0, maxChars);
  }

  const keptChars = maxChars - TRUNCATION_MARKER.length;
  return `${TRUNCATION_MARKER}${tailText.slice(-keptChars)}`;
};

export function isBuildCommand(
  command: string | undefined | null,
  buildCommands: string[] = [],
): boolean {
  if (typeof command !== "string" || command.length === 0) {
    return false;
  }

  const normalized = normalizeCommandList(buildCommands);
  const cmdLower = command.toLowerCase();
  return normalized.some((entry) => cmdLower.includes(entry));
}

export function isTestCommand(
  command: string | undefined | null,
  testCommands: string[] = [],
): boolean {
  if (typeof command !== "string" || command.length === 0) {
    return false;
  }

  const normalized = normalizeCommandList(testCommands);
  const cmdLower = command.toLowerCase();
  return normalized.some((entry) => {
    const escaped = escapeRegex(entry);
    return new RegExp(`(?:^|[\\s|;&])${escaped}(?:[\\s|;&]|$)`).test(cmdLower);
  });
}

export function filterBuildOutput(
  output: string,
  command: string | undefined | null,
  buildCommands: string[] = [],
  limits: TailCaptureOverrides = {},
): string | null {
  if (typeof command !== "string" || !isBuildCommand(command, buildCommands)) {
    return null;
  }

  return captureOutputTail(output, limits);
}

export function aggregateTestOutput(
  output: string,
  command: string | undefined | null,
  testCommands: string[] = [],
  limits: TailCaptureOverrides = {},
): string | null {
  if (typeof command !== "string" || !isTestCommand(command, testCommands)) {
    return null;
  }

  return captureOutputTail(output, limits);
}

export const createBuildOutputFilter = (
  options: CommandFilterOptions,
): CommandOutputFilter => ({
  id: "build",
  enabled: options.enabled,
  matches: (command) => isBuildCommand(command, options.commands),
  apply: (output, command) =>
    filterBuildOutput(output, command, options.commands, {
      maxLines: options.maxLines,
      maxChars: options.maxChars,
    }),
});

export const createTestOutputFilter = (
  options: CommandFilterOptions,
): CommandOutputFilter => ({
  id: "test",
  enabled: options.enabled,
  matches: (command) => isTestCommand(command, options.commands),
  apply: (output, command) =>
    aggregateTestOutput(output, command, options.commands, {
      maxLines: options.maxLines,
      maxChars: options.maxChars,
    }),
});
