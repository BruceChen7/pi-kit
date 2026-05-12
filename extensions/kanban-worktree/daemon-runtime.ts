import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const KANBAN_DAEMON_PROTOCOL_VERSION = 1;

export type KanbanDaemonMetadata = {
  pid: number;
  repoRoot: string;
  socketPath: string;
  protocolVersion: number;
  buildId: string;
  startedAt: string;
};

const DAEMON_RUNTIME_FILES = [
  "daemon.ts",
  "run-daemon.ts",
  "protocol.ts",
  "launch-service.ts",
  "todo-source.ts",
  "gateways.ts",
  "logger.ts",
];

export function defaultKanbanRoot(): string {
  return path.join(os.homedir(), ".pi", "agent", "kanban-worktree");
}

export function repoHash(repoRoot: string): string {
  return Buffer.from(repoRoot).toString("base64url").slice(0, 32);
}

export function defaultSocketPath(repoRoot: string = process.cwd()): string {
  return path.join(defaultKanbanRoot(), "run", `${repoHash(repoRoot)}.sock`);
}

export function defaultMetadataPath(repoRoot: string = process.cwd()): string {
  return path.join(defaultKanbanRoot(), "run", `${repoHash(repoRoot)}.json`);
}

export async function computeDaemonBuildId(
  baseDir = path.dirname(new URL(import.meta.url).pathname),
): Promise<string> {
  const parts = await Promise.all(
    DAEMON_RUNTIME_FILES.map(async (file) => {
      const fileStat = await stat(path.join(baseDir, file));
      return `${file}:${fileStat.mtimeMs}:${fileStat.size}`;
    }),
  );
  return `mtime:${createHash("sha256").update(parts.join("\n")).digest("hex")}`;
}

export async function readDaemonMetadata(
  metadataPath: string,
): Promise<KanbanDaemonMetadata | null> {
  try {
    return JSON.parse(
      await readFile(metadataPath, "utf8"),
    ) as KanbanDaemonMetadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeDaemonMetadata(
  metadataPath: string,
  metadata: KanbanDaemonMetadata,
): Promise<void> {
  await mkdir(path.dirname(metadataPath), { recursive: true });
  const tempPath = `${metadataPath}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(metadata, null, 2)}\n`);
  await rename(tempPath, metadataPath);
}

export async function unlinkDaemonMetadata(
  metadataPath: string,
): Promise<void> {
  await rm(metadataPath, { force: true });
}

export function defaultKanbanRunDir(): string {
  return path.join(defaultKanbanRoot(), "run");
}
