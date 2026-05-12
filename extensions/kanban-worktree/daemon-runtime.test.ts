import {
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { defaultSocketPath } from "./daemon.js";
import {
  computeDaemonBuildId,
  defaultMetadataPath,
  readDaemonMetadata,
  writeDaemonMetadata,
} from "./daemon-runtime.js";

let dir: string;
let repoRoot: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kanban-worktree-runtime-"));
  repoRoot = path.join(dir, "repo");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("metadata path shares the socket repo hash", () => {
  expect(defaultMetadataPath(repoRoot)).toBe(
    defaultSocketPath(repoRoot).replace(/\.sock$/, ".json"),
  );
});

test("metadata is written atomically and can be read back", async () => {
  const socketPath = path.join(dir, "daemon.sock");
  const metadataPath = path.join(dir, "daemon.json");

  await writeDaemonMetadata(metadataPath, {
    pid: 123,
    repoRoot,
    socketPath,
    protocolVersion: 1,
    buildId: "mtime:test",
    startedAt: "2026-05-12T00:00:00.000Z",
  });

  await expect(readDaemonMetadata(metadataPath)).resolves.toEqual({
    pid: 123,
    repoRoot,
    socketPath,
    protocolVersion: 1,
    buildId: "mtime:test",
    startedAt: "2026-05-12T00:00:00.000Z",
  });
});

test("daemon build id changes when a runtime file mtime changes", async () => {
  const first = await computeDaemonBuildId();
  const runtimeFile = path.join(
    process.cwd(),
    "extensions/kanban-worktree/logger.ts",
  );
  const original = await stat(runtimeFile);

  try {
    const nextTime = new Date(original.mtimeMs + 2000);
    await writeFile(runtimeFile, await readFile(runtimeFile));
    await utimes(runtimeFile, nextTime, nextTime);
    const second = await computeDaemonBuildId();
    expect(second).not.toBe(first);
  } finally {
    await utimes(runtimeFile, original.atime, original.mtime);
  }
});
