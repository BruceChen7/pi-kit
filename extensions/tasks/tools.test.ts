/**
 * Tasks extension — smoke tests for the imperative shell wiring:
 * tool registration, command registration, and db persistence round-trip.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerCommands } from "./cli.ts";
import { defaultDbPath, readDb, withDb, writeDb } from "./db.ts";
import * as S from "./store.ts";
import { emptyDb } from "./store.ts";
import { registerTools } from "./tools.ts";

/* ------------------------------------------------------------------ */
/*  Fake ExtensionAPI                                                  */
/* ------------------------------------------------------------------ */

function createFakePi() {
  const fake = {
    tools: [] as { name: string; description: string }[],
    commands: [] as ({ name: string } & Record<string, unknown>)[],
    notifications: [] as { text: string; kind: string }[],
    registerTool(tool: { name: string; description: string }) {
      fake.tools.push({ name: tool.name, description: tool.description });
    },
    registerCommand(name: string, def: unknown) {
      fake.commands.push({ name });
      Object.assign(fake.commands, { [name]: def });
    },
    sendUserMessage() {},
    on() {},
  };
  return fake;
}

/* ------------------------------------------------------------------ */
/*  db round-trip                                                      */
/* ------------------------------------------------------------------ */

describe("db persistence", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "tasks-db-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns empty db when file is missing", async () => {
    const dbPath = defaultDbPath(dir);
    const db = await readDb(dbPath);
    expect(db.tasks).toEqual([]);
    expect(db.projects).toEqual([]);
  });

  it("writes and reads back atomically", async () => {
    const dbPath = defaultDbPath(dir);
    let db = emptyDb();
    db = S.createProject(db, {
      name: "test",
      prefix: "TST",
      color: "#6366f1",
      folderId: null,
    }).db;
    const project = S.listProjects(db)[0];
    db = S.createTask(db, { projectId: project.id, title: "Hello" }).db;

    await writeDb(dbPath, db);
    const loaded = await readDb(dbPath);
    expect(loaded.tasks).toHaveLength(1);
    expect(loaded.tasks[0].key).toBe("TST-1");
    expect(loaded.tasks[0].title).toBe("Hello");
  });

  it("rejects invalid json", async () => {
    const dbPath = defaultDbPath(dir);
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(path.dirname(dbPath), { recursive: true }),
    );
    await writeFile(dbPath, "{ not json", "utf8");
    await expect(readDb(dbPath)).rejects.toThrow();
  });

  it("withDb runs a mutation and persists", async () => {
    const dbPath = defaultDbPath(dir);
    const project = await withDb(dbPath, (db) => {
      const r = S.createProject(db, {
        name: "p",
        prefix: "P",
        color: "#6366f1",
        folderId: null,
      });
      return { db: r.db, result: r.project };
    });
    const task = await withDb(dbPath, (db) => {
      const r = S.createTask(db, { projectId: project.id, title: "T1" });
      return { db: r.db, result: r.task };
    });
    expect(task.key).toBe("P-1");
    const loaded = await readDb(dbPath);
    expect(loaded.tasks).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/*  Tool registration                                                  */
/* ------------------------------------------------------------------ */

describe("tool registration", () => {
  it("registers the 9 expected tools", () => {
    const fake = createFakePi();
    registerTools(fake as unknown as ExtensionAPI, () => "/tmp");
    const names = fake.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "task_board_move",
        "task_comment",
        "task_create",
        "task_delegate",
        "task_list",
        "task_project_create",
        "task_project_list",
        "task_show",
        "task_update",
      ].sort(),
    );
  });
});

/* ------------------------------------------------------------------ */
/*  Command registration                                               */
/* ------------------------------------------------------------------ */

describe("command registration", () => {
  it("registers the /issue command", () => {
    const fake = createFakePi();
    registerCommands(fake as unknown as ExtensionAPI);
    const names = fake.commands.map((c) => c.name);
    expect(names).toContain("issue");
  });

  it("provides subcommand completions", () => {
    const fake = createFakePi();
    registerCommands(fake as unknown as ExtensionAPI);
    const taskCmd = (
      fake.commands as unknown as Record<
        string,
        { getArgumentCompletions: (p: string) => { value: string }[] }
      >
    ).issue;
    const completions = taskCmd.getArgumentCompletions("proj");
    expect(completions.map((c: { value: string }) => c.value)).toContain(
      "project create",
    );
    expect(completions.map((c: { value: string }) => c.value)).toContain(
      "project list",
    );
  });
});
