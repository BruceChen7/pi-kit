import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import { readDaemonMetadata, writeDaemonMetadata } from "./daemon-runtime.js";
import {
  ensureKanbanDaemon,
  stopAllKanbanDaemons,
  stopKanbanDaemon,
} from "./daemon-supervisor.js";
import { sendJsonLineRequest } from "./protocol.js";

let dir: string;
let repoRoot: string;
let socketPath: string;
let metadataPath: string;
let daemonPath: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kanban-worktree-supervisor-"));
  repoRoot = path.join(dir, "repo");
  socketPath = path.join(dir, "daemon.sock");
  metadataPath = path.join(dir, "daemon.json");
  daemonPath = path.join(
    process.cwd(),
    "extensions/kanban-worktree/run-daemon.ts",
  );
});

afterEach(async () => {
  await stopKanbanDaemon({ repoRoot, socketPath, metadataPath });
  await rm(dir, { recursive: true, force: true });
});

test("ensure starts a daemon that can be stopped without a child reference", async () => {
  await ensureKanbanDaemon({ daemonPath, repoRoot, socketPath, metadataPath });

  await expect(
    sendJsonLineRequest(socketPath, {
      id: "health",
      method: "daemon.health",
    }),
  ).resolves.toEqual(
    expect.objectContaining({ result: expect.objectContaining({ repoRoot }) }),
  );

  await stopKanbanDaemon({ repoRoot, socketPath, metadataPath });

  expect(await canConnect(socketPath)).toBe(false);
  await expect(readDaemonMetadata(metadataPath)).resolves.toBeNull();
});

test("stop-all stops every daemon discovered from metadata", async () => {
  const otherRepoRoot = path.join(dir, "other-repo");
  const otherSocketPath = path.join(dir, "other.sock");
  const otherMetadataPath = path.join(dir, "other.json");

  await ensureKanbanDaemon({ daemonPath, repoRoot, socketPath, metadataPath });
  await ensureKanbanDaemon({
    daemonPath,
    repoRoot: otherRepoRoot,
    socketPath: otherSocketPath,
    metadataPath: otherMetadataPath,
  });

  await stopAllKanbanDaemons(dir);

  expect(await canConnect(socketPath)).toBe(false);
  expect(await canConnect(otherSocketPath)).toBe(false);
  await expect(readDaemonMetadata(metadataPath)).resolves.toBeNull();
  await expect(readDaemonMetadata(otherMetadataPath)).resolves.toBeNull();
});

test("stop does not kill a process when socket is already gone", async () => {
  const sleeper = spawn(process.execPath, [
    "-e",
    "setInterval(() => {}, 1000)",
  ]);
  try {
    await writeDaemonMetadata(metadataPath, {
      pid: sleeper.pid ?? 0,
      repoRoot,
      socketPath,
      protocolVersion: 1,
      buildId: "mtime:stale",
      startedAt: "2026-05-12T00:00:00.000Z",
    });

    await stopKanbanDaemon({ repoRoot, socketPath, metadataPath });

    expect(sleeper.exitCode).toBeNull();
    await expect(readDaemonMetadata(metadataPath)).resolves.toBeNull();
  } finally {
    sleeper.kill("SIGTERM");
  }
});

test("ensure replaces a live daemon with mismatched metadata", async () => {
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      daemonPath,
      "--socket",
      socketPath,
      "--metadata",
      metadataPath,
      "--repo-root",
      repoRoot,
    ],
    { stdio: "ignore" },
  );
  await waitForSocket(socketPath, 2000);
  await waitForMetadata(metadataPath, 2000);
  const stale = await readDaemonMetadata(metadataPath);
  if (!stale) throw new Error("expected daemon metadata");
  await writeDaemonMetadata(metadataPath, {
    ...stale,
    buildId: "mtime:old-build",
  });

  await ensureKanbanDaemon({ daemonPath, repoRoot, socketPath, metadataPath });

  const fresh = await readDaemonMetadata(metadataPath);
  expect(fresh?.pid).not.toBe(child.pid);
  expect(fresh?.buildId).not.toBe("mtime:old-build");
});

async function waitForMetadata(
  targetMetadataPath: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await readDaemonMetadata(targetMetadataPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`metadata did not become ready: ${targetMetadataPath}`);
}

async function waitForSocket(
  targetSocketPath: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(targetSocketPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`socket did not become ready: ${targetSocketPath}`);
}

function canConnect(targetSocketPath: string): Promise<boolean> {
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
    socket.connect(targetSocketPath);
  });
}
