import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ManagedPty } from "./pty-session-manager";
import { RequirementService } from "./requirement-service";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const candidate = tempPaths.pop();
    if (candidate) {
      fs.rmSync(path.dirname(candidate), {
        recursive: true,
        force: true,
      });
    }
  }
});

function createFakeShell() {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<
    (event: { exitCode: number | null; signal: number | null }) => void
  >();
  const writes: string[] = [];

  const shell: ManagedPty = {
    pid: 42,
    write(data: string) {
      writes.push(data);
    },
    kill() {
      for (const listener of exitListeners) {
        listener({ exitCode: 0, signal: null });
      }
    },
    onData(listener) {
      dataListeners.add(listener);
      return () => {
        dataListeners.delete(listener);
      };
    },
    onExit(listener) {
      exitListeners.add(listener);
      return () => {
        exitListeners.delete(listener);
      };
    },
  };

  return {
    shell,
    writes,
    emitData(data: string) {
      for (const listener of dataListeners) {
        listener(data);
      }
    },
    emitExit(exitCode: number | null) {
      for (const listener of exitListeners) {
        listener({ exitCode, signal: null });
      }
    },
  };
}

function createService(
  fakeShell?: ReturnType<typeof createFakeShell>,
): RequirementService {
  const statePath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "kanban-requirements-")),
    "state.json",
  );
  tempPaths.push(statePath);
  return new RequirementService({
    repoRoot: "/repo/demo",
    workspaceId: "demo",
    statePath,
    now: (() => {
      let value = 0;
      return () => `2026-04-21T00:00:${String(value++).padStart(2, "0")}Z`;
    })(),
    createId: (() => {
      let value = 0;
      return () => `id-${++value}`;
    })(),
    createShell: fakeShell ? () => fakeShell.shell : undefined,
  });
}

describe("RequirementService", () => {
  it("returns empty-create mode when there are no unfinished requirements", () => {
    const service = createService();

    expect(service.getHome()).toEqual({
      mode: "empty-create",
      hasUnfinishedRequirements: false,
      lastViewedProjectId: null,
      recentProjects: [],
      projectGroups: [],
    });
  });

  it("creates requirements and groups them by project", () => {
    const service = createService();

    const detail = service.createRequirement({
      title: "Redesign kanban",
      prompt: "Build the new homepage",
      projectName: "pi-kit",
      projectPath: "/repo/demo",
    });

    expect(detail.requirement.boardStatus).toBe("inbox");
    expect(detail.terminal.status).toBe("idle");

    const home = service.getHome();
    expect(home.mode).toBe("project-board");
    expect(home.projectGroups).toHaveLength(1);
    expect(home.projectGroups[0]?.inbox[0]?.title).toBe("Redesign kanban");
    expect(home.projectGroups[0]?.done).toEqual([]);
  });

  it("starts real shell sessions, sends raw input, and updates board status", async () => {
    const fakeShell = createFakeShell();
    const service = createService(fakeShell);
    const created = service.createRequirement({
      title: "Prototype session",
      prompt: "Simulate pi prompt",
      projectPath: "/repo/demo",
    });

    const startPromise = service.startRequirement({
      requirementId: created.requirement.id,
      command: 'pi "Simulate pi prompt"',
    });
    fakeShell.emitData("$ ");
    const running = await startPromise;

    expect(running.requirement.boardStatus).toBe("in_progress");
    expect(running.activeSession?.status).toBe("live");
    expect(running.terminal.status).toBe("live");
    expect(fakeShell.writes).toEqual(['pi "Simulate pi prompt"\r']);

    expect(
      await service.sendTerminalInput(created.requirement.id, "continue\r"),
    ).toEqual({
      accepted: true,
      mode: "raw",
    });
    expect(fakeShell.writes).toEqual([
      'pi "Simulate pi prompt"\r',
      "continue\r",
    ]);

    const done = service.updateBoardStatus({
      requirementId: created.requirement.id,
      boardStatus: "done",
    });
    expect(done.requirement.boardStatus).toBe("done");
  });

  it("marks active sessions killed when the shell exits during restart", async () => {
    const firstShell = createFakeShell();
    const secondShell = createFakeShell();
    const shells = [firstShell, secondShell];
    let index = 0;

    const statePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "kanban-requirements-")),
      "state.json",
    );
    tempPaths.push(statePath);
    const service = new RequirementService({
      repoRoot: "/repo/demo",
      workspaceId: "demo",
      statePath,
      now: (() => {
        let value = 0;
        return () => `2026-04-21T00:00:${String(value++).padStart(2, "0")}Z`;
      })(),
      createId: (() => {
        let value = 0;
        return () => `id-${++value}`;
      })(),
      createShell: () => {
        const shell = shells[index++];
        if (!shell) {
          throw new Error("missing fake shell");
        }
        return shell.shell;
      },
    });

    const created = service.createRequirement({
      title: "Restartable session",
      prompt: "Restart me",
      projectPath: "/repo/demo",
    });

    const firstStart = service.startRequirement({
      requirementId: created.requirement.id,
      command: 'pi "Restart me"',
    });
    firstShell.emitData("$ ");
    await firstStart;

    const restart = service.restartRequirement({
      requirementId: created.requirement.id,
      command: 'pi "Restart me again"',
    });
    secondShell.emitData("$ ");
    const restarted = await restart;

    expect(restarted.activeSession?.id).toBe("id-4");
    expect(restarted.activeSession?.status).toBe("live");

    const detail = service.getRequirementDetail(created.requirement.id);
    expect(detail.activeSession?.id).toBe("id-4");
    expect(detail.activeSession?.status).toBe("live");
  });
});
