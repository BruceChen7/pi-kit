/**
 * Tasks delegation — orchestration tests with a mocked herdr CLI.
 *
 * Covers runDelegation (tab + worktree modes) and removeWorktree against
 * the real herdr response shapes (result.tab / result.root_pane /
 * open_workspace_id), so response-parsing regressions are caught without a
 * live herdr server.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "./contract.ts";
import { removeWorktree, runDelegation } from "./delegate.ts";
import { createProject, createTask, emptyDb } from "./store.ts";

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const TAB_CREATE_RESPONSE = JSON.stringify({
  id: "cli:tab:create",
  result: {
    root_pane: {
      pane_id: "wA:p1",
      tab_id: "wA:t1",
      workspace_id: "wA",
    },
    tab: { tab_id: "wA:t1", workspace_id: "wA", label: "TASK-1 · T" },
  },
  type: "tab_created",
});

const WORKTREE_CREATE_RESPONSE = JSON.stringify({
  id: "cli:worktree:create",
  result: {
    workspace: { id: "wB" },
    tab: { tab_id: "wB:t2", workspace_id: "wB" },
    root_pane: { pane_id: "wB:p2", tab_id: "wB:t2", workspace_id: "wB" },
    worktree: { path: "/tmp/x/repo.task-1", branch: "task/task-1-x" },
  },
  type: "worktree_created",
});

const PANE_LIST_RESPONSE = JSON.stringify({
  id: "cli:pane:list",
  result: {
    panes: [
      { pane_id: "wA:p1", tab_id: "wA:t1", workspace_id: "wA" },
      { pane_id: "wA:pOther", tab_id: "wA:tOther", workspace_id: "wA" },
    ],
  },
  type: "pane_list",
});

const WORKTREE_LIST_RESPONSE = JSON.stringify({
  id: "cli:worktree:list",
  result: {
    source: { repo_root: "/tmp/x" },
    worktrees: [
      {
        path: "/tmp/x/repo.task-1",
        branch: "task/task-1-x",
        open_workspace_id: "wB",
      },
    ],
  },
  type: "worktree_list",
});

type ExecResult = { code: number; stdout: string; stderr?: string };

function makeDb() {
  let db = emptyDb();
  const { db: db1, project } = createProject(db, {
    name: "repo",
    prefix: "TASK",
    color: "#6366f1",
    folderId: null,
  });
  db = db1;
  const { db: db2, task } = createTask(db, {
    projectId: project.id,
    title: "Implement board",
  });
  return { db: db2, project, task };
}

/** Route herdr calls to canned responses by subcommand. */
function routeExec(routes: Record<string, () => ExecResult>): ExtensionAPI {
  const exec = vi.fn(async (_cmd: string, args: string[]) => {
    const key = args.slice(0, 2).join(" ");
    const handler = routes[key] ?? routes[args[0] ?? ""];
    if (!handler) {
      return { code: 1, stdout: "", stderr: `no route for: ${args.join(" ")}` };
    }
    return handler();
  });
  return { exec } as unknown as ExtensionAPI;
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout });
const fail = (stderr: string): ExecResult => ({ code: 1, stdout: "", stderr });

/* ------------------------------------------------------------------ */
/*  runDelegation — tab mode                                           */
/* ------------------------------------------------------------------ */

describe("runDelegation (tab mode)", () => {
  let envBackup: string | undefined;

  beforeEach(() => {
    envBackup = process.env.HERDR_WORKTREE_DIR;
    delete process.env.HERDR_WORKTREE_DIR;
  });
  afterEach(() => {
    if (envBackup === undefined) delete process.env.HERDR_WORKTREE_DIR;
    else process.env.HERDR_WORKTREE_DIR = envBackup;
  });

  it("creates a tab, resolves the pane, renames, and spawns pi", async () => {
    const { db, task } = makeDb();
    const calls: string[][] = [];
    const pi = routeExec({
      "tab create": () => ok(TAB_CREATE_RESPONSE),
      "pane list": () => ok(PANE_LIST_RESPONSE),
      "pane rename": () => ok("{}"),
      "pane run": () => ok(""),
    });
    // Capture args through the mock.
    (pi.exec as ReturnType<typeof vi.fn>).mockImplementation(
      async (_cmd: string, args: string[]) => {
        calls.push(args);
        const key = args.slice(0, 2).join(" ");
        const routes: Record<string, ExecResult> = {
          "tab create": ok(TAB_CREATE_RESPONSE),
          "pane list": ok(PANE_LIST_RESPONSE),
          "pane rename": ok("{}"),
          "pane run": ok(""),
        };
        return routes[key] ?? fail(`no route: ${args.join(" ")}`);
      },
    );

    const result = await runDelegation(pi, db, task, {
      projectRoot: "/tmp/x/repo",
    });

    expect(result.tabId).toBe("wA:t1");
    expect(result.workspaceId).toBe("wA");
    expect(result.paneId).toBe("wA:p1");
    expect(result.agentLabel).toBe("TASK-1 · Implement board");
    // tab create with label + env
    expect(calls[0]).toContain("tab");
    expect(calls[0]).toContain("create");
    expect(calls[0]).toContain("TASK-1 · Implement board");
    // rename target pane
    expect(calls[2][2]).toBe("wA:p1");
    // spawn command references the prompt file and pi
    const runArgs = calls[3];
    expect(runArgs[3]).toContain("pi");
    expect(runArgs[3]).toContain("--name");
    expect(runArgs[3]).toContain("@");
  });

  it("throws No pane found when pane list lacks the tab", async () => {
    const { db, task } = makeDb();
    const pi = routeExec({
      "tab create": () => ok(TAB_CREATE_RESPONSE),
      "pane list": () => ok(JSON.stringify({ result: { panes: [] } })),
    });
    await expect(
      runDelegation(pi, db, task, { projectRoot: "/tmp/x/repo" }),
    ).rejects.toThrow("No pane found for tab wA:t1");
  });

  it("throws when tab create fails", async () => {
    const { db, task } = makeDb();
    const pi = routeExec({
      "tab create": () => fail("boom"),
    });
    await expect(
      runDelegation(pi, db, task, { projectRoot: "/tmp/x/repo" }),
    ).rejects.toThrow("boom");
  });

  it("throws when pane run fails", async () => {
    const { db, task } = makeDb();
    const pi = routeExec({
      "tab create": () => ok(TAB_CREATE_RESPONSE),
      "pane list": () => ok(PANE_LIST_RESPONSE),
      "pane rename": () => ok("{}"),
      "pane run": () => fail("spawn failed"),
    });
    await expect(
      runDelegation(pi, db, task, { projectRoot: "/tmp/x/repo" }),
    ).rejects.toThrow("spawn failed");
  });
});

/* ------------------------------------------------------------------ */
/*  runDelegation — worktree mode                                      */
/* ------------------------------------------------------------------ */

describe("runDelegation (worktree mode)", () => {
  it("creates the worktree first, then spawns in its tab", async () => {
    const { db, task } = makeDb();
    const calls: string[][] = [];
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "worktree create") return ok(WORKTREE_CREATE_RESPONSE);
      if (key === "pane list") {
        return ok(
          JSON.stringify({
            result: {
              panes: [
                { pane_id: "wB:p2", tab_id: "wB:t2", workspace_id: "wB" },
              ],
            },
          }),
        );
      }
      if (key === "pane rename") return ok("{}");
      if (key === "pane run") return ok("");
      return fail(`no route: ${args.join(" ")}`);
    });
    const pi = { exec } as unknown as ExtensionAPI;

    const result = await runDelegation(pi, db, task, {
      projectRoot: "/tmp/x/repo",
      worktree: true,
    });

    // Worktree created with branch + path + focus, in the source repo.
    const wt = calls[0];
    expect(wt[0]).toBe("worktree");
    expect(wt[1]).toBe("create");
    expect(wt).toContain("--branch");
    expect(wt).toContain("task/task-1-implement-board");
    expect(wt).toContain("--path");
    expect(wt[wt.indexOf("--path") + 1]).toMatch(/repo\.task-1$/);
    expect(wt).toContain("--focus");
    // Result carries worktree info from the delegation.
    expect(result.workspaceId).toBe("wB");
    expect(result.tabId).toBe("wB:t2");
    expect(result.branch).toBe("task/task-1-implement-board");
    expect(result.worktreePath).toMatch(/repo\.task-1$/);
    // No separate tab create in worktree mode.
    expect(calls.some((c) => c[0] === "tab" && c[1] === "create")).toBe(false);
  });

  it("throws when worktree create fails", async () => {
    const { db, task } = makeDb();
    const pi = routeExec({
      "worktree create": () => fail("no git repo"),
    });
    await expect(
      runDelegation(pi, db, task, {
        projectRoot: "/tmp/x/repo",
        worktree: true,
      }),
    ).rejects.toThrow("no git repo");
  });
});

/* ------------------------------------------------------------------ */
/*  removeWorktree                                                     */
/* ------------------------------------------------------------------ */

describe("removeWorktree", () => {
  const wtTask = (overrides: Partial<Task> = {}): Task => ({
    ...makeDb().task,
    delegation: {
      agentId: "TASK-1 · T",
      startedAt: "2026-08-07T00:00:00.000Z",
      worktreePath: "/tmp/x/repo.task-1",
      branch: "task/task-1-x",
      workspaceId: "wB",
    },
    ...overrides,
  });

  it("uses the recorded workspace id directly", async () => {
    const calls: string[][] = [];
    const pi = routeExec({});
    (pi.exec as ReturnType<typeof vi.fn>).mockImplementation(
      async (_cmd: string, args: string[]) => {
        calls.push(args);
        return { code: 0, stdout: "{}" };
      },
    );
    await removeWorktree(pi, wtTask());
    // Only the remove call; no list lookup needed.
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("worktree");
    expect(calls[0][1]).toBe("remove");
    expect(calls[0]).toContain("--workspace");
    expect(calls[0]).toContain("wB");
  });

  it("resolves workspace via worktree list when not recorded", async () => {
    const calls: string[][] = [];
    const pi = routeExec({});
    (pi.exec as ReturnType<typeof vi.fn>).mockImplementation(
      async (_cmd: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "worktree" && args[1] === "list") {
          return ok(WORKTREE_LIST_RESPONSE);
        }
        return ok("{}");
      },
    );
    const task = wtTask({
      delegation: {
        agentId: "a",
        startedAt: "t",
        worktreePath: "/tmp/x/repo.task-1",
      },
    });
    await removeWorktree(pi, task);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([
      "worktree",
      "list",
      "--cwd",
      "/tmp/x/repo.task-1",
    ]);
    expect(calls[1]).toContain("wB");
  });

  it("passes --force when requested", async () => {
    const calls: string[][] = [];
    const pi = routeExec({});
    (pi.exec as ReturnType<typeof vi.fn>).mockImplementation(
      async (_cmd: string, args: string[]) => {
        calls.push(args);
        return { code: 0, stdout: "{}" };
      },
    );
    await removeWorktree(pi, wtTask(), { force: true });
    expect(calls[0]).toContain("--force");
  });

  it("throws when the task has no worktree", async () => {
    const pi = routeExec({});
    await expect(
      removeWorktree(pi, wtTask({ delegation: null })),
    ).rejects.toThrow("has no worktree");
  });

  it("throws when the workspace cannot be resolved", async () => {
    const pi = routeExec({
      "worktree list": () => ok(JSON.stringify({ result: { worktrees: [] } })),
    });
    const task = wtTask({
      delegation: {
        agentId: "a",
        startedAt: "t",
        worktreePath: "/tmp/x/repo.task-1",
      },
    });
    await expect(removeWorktree(pi, task)).rejects.toThrow(
      "Could not resolve herdr workspace",
    );
  });

  it("throws when remove fails", async () => {
    const pi = routeExec({
      "worktree remove": () => fail("dirty worktree"),
    });
    await expect(removeWorktree(pi, wtTask())).rejects.toThrow(
      "dirty worktree",
    );
  });
});
