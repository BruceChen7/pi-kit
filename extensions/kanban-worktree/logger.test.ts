import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, expect, test } from "vitest";

import { clearLoggerCache } from "../shared/logger.js";
import { clearSettingsCache } from "../shared/settings.js";
import { createKanbanLogger } from "./logger.js";

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

const createTempHome = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-kanban-logger-"));
  tempHomes.push(dir);
  process.env.HOME = dir;
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
  clearSettingsCache();
  clearLoggerCache();
  restoreHome();
  for (const dir of tempHomes.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("kanban logger keeps diagnostics in the log file without writing stderr", async () => {
  const home = createTempHome();
  clearSettingsCache();
  clearLoggerCache();
  const stderr = new CaptureStream();
  const logFilePath = path.join(home, ".pi", "agent", "pi-debug.log");
  const logger = createKanbanLogger("extension", { logFilePath, stderr });

  logger.info("command received", { sub: "open" });
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(stderr.output).toBe("");
  expect(fs.readFileSync(logFilePath, "utf8")).toContain("command received");
});
