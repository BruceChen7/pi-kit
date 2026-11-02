import { promises as fsPromises } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadGlobalSettings } from "./settings.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const DEFAULT_LOG_LEVEL: LogLevel = "debug";

const getDefaultLogFilePath = (): string =>
  path.join(os.homedir(), ".pi", "agent", "pi-debug.log");

/**
 * Whether this process is a test run.
 *
 * The default destination is the *runtime's* log — the record a running Pi
 * process leaves behind. A test that constructs a logger would append its
 * fixtures to that same file and bury real incidents, so under test the
 * default resolves to nothing. An explicitly configured `logFilePath` still
 * wins, which keeps the logger itself testable.
 */
const isTestRun = (): boolean =>
  Boolean(process.env.VITEST) || process.env.NODE_ENV === "test";

/**
 * Resolve environment variable - support $VAR or ${VAR} syntax
 */
export const resolveEnvVar = (
  value: string | undefined,
): string | undefined => {
  if (!value) return undefined;
  const match = value.match(/^\$\{?(\w+)\}?$/);
  if (match) {
    return process.env[match[1]];
  }
  return value;
};

type Logger = {
  debug: (message: string, data?: unknown) => void;
  info: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
  error: (message: string, data?: unknown) => void;
};

type CreateLoggerOptions = {
  minLevel?: LogLevel;
  logFilePath?: string | null;
  stderr?: NodeJS.WritableStream | null;
  now?: () => Date;
};

type ExtensionsLogConfig = {
  minLevel?: unknown;
  logLevel?: unknown;
  logFilePath?: unknown;
  overrides?: Record<string, unknown>;
};

type LogSink = {
  write: (line: string) => void;
};

type LogSinkOptions = {
  logFilePath: string | null;
  stderr: NodeJS.WritableStream | null;
};

const sinkCache = new Map<string, LogSink>();
let streamIds = new WeakMap<NodeJS.WritableStream, number>();
let nextStreamId = 0;

const getStreamId = (stream: NodeJS.WritableStream): number => {
  const cached = streamIds.get(stream);
  if (cached !== undefined) {
    return cached;
  }
  nextStreamId += 1;
  streamIds.set(stream, nextStreamId);
  return nextStreamId;
};

const getStreamKey = (stream: NodeJS.WritableStream | null): string =>
  stream ? `stream:${getStreamId(stream)}` : "stream:none";

const getLogSinkKey = (
  logFilePath: string | null,
  stderr: NodeJS.WritableStream | null,
): string => `${logFilePath ?? "none"}|${getStreamKey(stderr)}`;

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const parseLogLevel = (value: unknown): LogLevel | null => {
  if (
    value === "debug" ||
    value === "info" ||
    value === "warn" ||
    value === "error"
  ) {
    return value;
  }
  return null;
};

const getLogConfig = (settings: unknown): ExtensionsLogConfig => {
  if (!settings || typeof settings !== "object") {
    return {};
  }

  const root = settings as {
    third_extensions?: {
      log?: ExtensionsLogConfig;
    };
  };

  return root.third_extensions?.log ?? {};
};

const resolveLogFilePath = (settings: unknown): string | null => {
  const logConfig = getLogConfig(settings);
  const defaultPath = isTestRun() ? null : getDefaultLogFilePath();

  if (logConfig.logFilePath === null) {
    return null;
  }
  if (typeof logConfig.logFilePath === "string") {
    const trimmed = logConfig.logFilePath.trim();
    if (trimmed === "") {
      return null;
    }
    const resolved = resolveEnvVar(trimmed);
    return resolved ?? defaultPath;
  }
  return defaultPath;
};

export const resolveMinLogLevel = (
  settings: unknown,
  extensionName: string,
): LogLevel => {
  const logConfig = getLogConfig(settings);
  const overrides =
    logConfig.overrides && typeof logConfig.overrides === "object"
      ? (logConfig.overrides as Record<string, unknown>)
      : undefined;

  const overrideLevel = parseLogLevel(overrides?.[extensionName]);
  if (overrideLevel) {
    return overrideLevel;
  }

  const minLevel = parseLogLevel(logConfig.minLevel);
  if (minLevel) {
    return minLevel;
  }

  const globalLevel = parseLogLevel(logConfig.logLevel);
  return globalLevel ?? DEFAULT_LOG_LEVEL;
};

export const shouldLog = (level: LogLevel, minLevel: LogLevel): boolean =>
  LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[minLevel];

const serializeData = (data: unknown): string => {
  try {
    return JSON.stringify(data);
  } catch {
    try {
      return JSON.stringify(String(data));
    } catch {
      return '"[unserializable]"';
    }
  }
};

const formatLine = (
  extensionName: string,
  level: LogLevel,
  message: string,
  data: unknown,
  now: () => Date,
): string => {
  const ts = now().toISOString();
  const suffix = data === undefined ? "" : ` ${serializeData(data)}`;
  return `[ext:${extensionName}][${level}][${ts}] ${message}${suffix}\n`;
};

const appendToFile = async (
  logFilePath: string,
  line: string,
): Promise<void> => {
  try {
    await fsPromises.mkdir(path.dirname(logFilePath), { recursive: true });
    await fsPromises.appendFile(logFilePath, line, "utf8");
  } catch {
    // do not block extension flow on logging failures
  }
};

const createLogSink = ({ logFilePath, stderr }: LogSinkOptions): LogSink => {
  let fileQueue = Promise.resolve();

  const enqueueFileWrite = (line: string): void => {
    if (!logFilePath) {
      return;
    }
    fileQueue = fileQueue.then(() => appendToFile(logFilePath, line));
  };

  return {
    write: (line) => {
      if (stderr) {
        stderr.write(line);
      }
      if (logFilePath) {
        enqueueFileWrite(line);
      }
    },
  };
};

const getLogSink = (
  logFilePath: string | null,
  stderr: NodeJS.WritableStream | null,
): LogSink => {
  const key = getLogSinkKey(logFilePath, stderr);
  const cached = sinkCache.get(key);
  if (cached) {
    return cached;
  }
  const sink = createLogSink({ logFilePath, stderr });
  sinkCache.set(key, sink);
  return sink;
};

export const clearLoggerCache = (): void => {
  sinkCache.clear();
  streamIds = new WeakMap<NodeJS.WritableStream, number>();
  nextStreamId = 0;
};

export const createLogger = (
  extensionName: string,
  options: CreateLoggerOptions = {},
): Logger => {
  const { global: settings } = loadGlobalSettings();
  const minLevel =
    options.minLevel ?? resolveMinLogLevel(settings, extensionName);
  const logFilePathFromSettings = resolveLogFilePath(settings);
  const logFilePath =
    options.logFilePath === undefined
      ? logFilePathFromSettings
      : options.logFilePath;

  const stderr = options.stderr === undefined ? process.stderr : options.stderr;
  const now = options.now ?? (() => new Date());
  const sink = getLogSink(logFilePath, stderr);

  const emit = (level: LogLevel, message: string, data?: unknown): void => {
    if (!shouldLog(level, minLevel)) {
      return;
    }

    const line = formatLine(extensionName, level, message, data, now);

    sink.write(line);
  };

  return {
    debug: (message, data) => emit("debug", message, data),
    info: (message, data) => emit("info", message, data),
    warn: (message, data) => emit("warn", message, data),
    error: (message, data) => emit("error", message, data),
  };
};
