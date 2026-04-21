import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createKanbanBoardSource } from "./board-source.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-kanban-board-"));
  tempDirs.push(dir);
  return dir;
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number = 1000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error("timed out waiting for condition");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("createKanbanBoardSource", () => {
  it("loads the initial snapshot and refreshes it when the board file changes", async () => {
    const dir = createTempDir();
    const boardPath = path.join(dir, "features.kanban.md");
    fs.writeFileSync(boardPath, "initial board\n", "utf-8");

    const source = createKanbanBoardSource({
      boardPath,
      pollIntervalMs: 20,
      readBoard: () => ({
        path: boardPath,
        lanes: [],
        cards: [],
        errors: [],
        raw: fs.readFileSync(boardPath, "utf-8"),
      }),
    });

    const snapshots: string[] = [];
    const unsubscribe = source.subscribe((snapshot) => {
      snapshots.push(String(snapshot.raw));
    });

    source.start();
    expect(source.getSnapshot()).toMatchObject({
      path: boardPath,
      raw: "initial board\n",
    });

    fs.writeFileSync(boardPath, "updated board\n", "utf-8");

    await waitUntil(() => snapshots.includes("updated board\n"));
    expect(source.getSnapshot()).toMatchObject({
      raw: "updated board\n",
    });

    unsubscribe();
    source.stop();
  });

  it("supports manual refresh after an in-process board patch", () => {
    const dir = createTempDir();
    const boardPath = path.join(dir, "features.kanban.md");
    fs.writeFileSync(boardPath, "initial board\n", "utf-8");

    const source = createKanbanBoardSource({
      boardPath,
      readBoard: () => ({
        path: boardPath,
        lanes: [],
        cards: [],
        errors: [],
        raw: fs.readFileSync(boardPath, "utf-8"),
      }),
    });

    source.start();
    fs.writeFileSync(boardPath, "patched board\n", "utf-8");
    source.refresh();

    expect(source.getSnapshot()).toMatchObject({
      raw: "patched board\n",
    });

    source.stop();
  });
});
