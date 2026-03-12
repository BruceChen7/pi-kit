import fs, { promises as fsPromises } from "node:fs";
import os from "node:os";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogConfig {
  logFilePath?: string;
  logLevel?: LogLevel;
}

export const DEFAULT_LOG_CONFIG: Required<LogConfig> = {
  logFilePath: path.join(os.homedir(), ".pi", "agent", "pi-debug.log"),
  logLevel: "debug",
};

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
  settingsPath?: string;
  logFilePath?: string;
  stderr?: NodeJS.WritableStream | null;
  now?: () => Date;
};

type ExtensionsLogConfig = {
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

const getLogConfig = (settings: unknown): ExtensionsLogConfig => {
  if (!settings || typeof settings !== "object") {
    return {};
  }

  const root = settings as {
    extensions?: {
      log?: ExtensionsLogConfig;
    };
  };

  return root.extensions?.log ?? {};
};

/**
 * Load log config from settings.json files.
 * Looks for "extensions.log" key in settings.json (project first, then global).
 */
export const loadLogConfig = async (
  cwd: string,
): Promise<Required<LogConfig>> => {
  const paths: string[] = [
    path.join(cwd, ".pi", "settings.json"),
    path.join(os.homedir(), ".pi", "agent", "settings.json"),
  ];

  for (const settingsPath of paths) {
    try {
      const content = await fsPromises.readFile(settingsPath, "utf-8");
      const settings = JSON.parse(content) as Record<string, unknown>;
      const logConfig = settings?.extensions?.log as LogConfig | undefined;

      if (logConfig) {
        // Resolve environment variables in logFilePath
        if (logConfig.logFilePath) {
          logConfig.logFilePath =
            resolveEnvVar(logConfig.logFilePath) ??
            DEFAULT_LOG_CONFIG.logFilePath;
        }
        if (logConfig.logLevel) {
          return { ...DEFAULT_LOG_CONFIG, ...logConfig };
        }
        return {
          ...DEFAULT_LOG_CONFIG,
          logLevel: logConfig.logLevel ?? DEFAULT_LOG_CONFIG.logLevel,
        };
      }
    } catch {
      // Continue to next path
    }
  }

  return DEFAULT_LOG_CONFIG;
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
  options: CreateLoggerOptions | LogConfig = {},
): Logger => {
  const settingsPath =
    "settingsPath" in options && options.settingsPath
      ? options.settingsPath
      : DEFAULT_SETTINGS_PATH;
  const settings = readSettings(settingsPath);

  let minLevel: LogLevel;
  let logFilePath: string | undefined;

  if ("logLevel" in options || "logFilePath" in options) {
    // LogConfig style - explicit values
    const logOptions = options as LogConfig;
    minLevel =
      logOptions.logLevel ?? resolveMinLogLevel(settings, extensionName);
    logFilePath = logOptions.logFilePath;
  } else {
    // CreateLoggerOptions style
    const opt = options as CreateLoggerOptions;
    minLevel = opt.minLevel ?? resolveMinLogLevel(settings, extensionName);
    logFilePath = opt.logFilePath;
  }

  const stderr =
    "stderr" in options
      ? options.stderr === undefined
        ? process.stderr
        : options.stderr
      : process.stderr;
  const now =
    "now" in options ? (options.now ?? (() => new Date())) : () => new Date();

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
