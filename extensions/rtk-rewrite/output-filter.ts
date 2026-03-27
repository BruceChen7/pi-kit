export type CommandOutputFilter = {
  id: string;
  enabled: boolean;
  matches: (command: string) => boolean;
  apply: (output: string, command: string) => string | null;
};

type CommandFilterOptions = {
  enabled: boolean;
  commands: string[];
};

interface BuildStats {
  compiled: number;
  errors: string[][];
  warnings: string[];
}

export const DEFAULT_BUILD_COMMANDS = [
  "cargo build",
  "cargo check",
  "bun build",
  "npm run build",
  "yarn build",
  "pnpm build",
  "tsc",
  "make",
  "cmake",
  "gradle",
  "mvn",
  "go build",
  "go install",
  "python setup.py build",
  "pip install",
];

export const DEFAULT_TEST_COMMANDS = [
  "test",
  "jest",
  "vitest",
  "pytest",
  "cargo test",
  "bun test",
  "go test",
  "mocha",
  "ava",
  "tap",
];

const SKIP_PATTERNS = [
  /^\s*Compiling\s+/, // Cargo/Rust "Compiling ..."
  /^\s*Checking\s+/, // Cargo/Rust "Checking ..."
  /^\s*Downloading\s+/, // Downloader progress lines
  /^\s*Downloaded\s+/, // Downloader completion lines
  /^\s*Fetching\s+/, // Fetch progress lines
  /^\s*Fetched\s+/, // Fetch completion lines
  /^\s*Updating\s+/, // Package update progress
  /^\s*Updated\s+/, // Package update completion
  /^\s*Building\s+/, // Generic build progress
  /^\s*Generated\s+/, // Generation progress
  /^\s*Creating\s+/, // Creation progress
  /^\s*Running\s+/, // Running steps
];

const ERROR_START_PATTERNS = [
  /^error\[/, // Rust-style "error[E...]"
  /^error:/, // Generic lowercase error prefix
  /^\[ERROR\]/, // Bracketed uppercase error prefix
  /^FAIL/, // Test failure prefix
];

const WARNING_PATTERNS = [
  /^warning:/, // Generic warning prefix
  /^\[WARNING\]/, // Bracketed warning prefix
  /^warn:/, // Short warning prefix
];

const TEST_RESULT_PATTERNS = [
  /test result:\s*(\w+)\.\s*(\d+)\s*passed;\s*(\d+)\s*failed;/, // Cargo test summary
  /(\d+)\s*passed(?:,\s*(\d+)\s*failed)?(?:,\s*(\d+)\s*skipped)?/i, // "2 passed, 1 failed"
  /(\d+)\s*pass(?:,\s*(\d+)\s*fail)?(?:,\s*(\d+)\s*skip)?/i, // "2 pass, 1 fail"
  /tests?:\s*(\d+)\s*passed(?:,\s*(\d+)\s*failed)?(?:,\s*(\d+)\s*skipped)?/i, // "tests: 2 passed"
];

const FAILURE_START_PATTERNS = [
  /^FAIL\s+/, // Jest/Vitest FAIL lines
  /^FAILED\s+/, // Uppercase FAILED prefix
  /^\s*●\s+/, // Jest failure bullet
  /^\s*✕\s+/, // Failure marker
  /test\s+\w+\s+\.\.\.\s*FAILED/, // Rust-style "test foo ... FAILED"
  /thread\s+'\w+'\s+panicked/, // Rust panic header
];

const LOCATION_LINE_PATTERNS = [
  /\bFile\s+"[^"]+",\s+line\s+\d+/, // Python traceback "File ..., line N"
  /(?:^|[\s(])[^\s()]+?\.[a-zA-Z0-9]+:\d+(?::\d+)?/, // file.ext:line(:col)
];

const normalizeCommandList = (commands: string[]): string[] => {
  const normalized = commands
    .map((command) => command.trim().toLowerCase())
    .filter((command) => command.length > 0);
  return Array.from(new Set(normalized));
};

export const mergeCommandLists = (
  defaults: string[],
  extra: string[] = [],
): string[] => {
  return normalizeCommandList([...defaults, ...extra]);
};

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isSkipLine = (line: string): boolean =>
  SKIP_PATTERNS.some((pattern) => pattern.test(line));

const isErrorStart = (line: string): boolean =>
  ERROR_START_PATTERNS.some((pattern) => pattern.test(line));

const isWarning = (line: string): boolean =>
  WARNING_PATTERNS.some((pattern) => pattern.test(line));

const isFailureStart = (line: string): boolean =>
  FAILURE_START_PATTERNS.some((pattern) => pattern.test(line));

const isLocationLine = (line: string): boolean =>
  LOCATION_LINE_PATTERNS.some((pattern) => pattern.test(line));

const formatFailureLine = (line: string, maxLength: number): string => {
  const trimmed = line.trimEnd();
  if (isLocationLine(trimmed) || trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength)}...`;
};

export function isBuildCommand(
  command: string | undefined | null,
  buildCommands: string[] = DEFAULT_BUILD_COMMANDS,
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
  testCommands: string[] = DEFAULT_TEST_COMMANDS,
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
  buildCommands: string[] = DEFAULT_BUILD_COMMANDS,
): string | null {
  if (typeof command !== "string" || !isBuildCommand(command, buildCommands)) {
    return null;
  }

  const lines = output.split("\n");
  const stats: BuildStats = {
    compiled: 0,
    errors: [],
    warnings: [],
  };

  let inErrorBlock = false;
  let currentError: string[] = [];
  let blankCount = 0;

  for (const line of lines) {
    if (line.match(/^\s*(Compiling|Checking|Building)\s+/)) {
      stats.compiled++;
      continue;
    }

    if (isSkipLine(line)) {
      continue;
    }

    if (isErrorStart(line)) {
      if (inErrorBlock && currentError.length > 0) {
        stats.errors.push([...currentError]);
      }
      inErrorBlock = true;
      currentError = [line];
      blankCount = 0;
      continue;
    }

    if (isWarning(line)) {
      stats.warnings.push(line);
      continue;
    }

    if (inErrorBlock) {
      if (line.trim() === "") {
        blankCount++;
        if (blankCount >= 2 && currentError.length > 3) {
          stats.errors.push([...currentError]);
          inErrorBlock = false;
          currentError = [];
        } else {
          currentError.push(line);
        }
      } else if (line.match(/^\s/) || line.match(/^-->/)) {
        currentError.push(line);
        blankCount = 0;
      } else {
        stats.errors.push([...currentError]);
        inErrorBlock = false;
        currentError = [];
      }
    }
  }

  if (inErrorBlock && currentError.length > 0) {
    stats.errors.push(currentError);
  }

  if (stats.errors.length === 0 && stats.warnings.length === 0) {
    return `✓ Build successful (${stats.compiled} units compiled)`;
  }

  const result: string[] = [];

  if (stats.errors.length > 0) {
    result.push(`❌ ${stats.errors.length} error(s):`);
    for (const error of stats.errors.slice(0, 5)) {
      result.push(...error.slice(0, 10));
      if (error.length > 10) {
        result.push("  ...");
      }
    }
    if (stats.errors.length > 5) {
      result.push(`... and ${stats.errors.length - 5} more errors`);
    }
  }

  if (stats.warnings.length > 0) {
    result.push(`\n⚠️  ${stats.warnings.length} warning(s)`);
  }

  return result.join("\n");
}

type TestSummary = {
  passed: number;
  failed: number;
  skipped: number;
  failures: string[];
};

const extractTestStats = (output: string): Partial<TestSummary> => {
  const summary: Partial<TestSummary> = {};

  for (const pattern of TEST_RESULT_PATTERNS) {
    const match = output.match(pattern);
    if (match) {
      summary.passed = parseInt(match[1], 10) || 0;
      summary.failed = parseInt(match[2], 10) || 0;
      summary.skipped = parseInt(match[3], 10) || 0;
      return summary;
    }
  }

  return summary;
};

export function aggregateTestOutput(
  output: string,
  command: string | undefined | null,
  testCommands: string[] = DEFAULT_TEST_COMMANDS,
): string | null {
  if (typeof command !== "string" || !isTestCommand(command, testCommands)) {
    return null;
  }

  const lines = output.split("\n");
  const summary: TestSummary = {
    passed: 0,
    failed: 0,
    skipped: 0,
    failures: [],
  };

  const stats = extractTestStats(output);
  summary.passed = stats.passed || 0;
  summary.failed = stats.failed || 0;
  summary.skipped = stats.skipped || 0;

  if (summary.passed === 0 && summary.failed === 0) {
    for (const line of lines) {
      if (line.match(/\b(ok|PASS|✓|✔)\b/)) summary.passed++;
      if (line.match(/\b(FAIL|fail|✗|✕)\b/)) summary.failed++;
    }
  }

  if (summary.failed > 0) {
    let inFailure = false;
    let currentFailure: string[] = [];
    let blankCount = 0;

    for (const line of lines) {
      if (isFailureStart(line)) {
        if (inFailure && currentFailure.length > 0) {
          summary.failures.push(currentFailure.join("\n"));
        }
        inFailure = true;
        currentFailure = [line];
        blankCount = 0;
        continue;
      }

      if (inFailure) {
        if (line.trim() === "") {
          blankCount++;
          if (blankCount >= 2 && currentFailure.length > 3) {
            summary.failures.push(currentFailure.join("\n"));
            inFailure = false;
            currentFailure = [];
          } else {
            currentFailure.push(line);
          }
        } else if (line.match(/^\s/) || line.match(/^-/)) {
          currentFailure.push(line);
          blankCount = 0;
        } else {
          summary.failures.push(currentFailure.join("\n"));
          inFailure = false;
          currentFailure = [];
        }
      }
    }

    if (inFailure && currentFailure.length > 0) {
      summary.failures.push(currentFailure.join("\n"));
    }
  }

  const result: string[] = ["📋 Test Results:"];
  result.push(`   ✅ ${summary.passed} passed`);
  if (summary.failed > 0) {
    result.push(`   ❌ ${summary.failed} failed`);
  }
  if (summary.skipped > 0) {
    result.push(`   ⏭️  ${summary.skipped} skipped`);
  }

  if (summary.failed > 0 && summary.failures.length > 0) {
    result.push("\n   Failures:");
    for (const failure of summary.failures.slice(0, 5)) {
      const failureLines = failure.split("\n");
      const firstLine = failureLines[0];
      const includedIndexes = new Set<number>([0]);

      result.push(`   • ${formatFailureLine(firstLine, 70)}`);

      for (let index = 1; index < failureLines.length && index < 4; index++) {
        const line = failureLines[index];
        if (line.trim()) {
          result.push(`     ${formatFailureLine(line, 65)}`);
          includedIndexes.add(index);
        }
      }

      const locationIndexes = failureLines
        .map((line, index) => (isLocationLine(line) ? index : -1))
        .filter((index) => index >= 0 && !includedIndexes.has(index));

      for (const index of locationIndexes.slice(0, 2)) {
        const line = failureLines[index];
        if (line.trim()) {
          result.push(`     ${formatFailureLine(line, 120)}`);
          includedIndexes.add(index);
        }
      }

      const hiddenCount = failureLines.length - includedIndexes.size;
      if (hiddenCount > 0) {
        result.push(`     ... (${hiddenCount} more lines)`);
      }
    }
    if (summary.failures.length > 5) {
      result.push(`   ... and ${summary.failures.length - 5} more failures`);
    }
  }

  return result.join("\n");
}

export const createBuildOutputFilter = (
  options: CommandFilterOptions,
): CommandOutputFilter => ({
  id: "build",
  enabled: options.enabled,
  matches: (command) => isBuildCommand(command, options.commands),
  apply: (output, command) =>
    filterBuildOutput(output, command, options.commands),
});

export const createTestOutputFilter = (
  options: CommandFilterOptions,
): CommandOutputFilter => ({
  id: "test",
  enabled: options.enabled,
  matches: (command) => isTestCommand(command, options.commands),
  apply: (output, command) =>
    aggregateTestOutput(output, command, options.commands),
});
