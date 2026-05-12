import { type ChildProcess, spawn } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";

import {
  computeDaemonBuildId,
  defaultKanbanRunDir,
  defaultMetadataPath,
  defaultSocketPath,
  KANBAN_DAEMON_PROTOCOL_VERSION,
  type KanbanDaemonMetadata,
  readDaemonMetadata,
} from "./daemon-runtime.ts";
import { sendJsonLineRequest } from "./protocol.ts";

const HEALTH_WAIT_MS = 5000;
const SHUTDOWN_WAIT_MS = 2000;
const KILL_WAIT_MS = 1000;
const POLL_INTERVAL_MS = 50;
const SOCKET_PROBE_MS = 100;

type DaemonTarget = {
  daemonPath?: string;
  repoRoot: string;
  socketPath?: string;
  metadataPath?: string;
};

type ResolvedDaemonTarget = {
  daemonPath: string | null;
  repoRoot: string;
  socketPath: string;
  metadataPath: string;
};

type DaemonHealth = {
  pid: number;
  repoRoot: string;
  socketPath: string;
  protocolVersion: number;
  buildId: string;
};

type RpcResponse<T> = {
  id: unknown;
  result?: T;
  error?: { message: string };
};

export async function isKanbanDaemonRunning(
  input: DaemonTarget,
): Promise<boolean> {
  const target = normalizeTarget(input);
  const expected = await expectedHealth(target.repoRoot, target.socketPath);
  const health = await readDaemonHealth(target.socketPath);
  const metadata = await readDaemonMetadata(target.metadataPath);
  return Boolean(
    health && metadata && isStrictMatch(health, metadata, expected),
  );
}

export async function ensureKanbanDaemon(
  input: DaemonTarget,
): Promise<boolean> {
  const target = normalizeTarget(input);
  const expected = await expectedHealth(target.repoRoot, target.socketPath);
  const health = await readDaemonHealth(target.socketPath);
  const metadata = await readDaemonMetadata(target.metadataPath);
  if (health && metadata && isStrictMatch(health, metadata, expected))
    return true;
  if (health) await stopKanbanDaemon(target);
  await cleanupStaleFiles(target.socketPath, target.metadataPath);
  if (!target.daemonPath) return false;
  spawnDaemon(
    target.daemonPath,
    target.repoRoot,
    target.socketPath,
    target.metadataPath,
  );
  return waitForStrictHealth(target, expected);
}

export async function stopKanbanDaemon(input: DaemonTarget): Promise<void> {
  const target = normalizeTarget(input);
  await requestShutdown(target.socketPath);
  if (await waitForSocketGone(target.socketPath, SHUTDOWN_WAIT_MS)) {
    await cleanupStaleFiles(target.socketPath, target.metadataPath);
    return;
  }
  const metadata = await readDaemonMetadata(target.metadataPath);
  if (metadata && (await canKillMetadataProcess(metadata, target))) {
    await killProcess(metadata.pid, "SIGTERM");
    if (!(await waitForSocketGone(target.socketPath, KILL_WAIT_MS))) {
      await killProcess(metadata.pid, "SIGKILL");
    }
  }
  await cleanupStaleFiles(target.socketPath, target.metadataPath);
}

export async function stopAllKanbanDaemons(
  runDir = defaultKanbanRunDir(),
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(runDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const metadataPath = path.join(runDir, entry);
    const metadata = await readDaemonMetadata(metadataPath);
    if (!metadata) continue;
    await stopKanbanDaemon({
      repoRoot: metadata.repoRoot,
      socketPath: metadata.socketPath,
      metadataPath,
    });
  }
}

async function requestShutdown(socketPath: string): Promise<void> {
  try {
    await sendJsonLineRequest(socketPath, {
      id: "shutdown",
      method: "daemon.shutdown",
    });
  } catch {
    // Fall back to metadata/PID cleanup below.
  }
}

function normalizeTarget(input: DaemonTarget): ResolvedDaemonTarget {
  return {
    daemonPath: input.daemonPath ?? null,
    repoRoot: input.repoRoot,
    socketPath: input.socketPath ?? defaultSocketPath(input.repoRoot),
    metadataPath: input.metadataPath ?? defaultMetadataPath(input.repoRoot),
  };
}

async function expectedHealth(
  repoRoot: string,
  socketPath: string,
): Promise<Omit<DaemonHealth, "pid">> {
  return {
    repoRoot,
    socketPath,
    protocolVersion: KANBAN_DAEMON_PROTOCOL_VERSION,
    buildId: await computeDaemonBuildId(),
  };
}

function isStrictMatch(
  health: DaemonHealth,
  metadata: KanbanDaemonMetadata,
  expected: Omit<DaemonHealth, "pid">,
): boolean {
  return (
    health.repoRoot === expected.repoRoot &&
    health.socketPath === expected.socketPath &&
    health.protocolVersion === expected.protocolVersion &&
    health.buildId === expected.buildId &&
    metadata.repoRoot === expected.repoRoot &&
    metadata.socketPath === expected.socketPath &&
    metadata.protocolVersion === expected.protocolVersion &&
    metadata.buildId === expected.buildId
  );
}

async function readDaemonHealth(
  socketPath: string,
): Promise<DaemonHealth | null> {
  try {
    const response = (await sendJsonLineRequest(socketPath, {
      id: "health",
      method: "daemon.health",
    })) as RpcResponse<DaemonHealth>;
    return response.result ?? null;
  } catch {
    return null;
  }
}

function spawnDaemon(
  daemonPath: string,
  repoRoot: string,
  socketPath: string,
  metadataPath: string,
): ChildProcess {
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
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.unref();
  return child;
}

async function waitForStrictHealth(
  target: ResolvedDaemonTarget,
  expected: Omit<DaemonHealth, "pid">,
): Promise<boolean> {
  const deadline = Date.now() + HEALTH_WAIT_MS;
  while (Date.now() < deadline) {
    const health = await readDaemonHealth(target.socketPath);
    const metadata = await readDaemonMetadata(target.metadataPath);
    if (health && metadata && isStrictMatch(health, metadata, expected))
      return true;
    await sleep(100);
  }
  return false;
}

async function cleanupStaleFiles(
  socketPath: string,
  metadataPath: string,
): Promise<void> {
  if (await canConnect(socketPath)) return;
  await rm(socketPath, { force: true });
  await rm(metadataPath, { force: true });
}

async function waitForSocketGone(
  socketPath: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await canConnect(socketPath))) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(SOCKET_PROBE_MS);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function canKillMetadataProcess(
  metadata: KanbanDaemonMetadata,
  target: ResolvedDaemonTarget,
): Promise<boolean> {
  if (metadata.repoRoot !== target.repoRoot) return false;
  if (metadata.socketPath !== target.socketPath) return false;
  try {
    process.kill(metadata.pid, 0);
  } catch {
    return false;
  }
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function killProcess(pid: number, signal: NodeJS.Signals): Promise<void> {
  try {
    process.kill(pid, signal);
  } catch {
    // Process may have exited between checks.
  }
}
