import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import { createTodo } from "../todo-workflow/todo-store.js";
import { sendJsonLineRequest } from "./protocol.js";

let dir: string;

function spawnDaemon(args: string[]) {
  return spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "extensions/kanban-worktree/run-daemon.ts",
      ...args,
    ],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kanban-worktree-daemon-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("daemon entrypoint uses explicit repo root for todo source", async () => {
  const socketPath = path.join(dir, "repo-root.sock");
  const repoRoot = path.join(dir, "repo");
  const todo = createTodo(repoRoot, "Visible from repo root", {
    id: "visible-from-repo-root",
  });
  const child = spawnDaemon(["--socket", socketPath, "--repo-root", repoRoot]);

  try {
    await waitForSocket(socketPath, 2000);
    await expect(
      sendJsonLineRequest(socketPath, {
        id: "list",
        method: "requirements.list",
      }),
    ).resolves.toEqual({
      id: "list",
      result: [
        expect.objectContaining({
          originId: todo.id,
          title: "Visible from repo root",
        }),
      ],
    });
  } finally {
    child.kill("SIGTERM");
  }
});

test("daemon entrypoint starts from source checkout", async () => {
  const socketPath = path.join(dir, "daemon.sock");
  const child = spawnDaemon([socketPath]);
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForSocket(socketPath, 2000);
  } finally {
    child.kill("SIGTERM");
  }

  expect(stderr).not.toContain("ERR_MODULE_NOT_FOUND");
});

async function waitForSocket(
  socketPath: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await canConnect(socketPath);
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`socket did not become ready: ${socketPath}`);
}

function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(50);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(socketPath);
  });
}
