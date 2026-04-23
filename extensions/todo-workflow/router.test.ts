import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getStaticTodoCommandCompletionItems,
  getTodoArgumentCompletions,
  parseTodoCommand,
} from "./router.js";

const tempDirs: string[] = [];

function createTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-todo-router-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("todo router", () => {
  it("parses add --start into a single lifecycle action", () => {
    expect(parseTodoCommand("add --start Fix status banner")).toEqual({
      kind: "add",
      description: "Fix status banner",
      startNow: true,
    });
  });

  it("parses cleanup --all without leaking finish/cleanup implementation details", () => {
    expect(parseTodoCommand("cleanup --all")).toEqual({
      kind: "cleanup-all",
    });
  });

  it("exposes the unified top-level completion surface", () => {
    expect(
      getStaticTodoCommandCompletionItems().map((item) => item.value),
    ).toEqual([
      "add",
      "start",
      "resume",
      "finish",
      "cleanup",
      "remove",
      "list",
      "show",
    ]);
  });

  it("filters todo id completions by command semantics", async () => {
    const initialCwd = process.cwd();
    const repoRoot = createTempRepo();

    fs.writeFileSync(
      path.join(repoRoot, ".pi", "todos.json"),
      JSON.stringify(
        {
          todos: [
            {
              id: "queued-task",
              description: "Queued task",
              status: "todo",
              createdAt: "2026-04-23T08:00:00.000Z",
              updatedAt: "2026-04-23T08:00:00.000Z",
            },
            {
              id: "active-task",
              description: "Active task",
              status: "doing",
              workBranch: "active-task",
              createdAt: "2026-04-23T08:10:00.000Z",
              updatedAt: "2026-04-23T08:10:00.000Z",
              startedAt: "2026-04-23T08:11:00.000Z",
            },
            {
              id: "done-task",
              description: "Done task",
              status: "done",
              createdAt: "2026-04-23T08:20:00.000Z",
              updatedAt: "2026-04-23T08:20:00.000Z",
              completedAt: "2026-04-23T08:21:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    try {
      process.chdir(repoRoot);

      const startCompletions = await getTodoArgumentCompletions(
        {} as never,
        "start ",
      );
      const resumeCompletions = await getTodoArgumentCompletions(
        {} as never,
        "resume ",
      );
      const showCompletions = await getTodoArgumentCompletions(
        {} as never,
        "show ",
      );
      const removeCompletions = await getTodoArgumentCompletions(
        {} as never,
        "remove ",
      );

      expect(startCompletions?.map((item) => item.value)).toEqual([
        "start queued-task",
      ]);
      expect(resumeCompletions?.map((item) => item.value)).toEqual([
        "resume active-task",
      ]);
      expect(showCompletions?.map((item) => item.value)).toEqual([
        "show queued-task",
        "show active-task",
        "show done-task",
      ]);
      expect(removeCompletions?.map((item) => item.value)).toEqual([
        "remove queued-task",
        "remove active-task",
        "remove done-task",
      ]);
    } finally {
      process.chdir(initialCwd);
    }
  });
});
