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

const tempDirs: string[] = [];

const createTempSettingsFile = (content: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-logger-"));
  tempDirs.push(dir);

  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, content, "utf8");
  return settingsPath;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveMinLogLevel", () => {
  it("prefers extension override over global level", () => {
    const settings = {
      extensions: {
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
      extensions: {
        log: {
          minLevel: "trace",
        },
      },
    };
    expect(resolveMinLogLevel(invalid, "notify")).toBe("debug");
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
  it("reads settings file once and filters logs by minimum level", () => {
    const settingsPath = createTempSettingsFile(
      JSON.stringify(
        {
          extensions: {
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
      settingsPath,
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
    const settingsPath = createTempSettingsFile("{}");
    const stream = new CaptureStream();

    const logger = createLogger("notify", {
      settingsPath,
      minLevel: "error" satisfies LogLevel,
      stderr: stream,
      now: () => new Date("2026-03-11T06:00:00.000Z"),
    });

    logger.warn("warn-message");
    logger.error("error-message");

    expect(stream.output).not.toContain("warn-message");
    expect(stream.output).toContain("error-message");
  });
});
