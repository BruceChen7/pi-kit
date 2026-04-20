import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildDiffxStartCommand,
  clearPersistedDiffxReviewSession,
  loadPersistedDiffxReviewSession,
  persistDiffxReviewSession,
} from "./runtime.ts";

const tempDirs: string[] = [];

const createTempRepo = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-diffx-review-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("diffx-review runtime", () => {
  it("prefers the configured diffx command", () => {
    const command = buildDiffxStartCommand({
      repoRoot: "/tmp/repo",
      diffxCommand: "diffx",
      host: "127.0.0.1",
      port: 3433,
      openInBrowser: false,
      diffArgs: ["main..HEAD"],
      startupTimeoutMs: 15000,
    });

    expect(command).toEqual({
      command: "diffx",
      args: [
        "--host",
        "127.0.0.1",
        "--port",
        "3433",
        "--no-open",
        "--",
        "main..HEAD",
      ],
      description: "diffx --host 127.0.0.1 --port 3433 --no-open -- main..HEAD",
    });
  });

  it("supports multi-token commands like npx diffx-cli", () => {
    const command = buildDiffxStartCommand({
      repoRoot: "/tmp/repo",
      diffxCommand: "npx diffx-cli",
      host: "0.0.0.0",
      port: null,
      openInBrowser: true,
      diffArgs: [],
      startupTimeoutMs: 15000,
    });

    expect(command).toEqual({
      command: "npx",
      args: ["diffx-cli", "--host", "0.0.0.0"],
      description: "npx diffx-cli --host 0.0.0.0",
    });
  });

  it("falls back to the default diffx command when none is configured", () => {
    const command = buildDiffxStartCommand({
      repoRoot: "/tmp/repo",
      diffxCommand: "diffx",
      host: "127.0.0.1",
      port: null,
      openInBrowser: true,
      diffArgs: ["--cached"],
      startupTimeoutMs: 15000,
    });

    expect(command).toEqual({
      command: "diffx",
      args: ["--host", "127.0.0.1", "--", "--cached"],
      description: "diffx --host 127.0.0.1 -- --cached",
    });
  });

  it("persists and reloads session metadata for reconnect", () => {
    const repoRoot = createTempRepo();
    const persisted = {
      repoRoot,
      host: "127.0.0.1",
      port: 3433,
      url: "http://127.0.0.1:3433",
      pid: 999,
      startedAt: 123,
      diffArgs: ["origin/main...HEAD"],
      openInBrowser: true,
      cwdAtStart: repoRoot,
      startCommand: "diffx --host 127.0.0.1 -- origin/main...HEAD",
      lastHealthcheckAt: null,
      lastHealthcheckOk: null,
    };

    persistDiffxReviewSession(persisted);

    expect(loadPersistedDiffxReviewSession(repoRoot)).toEqual({
      ...persisted,
      child: null,
    });

    clearPersistedDiffxReviewSession(repoRoot);
    expect(loadPersistedDiffxReviewSession(repoRoot)).toBeNull();
  });
});
