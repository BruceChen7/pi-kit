import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

type Logger = {
  debug: (message: string, data?: unknown) => void;
  info: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
  error: (message: string, data?: unknown) => void;
};

type CreateLoggerOptions = {
  minLevel?: LogLevel;
  settingsPath?: string;
  logFilePath?: string;
  stderr?: NodeJS.WritableStream | null;
  now?: () => Date;
};

type LogConfig = {
  minLevel?: unknown;
  overrides?: Record<string, unknown>;
};

const DEFAULT_SETTINGS_PATH = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "settings.json",
);
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

const readSettings = (settingsPath: string): unknown => {
  try {
    if (!fs.existsSync(settingsPath)) {
      return {};
    }
    const raw = fs.readFileSync(settingsPath, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
};

const getLogConfig = (settings: unknown): LogConfig => {
  if (!settings || typeof settings !== "object") {
    return {};
  }

  const root = settings as {
    extensions?: {
      log?: LogConfig;
    };
  };

  return root.extensions?.log ?? {};
};

export const resolveMinLogLevel = (
  settings: unknown,
  extensionName: string,
): LogLevel => {
  const logConfig = getLogConfig(settings);

  const overrideLevel = parseLogLevel(logConfig.overrides?.[extensionName]);
  if (overrideLevel) {
    return overrideLevel;
  }

  const globalLevel = parseLogLevel(logConfig.minLevel);
  return globalLevel ?? "debug";
};

export const shouldLog = (level: LogLevel, minLevel: LogLevel): boolean =>
  LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[minLevel];

const formatLine = (
  extensionName: string,
  level: LogLevel,
  message: string,
  data: unknown,
  now: () => Date,
): string => {
  const ts = now().toISOString();
  const suffix = data === undefined ? "" : ` ${JSON.stringify(data)}`;
  return `[ext:${extensionName}][${level}][${ts}] ${message}${suffix}\n`;
};

const appendToFile = (logFilePath: string, line: string): void => {
  try {
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    fs.appendFileSync(logFilePath, line, "utf8");
  } catch {
    // do not block extension flow on logging failures
  }
};

export const createLogger = (
  extensionName: string,
  options: CreateLoggerOptions = {},
): Logger => {
  const settingsPath = options.settingsPath ?? DEFAULT_SETTINGS_PATH;
  const settings = readSettings(settingsPath);
  const minLevel =
    options.minLevel ?? resolveMinLogLevel(settings, extensionName);
  const stderr = options.stderr === undefined ? process.stderr : options.stderr;
  const now = options.now ?? (() => new Date());
  const logFilePath = options.logFilePath;

  const emit = (level: LogLevel, message: string, data?: unknown): void => {
    if (!shouldLog(level, minLevel)) {
      return;
    }

    const line = formatLine(extensionName, level, message, data, now);

    if (stderr) {
      stderr.write(line);
    }
    if (logFilePath) {
      appendToFile(logFilePath, line);
    }
  };

  return {
    debug: (message, data) => emit("debug", message, data),
    info: (message, data) => emit("info", message, data),
    warn: (message, data) => emit("warn", message, data),
    error: (message, data) => emit("error", message, data),
  };
};
