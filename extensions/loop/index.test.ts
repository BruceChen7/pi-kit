import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import loop, { formatLoopStatus, runPredicate } from "./index.js";
import { LOOP_ENTRY, LOOP_TURN_TYPE, type LoopState } from "./state.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

type TestCtx = {
  cwd: string;
  ui: { notify: ReturnType<typeof vi.fn> };
  sessionManager: { getBranch: () => unknown[] };
};

const makeRepo = (dirty = false): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-loop-"));
  tempDirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "a.txt"), "clean\n");
  git("add", ".");
  git("commit", "-qm", "init");
  if (dirty) {
    fs.writeFileSync(path.join(dir, "a.txt"), "dirty\n");
  }
  return dir;
};

const build = (branch: unknown[] = [], cwd = "/tmp") => {
  const handlers = new Map<
    string,
    Array<(event: unknown, ctx: TestCtx) => unknown>
  >();
  const commands = new Map<string, (args: string, ctx: TestCtx) => unknown>();
  const entries: unknown[] = [];
  const sent: string[] = [];

  const pi = {
    on: (name: string, handler: (event: unknown, ctx: TestCtx) => unknown) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand: (
      name: string,
      registration: { handler: (args: string, ctx: TestCtx) => unknown },
    ) => {
      commands.set(name, registration.handler);
    },
    appendEntry: (_customType: string, data: LoopState) => {
      entries.push({ type: "custom", customType: LOOP_ENTRY, data });
    },
    sendUserMessage: (text: string) => {
      sent.push(text);
    },
  };

  loop(pi as unknown as ExtensionAPI);

  const ctx: TestCtx = {
    cwd,
    ui: { notify: vi.fn() },
    sessionManager: { getBranch: () => [...branch, ...entries] },
  };

  const run = async (args: string) => {
    const handler = commands.get("loop");
    if (!handler) {
      throw new Error("loop command is not registered");
    }
    await handler(args, ctx);
  };

  const emit = async (event: string, payload: Record<string, unknown>) => {
    let result: unknown;
    for (const handler of handlers.get(event) ?? []) {
      result = await handler(payload, ctx);
    }
    return result;
  };

  return { run, emit, entries, sent, ctx };
};

const runningState = (overrides: Partial<LoopState> = {}): LoopState => ({
  version: 1,
  runId: "run-1",
  status: "running",
  goal: "make it pass",
  turn: 1,
  maxTurns: 2,
  until: null,
  allowDirty: true,
  startedAt: "T0",
  updatedAt: "T0",
  reason: "initial-run",
  lastPredicateResult: null,
  ...overrides,
});

const asEntry = (state: LoopState) => ({
  type: "custom",
  customType: LOOP_ENTRY,
  data: state,
});

describe("runPredicate", () => {
  it("maps exit codes and timeouts to a result", async () => {
    expect(
      await runPredicate({ command: "true", timeoutSec: 5 }, "/tmp"),
    ).toEqual({
      exitCode: 0,
    });
    expect(
      await runPredicate({ command: "exit 3", timeoutSec: 5 }, "/tmp"),
    ).toEqual({
      exitCode: 3,
    });
    const timedOut = await runPredicate(
      { command: "sleep 5", timeoutSec: 1 },
      "/tmp",
    );
    expect(timedOut.timedOut).toBe(true);
  }, 15_000);
});

describe("formatLoopStatus", () => {
  it("says so when there is no run", () => {
    expect(formatLoopStatus(null)).toContain("no run");
  });

  it("reports status, budget, predicate and last exit", () => {
    const text = formatLoopStatus(
      runningState({
        until: { command: "npm test", timeoutSec: 30 },
        lastPredicateResult: { exitCode: 1 },
      }),
    );
    expect(text).toContain("running turn 1/2");
    expect(text).toContain("until=`npm test`");
    expect(text).toContain("last-exit=1");
  });
});

describe("/loop command", () => {
  it("reports status with no run", async () => {
    const { run, ctx } = build();
    await run("status");
    expect(ctx.ui.notify.mock.calls[0]?.[0]).toContain("no run");
  });

  it("starts a run, persists it, and sends the first turn", async () => {
    const repo = makeRepo();
    const { run, entries, sent } = build([], repo);
    await run('run --max-turns 2 --until "true" make it pass');

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      customType: LOOP_ENTRY,
      data: { status: "running", goal: "make it pass", maxTurns: 2 },
    });
    expect(sent[0]).toContain("[loop turn 1/2]");
    expect(sent[0]).toContain("make it pass");
  });

  it("refuses a dirty workspace unless asked", async () => {
    const repo = makeRepo(true);
    const { run, entries, ctx } = build([], repo);

    await run("run tidy the docs");
    expect(entries).toEqual([]);
    expect(ctx.ui.notify.mock.calls[0]?.[0]).toContain("uncommitted change");

    await run("run --allow-dirty tidy the docs");
    expect(entries).toHaveLength(1);
  });

  it("stops and reports an unusable argument list", async () => {
    const { run, ctx } = build();
    await run("run --nope goal");
    expect(ctx.ui.notify.mock.calls[0]?.[1]).toBe("error");
  });

  it("stops a running loop", async () => {
    const { run, entries } = build([asEntry(runningState())]);
    await run("stop");
    expect(entries.at(-1)).toMatchObject({
      data: { status: "stopped", reason: "operator-stopped" },
    });
  });
});

describe("agent_before_settle", () => {
  it("ignores a session with no loop", async () => {
    const { emit } = build();
    expect(await emit("agent_before_settle", { outcome: "completed" })).toEqual(
      {},
    );
  });

  it("completes when the predicate passes", async () => {
    const state = runningState({ until: { command: "true", timeoutSec: 5 } });
    const { emit, entries } = build([asEntry(state)]);
    const result = await emit("agent_before_settle", { outcome: "completed" });

    expect(result).toEqual({});
    expect(entries.at(-1)).toMatchObject({
      data: { status: "completed", reason: "predicate-satisfied" },
    });
  });

  it("stops at the budget when the predicate keeps failing", async () => {
    const state = runningState({
      turn: 2,
      maxTurns: 2,
      until: { command: "false", timeoutSec: 5 },
    });
    const { emit, entries } = build([asEntry(state)]);
    const result = await emit("agent_before_settle", { outcome: "completed" });

    expect(result).toEqual({});
    expect(entries.at(-1)).toMatchObject({
      data: { status: "stopped", reason: "budget-exhausted" },
    });
  });

  it("asks for one more turn with a custom message", async () => {
    const state = runningState({
      turn: 1,
      maxTurns: 3,
      until: { command: "false", timeoutSec: 5 },
    });
    const { emit, entries } = build([asEntry(state)]);
    const result = (await emit("agent_before_settle", {
      outcome: "completed",
    })) as {
      continue: boolean;
      entries: Array<{ customType: string; content: string }>;
    };

    expect(result.continue).toBe(true);
    expect(result.entries[0]?.customType).toBe(LOOP_TURN_TYPE);
    expect(result.entries[0]?.content).toContain("[loop turn 2/3]");
    expect(entries.at(-1)).toMatchObject({ data: { turn: 2 } });
  });

  it("does not run the predicate after an abort", async () => {
    const state = runningState({ until: { command: "exit 9", timeoutSec: 5 } });
    const { emit, entries } = build([asEntry(state)]);
    await emit("agent_before_settle", { outcome: "aborted" });

    expect(entries.at(-1)).toMatchObject({
      data: { status: "stopped", reason: "operator-aborted" },
    });
  });
});

describe("agent_settled", () => {
  it("marks a running loop interrupted after an abort", async () => {
    const { emit, entries } = build([asEntry(runningState())]);
    await emit("agent_settled", { aborted: true });
    expect(entries.at(-1)).toMatchObject({
      data: { status: "interrupted", reason: "operator-aborted" },
    });
  });

  it("leaves a non-aborted settle alone", async () => {
    const { emit, entries } = build([asEntry(runningState())]);
    await emit("agent_settled", { aborted: false });
    expect(entries).toEqual([]);
  });
});
