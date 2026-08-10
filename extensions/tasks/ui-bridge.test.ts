/**
 * UI bridge tests — fake GlimpseWindow + real temp db file.
 *
 * Exercises the window ↔ host protocol: inbound messages mutate the store
 * through writeDb and broadcast a full snapshot to registered windows.
 */

import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultDbPath, writeDb } from "./db.ts";
import { emptyDb } from "./store.ts";
import {
  registerWindow,
  stopDbWatcher,
  type TasksBridgeContext,
} from "./ui-bridge.ts";
import { createTasksHtml } from "./ui-html.ts";

/** Minimal GlimpseWindow stand-in: captures send(js) payloads. */
class FakeWindow extends EventEmitter {
  sent: string[] = [];
  send(js: string): void {
    this.sent.push(js);
  }
  close(): void {
    this.emit("closed");
  }
  /** Simulate the page dispatching an inbound message via window.glimpse.send. */
  post(message: unknown): void {
    this.emit("message", message);
  }
}

function lastSnapshotPayload(win: FakeWindow): unknown {
  const last = win.sent[win.sent.length - 1];
  if (!last) throw new Error("no send(js) captured");
  const start = last.indexOf("detail: ") + "detail: ".length;
  const end = last.lastIndexOf(" }));");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`cannot parse payload: ${last.slice(0, 160)}`);
  }
  return JSON.parse(last.slice(start, end));
}

let tmpDirs: string[] = [];

async function setup(): Promise<{
  win: FakeWindow;
  dbPath: string;
  ctx: TasksBridgeContext;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "tasks-bridge-"));
  tmpDirs.push(dir);
  const dbPath = defaultDbPath(dir);
  await writeDb(dbPath, emptyDb());
  const win = new FakeWindow();
  const ctx: TasksBridgeContext = { pi: {} as never, projectRoot: dir, dbPath };
  registerWindow("test-win", win, ctx);
  return { win, dbPath, ctx };
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    stopDbWatcher(defaultDbPath(dir));
    await rm(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("tasks ui bridge", () => {
  it("get-snapshot broadcasts the current db", async () => {
    const { win, dbPath } = await setup();
    await writeDb(dbPath, seedForTest());
    win.post({ type: "get-snapshot" });
    await new Promise((r) => setTimeout(r, 20));
    const snapshot = lastSnapshotPayload(win) as { projects: unknown[] };
    expect(snapshot.projects.length).toBe(1);
  });

  it("create-task appends a task and broadcasts", async () => {
    const { win, dbPath } = await setup();
    await writeDb(dbPath, seedForTest());
    win.post({
      type: "create-task",
      title: "新任务",
      projectPrefix: "TASK",
      priority: "high",
      status: "todo",
    });
    await new Promise((r) => setTimeout(r, 30));
    const snapshot = lastSnapshotPayload(win) as {
      tasks: { key: string; title: string }[];
    };
    expect(snapshot.tasks.some((t) => t.title === "新任务")).toBe(true);
    expect(snapshot.tasks.find((t) => t.title === "新任务")?.key).toBe(
      "TASK-2",
    );
  });

  it("create-task with unknown project broadcasts an error", async () => {
    const { win } = await setup();
    win.post({ type: "create-task", title: "x", projectPrefix: "NOPE" });
    await new Promise((r) => setTimeout(r, 30));
    const last = win.sent[win.sent.length - 1];
    expect(last).toContain("tasks:error");
    expect(last).toContain("项目不存在");
  });

  it("create-project / create-folder mutate the db", async () => {
    const { win } = await setup();
    win.post({
      type: "create-project",
      name: "产品开发",
      prefix: "PROD",
      color: "#6366f1",
    });
    await new Promise((r) => setTimeout(r, 30));
    win.post({ type: "create-folder", name: "Sprint" });
    await new Promise((r) => setTimeout(r, 30));
    const snapshot = lastSnapshotPayload(win) as {
      projects: { prefix: string }[];
      folders: { name: string }[];
    };
    expect(snapshot.projects.some((p) => p.prefix === "PROD")).toBe(true);
    expect(snapshot.folders.some((f) => f.name === "Sprint")).toBe(true);
  });

  it("duplicate project prefix broadcasts an error", async () => {
    const { win } = await setup();
    win.post({
      type: "create-project",
      name: "A",
      prefix: "PROD",
      color: "#111111",
    });
    await new Promise((r) => setTimeout(r, 30));
    win.post({
      type: "create-project",
      name: "B",
      prefix: "PROD",
      color: "#222222",
    });
    await new Promise((r) => setTimeout(r, 30));
    const last = win.sent[win.sent.length - 1];
    expect(last).toContain("tasks:error");
    expect(last).toContain("prefix");
  });

  it("comment appends a user comment", async () => {
    const { win, dbPath } = await setup();
    await writeDb(dbPath, seedForTest());
    win.post({ type: "comment", taskKey: "TASK-1", body: "你好" });
    await new Promise((r) => setTimeout(r, 30));
    const snapshot = lastSnapshotPayload(win) as {
      comments: { taskId: string; body: string; kind: string }[];
    };
    expect(
      snapshot.comments.some((c) => c.body === "你好" && c.kind === "user"),
    ).toBe(true);
  });

  it("reclaim moves a delegated task back to todo and clears delegation", async () => {
    const { win, dbPath } = await setup();
    const seeded = seedForTest();
    const task = seeded.tasks[0];
    seeded.tasks = seeded.tasks.map((t) =>
      t.id === task.id
        ? {
            ...t,
            status: "in_progress",
            delegation: { agentId: "a", startedAt: new Date().toISOString() },
          }
        : t,
    );
    await writeDb(dbPath, seeded);
    win.post({ type: "reclaim", taskKey: "TASK-1" });
    await new Promise((r) => setTimeout(r, 30));
    const snapshot = lastSnapshotPayload(win) as {
      tasks: { key: string; status: string; delegation: unknown }[];
    };
    const t = snapshot.tasks.find((x) => x.key === "TASK-1");
    expect(t?.status).toBe("todo");
    expect(t?.delegation).toBeNull();
  });

  it("board-move changes status group", async () => {
    const { win, dbPath } = await setup();
    await writeDb(dbPath, seedForTest());
    win.post({ type: "board-move", taskKey: "TASK-1", status: "done" });
    await new Promise((r) => setTimeout(r, 30));
    const snapshot = lastSnapshotPayload(win) as {
      tasks: { key: string; status: string }[];
    };
    expect(snapshot.tasks.find((t) => t.key === "TASK-1")?.status).toBe("done");
  });

  it("deletes a backlog task and its comments", async () => {
    const { win, dbPath } = await setup();
    const seeded = seedForTest();
    seeded.tasks[0] = { ...seeded.tasks[0], status: "backlog" };
    seeded.comments.push({
      id: "comment-delete",
      taskId: seeded.tasks[0].id,
      kind: "user",
      authorName: "You",
      body: "Delete me too",
      createdAt: new Date().toISOString(),
    });
    await writeDb(dbPath, seeded);
    win.post({ type: "delete-task", taskKey: "TASK-1" });
    await new Promise((r) => setTimeout(r, 30));
    const snapshot = lastSnapshotPayload(win) as {
      tasks: { key: string }[];
      comments: { taskId: string }[];
    };
    expect(snapshot.tasks.some((task) => task.key === "TASK-1")).toBe(false);
    expect(
      snapshot.comments.some(
        (comment) => comment.taskId === seeded.tasks[0].id,
      ),
    ).toBe(false);
  });

  it("rejects deletion of a non-backlog task", async () => {
    const { win, dbPath } = await setup();
    const seeded = seedForTest();
    seeded.tasks[0] = { ...seeded.tasks[0], status: "todo" };
    await writeDb(dbPath, seeded);
    win.post({ type: "delete-task", taskKey: "TASK-1" });
    await new Promise((r) => setTimeout(r, 30));
    const last = win.sent[win.sent.length - 1];
    expect(last).toContain("tasks:error");
    expect(last).toContain("仅可删除未委托的 Backlog");
  });

  it("update-project renames and recolors", async () => {
    const { win, dbPath } = await setup();
    await writeDb(dbPath, seedForTest());
    win.post({
      type: "update-project",
      projectId: "p1",
      name: "新名字",
      color: "#22c55e",
    });
    await new Promise((r) => setTimeout(r, 30));
    const snapshot = lastSnapshotPayload(win) as {
      projects: { id: string; name: string; color: string; prefix: string }[];
    };
    const project = snapshot.projects.find((p) => p.id === "p1");
    expect(project?.name).toBe("新名字");
    expect(project?.color).toBe("#22c55e");
    expect(project?.prefix).toBe("TASK");
  });

  it("delete-project removes the project with its tasks and comments", async () => {
    const { win, dbPath } = await setup();
    const seeded = seedForTest();
    seeded.comments.push({
      id: "c1",
      taskId: "t1",
      kind: "user",
      authorName: "You",
      body: "hi",
      createdAt: new Date().toISOString(),
    });
    await writeDb(dbPath, seeded);
    win.post({ type: "delete-project", projectId: "p1" });
    await new Promise((r) => setTimeout(r, 30));
    const snapshot = lastSnapshotPayload(win) as {
      projects: { id: string }[];
      tasks: { id: string }[];
      comments: { id: string }[];
    };
    expect(snapshot.projects.some((p) => p.id === "p1")).toBe(false);
    expect(snapshot.tasks.some((t) => t.id === "t1")).toBe(false);
    expect(snapshot.comments.some((c) => c.id === "c1")).toBe(false);
  });

  it("delegate with unknown task broadcasts an error", async () => {
    const { win } = await setup();
    win.post({ type: "delegate", taskKey: "NOPE-9", worktree: true });
    await new Promise((r) => setTimeout(r, 30));
    const last = win.sent[win.sent.length - 1];
    expect(last).toContain("tasks:error");
  });

  it("unparseable messages are ignored", async () => {
    const { win } = await setup();
    win.post({ type: "not-a-thing" });
    win.post("garbage");
    win.post(null);
    await new Promise((r) => setTimeout(r, 20));
    expect(win.sent.length).toBe(0);
  });

  it("fs.watch: cross-session write (atomic rename) broadcasts a snapshot", async () => {
    const { win, dbPath, ctx } = await setup();
    // Register the watcher; simulate another session (e.g. a herdr child
    // agent) writing the db through the same atomic-write path.
    const { startDbWatcher } = await import("./ui-bridge.ts");
    startDbWatcher(ctx);
    await writeDb(dbPath, seedForTest());
    await new Promise((r) => setTimeout(r, 400));
    expect(win.sent.length).toBeGreaterThan(0);
    const snapshot = lastSnapshotPayload(win) as { tasks: { key: string }[] };
    expect(snapshot.tasks.some((t) => t.key === "TASK-1")).toBe(true);
  });
});

describe("createTasksHtml (ui-dist inlining)", () => {
  it("inlines script and style and injects boot data", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tasks-uihtml-"));
    tmpDirs.push(dir);
    const assets = path.join(dir, "assets");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(assets, { recursive: true }),
    );
    await writeFile(
      path.join(dir, "index.html"),
      '<!doctype html><html><head><link rel="stylesheet" href="./assets/app.css"></head><body><div id="app"></div><script type="module" crossorigin src="./assets/app.js"></script></body></html>',
    );
    await writeFile(path.join(assets, "app.css"), "body { color: red }");
    await writeFile(
      path.join(assets, "app.js"),
      "console.log('</script> hi');",
    );

    const html = await createTasksHtml({
      bootData: { projectRoot: "/tmp/x" },
      uiDistDir: dir,
    });
    expect(html).toContain("body { color: red }");
    expect(html).toContain("console.log('<\\/script> hi')");
    expect(html).toContain('window.__TASKS_BOOT__ = {"projectRoot":"/tmp/x"}');
    expect(html).not.toContain('src="./assets/');
  });
});

// Re-export a small seed for bridge tests (kept out of production code).
function seedForTest() {
  const db = emptyDb();
  const project = {
    id: "p1",
    name: "Test",
    prefix: "TASK",
    nextTaskNumber: 2,
    color: "#6366f1",
    folderId: null,
    createdAt: new Date().toISOString(),
  };
  db.projects.push(project);
  db.tasks.push({
    id: "t1",
    projectId: "p1",
    number: 1,
    key: "TASK-1",
    title: "First task",
    description: "",
    status: "todo",
    priority: "medium",
    dueDate: null,
    parentTaskId: null,
    position: 0,
    labelIds: [],
    delegation: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return db;
}
