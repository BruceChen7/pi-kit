import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const getNativeHostInfoMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("glimpseui", () => ({
  getNativeHostInfo: getNativeHostInfoMock,
}));

import {
  openGlimpseWindow,
  withRedirectedOpenWindowStderr,
} from "./glimpse-window.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kanban-worktree-glimpse-window-"));
  spawnMock.mockReset();
  getNativeHostInfoMock.mockReset();
  getNativeHostInfoMock.mockReturnValue({ path: "/tmp/glimpse-host" });
  spawnMock.mockReturnValue({
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    on: vi.fn(),
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("opens Glimpse native host with window options", () => {
  openGlimpseWindow("<html></html>", {
    width: 1100,
    height: 720,
    title: "Kanban Worktree",
  });

  expect(spawn).toHaveBeenCalledWith(
    "/tmp/glimpse-host",
    ["--width", "1100", "--height", "720", "--title", "Kanban Worktree"],
    {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: false,
    },
  );
});

test("redirects synchronous stderr writes while opening a window", async () => {
  const logPath = path.join(dir, "glimpse-stderr.log");
  let stderrOutput = "";
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrOutput += chunk.toString();
    return true;
  }) as typeof process.stderr.write;

  try {
    withRedirectedOpenWindowStderr(logPath, () => {
      process.stderr.write("native warning\n");
    });
  } finally {
    process.stderr.write = originalWrite;
  }

  expect(stderrOutput).toBe("");
  await expect(readFile(logPath, "utf8")).resolves.toContain("native warning");
});
