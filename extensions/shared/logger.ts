import { promises as fsPromises } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadGlobalSettings } from "./settings.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const DEFAULT_LOG_LEVEL: LogLevel = "debug";

const getDefaultLogFilePath = (): string =>
  path.join(os.homedir(), ".pi", "agent", "pi-debug.log");

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
  if (logConfig.logFilePath === null) {
    return null;
  }
  if (typeof logConfig.logFilePath === "string") {
    const trimmed = logConfig.logFilePath.trim();
    if (trimmed === "") {
      return null;
    }
    const resolved = resolveEnvVar(trimmed);
    return resolved ?? getDefaultLogFilePath();
  }
  return getDefaultLogFilePath();
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

  const emit = (level: LogLevel, message: string, data?: unknown): void => {
    if (!shouldLog(level, minLevel)) {
      return;
    }

    const line = formatLine(extensionName, level, message, data, now);

    if (stderr) {
      stderr.write(line);
    }
    if (logFilePath) {
      void appendToFile(logFilePath, line);
    }
  };

  return {
    debug: (message, data) => emit("debug", message, data),
    info: (message, data) => emit("info", message, data),
    warn: (message, data) => emit("warn", message, data),
    error: (message, data) => emit("error", message, data),
  };
};
