import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLogger,
  type LogLevel,
  resolveMinLogLevel,
  shouldLog,
} from "./logger.js";

class CaptureStream extends Writable {
  public output = "";

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.output += chunk.toString();
    callback();
  }
}

const tempHomes: string[] = [];
const originalHome = process.env.HOME;

const createTempSettingsHome = (content: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-logger-"));
  tempHomes.push(dir);

  const settingsPath = path.join(dir, ".pi", "agent", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, content, "utf8");
  return dir;
};

const restoreHome = (): void => {
  if (originalHome === undefined) {
    delete process.env.HOME;
    return;
  }
  process.env.HOME = originalHome;
};

afterEach(() => {
  restoreHome();
  for (const dir of tempHomes.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveMinLogLevel", () => {
  it("prefers extension override over global level", () => {
    const settings = {
      third_extensions: {
        log: {
          minLevel: "error",
          overrides: {
            notify: "info",
          },
        },
      },
    };

    expect(resolveMinLogLevel(settings, "notify")).toBe("info");
  });

  it("falls back to debug when config is missing or invalid", () => {
    expect(resolveMinLogLevel({}, "notify")).toBe("debug");

    const invalid = {
      third_extensions: {
        log: {
          minLevel: "trace",
        },
      },
    };
    expect(resolveMinLogLevel(invalid, "notify")).toBe("debug");
  });

  it("uses logLevel when minLevel is invalid", () => {
    const settings = {
      third_extensions: {
        log: {
          minLevel: "trace",
          logLevel: "warn",
        },
      },
    };

    expect(resolveMinLogLevel(settings, "notify")).toBe("warn");
  });
});

describe("shouldLog", () => {
  it("prints logs only when level is greater or equal to min level", () => {
    expect(shouldLog("debug", "info")).toBe(false);
    expect(shouldLog("info", "info")).toBe(true);
    expect(shouldLog("error", "warn")).toBe(true);
  });
});

describe("createLogger", () => {
  it("reads global settings and filters logs by minimum level", () => {
    process.env.HOME = createTempSettingsHome(
      JSON.stringify(
        {
          third_extensions: {
            log: {
              minLevel: "warn",
              overrides: {
                notify: "info",
              },
            },
          },
        },
        null,
        2,
      ),
    );

    const stream = new CaptureStream();
    const logger = createLogger("notify", {
      logFilePath: null,
      stderr: stream,
      now: () => new Date("2026-03-11T06:00:00.000Z"),
    });

    logger.debug("debug-message");
    logger.info("info-message", { phase: "start" });

    expect(stream.output).not.toContain("debug-message");
    expect(stream.output).toContain(
      "[ext:notify][info][2026-03-11T06:00:00.000Z] info-message",
    );
    expect(stream.output).toContain('{"phase":"start"}');
  });

  it("uses explicit minLevel option with highest priority", () => {
    process.env.HOME = createTempSettingsHome("{}");
    const stream = new CaptureStream();

    const logger = createLogger("notify", {
      logFilePath: null,
      minLevel: "error" satisfies LogLevel,
      stderr: stream,
      now: () => new Date("2026-03-11T06:00:00.000Z"),
    });

    logger.warn("warn-message");
    logger.error("error-message");

    expect(stream.output).not.toContain("warn-message");
    expect(stream.output).toContain("error-message");
  });

  it("allows disabling log file via settings", () => {
    const home = createTempSettingsHome(
      JSON.stringify(
        {
          third_extensions: {
            log: {
              logFilePath: null,
            },
          },
        },
        null,
        2,
      ),
    );
    process.env.HOME = home;

    const logger = createLogger("notify", {
      stderr: null,
    });

    logger.info("info-message");

    const logPath = path.join(home, ".pi", "agent", "pi-debug.log");
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it("handles unserializable data payloads", () => {
    process.env.HOME = createTempSettingsHome("{}");
    const stream = new CaptureStream();

    const logger = createLogger("notify", {
      logFilePath: null,
      stderr: stream,
      now: () => new Date("2026-03-11T06:00:00.000Z"),
    });

    const payload: Record<string, unknown> = {};
    payload.self = payload;

    expect(() => logger.info("circular", payload)).not.toThrow();
    expect(stream.output).toContain("circular");
  });
});
