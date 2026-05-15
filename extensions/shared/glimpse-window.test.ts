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

const EXAMPLE_WINDOW_OPTIONS = {
  width: 800,
  height: 600,
  title: "Example",
};

let dir: string;
let stdin: PassThrough;
let stdout: PassThrough;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "shared-glimpse-window-"));
  stdin = new PassThrough();
  stdout = new PassThrough();
  spawnMock.mockReset();
  getNativeHostInfoMock.mockReset();
  getNativeHostInfoMock.mockReturnValue({ path: "/tmp/glimpse-host" });
  spawnMock.mockReturnValue({
    stdin,
    stdout,
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

test("passes native host extra args before window options", () => {
  getNativeHostInfoMock.mockReturnValue({
    path: "/tmp/glimpse-host",
    extraArgs: ["--profile", "debug"],
  });

  openGlimpseWindow("<html></html>", {
    width: 1200,
    height: 760,
    title: "Context Cache Graph",
  });

  expect(spawn).toHaveBeenCalledWith(
    "/tmp/glimpse-host",
    [
      "--profile",
      "debug",
      "--width",
      "1200",
      "--height",
      "760",
      "--title",
      "Context Cache Graph",
    ],
    expect.any(Object),
  );
});

test("sends initial HTML only for the first ready event", () => {
  openGlimpseWindow("<main>hello</main>", EXAMPLE_WINDOW_OPTIONS);

  stdout.write('{"type":"ready"}\n');
  stdout.write('{"type":"ready"}\n');

  const writes = stdin.read()?.toString() ?? "";
  expect(writes.match(/"type":"html"/g)).toHaveLength(1);
  expect(writes).toContain(
    Buffer.from("<main>hello</main>").toString("base64"),
  );
});

test("forwards host messages to window message listeners", () => {
  const window = openGlimpseWindow("<html></html>", EXAMPLE_WINDOW_OPTIONS);
  const handler = vi.fn();
  window.on("message", handler);

  stdout.write('{"type":"message","data":{"type":"refresh"}}\n');

  expect(handler).toHaveBeenCalledWith({ type: "refresh" });
});

test("does not write commands after the host closes", () => {
  const window = openGlimpseWindow("<html></html>", EXAMPLE_WINDOW_OPTIONS);

  stdout.write('{"type":"closed"}\n');
  window.send?.("window.refresh()");
  window.close?.();

  expect(stdin.read()).toBeNull();
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
