import { describe, expect, it, vi } from "vitest";

import { type ManagedPty, PtySessionManager } from "./pty-session-manager";

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
      for (const listener of [...dataListeners]) {
        listener(data);
      }
    },
    emitExit(exitCode: number | null) {
      for (const listener of [...exitListeners]) {
        listener({ exitCode, signal: null });
      }
    },
  };
}

describe("PtySessionManager", () => {
  it("starts a shell, emits buffered output, and injects the initial command", async () => {
    const fake = createFakeShell();
    const onSessionExit = vi.fn();
    const manager = new PtySessionManager({
      createShell: () => fake.shell,
      now: (() => {
        let value = 0;
        return () => `2026-04-22T00:00:${String(value++).padStart(2, "0")}Z`;
      })(),
      onSessionExit,
    });
    const events: Array<{ type: string; chunk?: string }> = [];

    const unsubscribe = manager.subscribe("req-1", (event) => {
      if (event.type === "ready") {
        events.push({ type: event.type });
      }
      if (event.type === "chunk") {
        events.push({ type: event.type, chunk: event.chunk });
      }
    });

    const startPromise = manager.startSession({
      requirementId: "req-1",
      sessionId: "session-1",
      cwd: "/repo/demo",
      command: 'pi "hello"',
    });
    await Promise.resolve();
    fake.emitData("$ ");
    await startPromise;
    fake.emitData("ready\r\n");

    expect(fake.writes).toEqual(['pi "hello"\r']);
    expect(events).toEqual([
      { type: "ready" },
      { type: "chunk", chunk: "$ " },
      { type: "chunk", chunk: "ready\r\n" },
    ]);
    expect(manager.getSnapshot("req-1")).toMatchObject({
      status: "live",
      shellAlive: true,
      writable: true,
    });
    expect(onSessionExit).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("writes raw input and marks sessions exited when the shell ends", async () => {
    const fake = createFakeShell();
    const onSessionExit = vi.fn();
    const manager = new PtySessionManager({
      createShell: () => fake.shell,
      now: (() => {
        let value = 0;
        return () => `2026-04-22T00:00:${String(value++).padStart(2, "0")}Z`;
      })(),
      onSessionExit,
    });

    const startPromise = manager.startSession({
      requirementId: "req-2",
      sessionId: "session-2",
      cwd: "/repo/demo",
      command: 'pi "hello"',
    });
    await Promise.resolve();
    fake.emitData("$ ");
    await startPromise;

    await manager.sendInput("req-2", "continue\r");
    fake.emitExit(0);

    expect(fake.writes).toEqual(['pi "hello"\r', "continue\r"]);
    expect(manager.getSnapshot("req-2")).toMatchObject({
      status: "exited",
      shellAlive: false,
      writable: false,
      lastExitCode: 0,
    });
    expect(onSessionExit).toHaveBeenCalledWith(
      expect.objectContaining({
        requirementId: "req-2",
        sessionId: "session-2",
        reason: "shell-exit",
        exitCode: 0,
      }),
    );
  });
});
