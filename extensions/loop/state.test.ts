import { describe, expect, it } from "vitest";
import {
  createInitialLoopState,
  decideNextStep,
  LOOP_ENTRY,
  type LoopState,
  loopFromBranch,
  renderLoopPrompt,
} from "./state.js";

const running = (overrides: Partial<LoopState> = {}): LoopState => ({
  ...createInitialLoopState({ goal: "make it pass", maxTurns: 3, now: "T0" }),
  ...overrides,
});

const NOW = "2026-10-23T00:00:00.000Z";

describe("createInitialLoopState", () => {
  it("starts running at turn 1 with the configured budget", () => {
    const state = createInitialLoopState({ goal: "g", maxTurns: 5, now: "T0" });
    expect(state).toMatchObject({
      version: 1,
      status: "running",
      goal: "g",
      turn: 1,
      maxTurns: 5,
      reason: "initial-run",
      lastPredicateResult: null,
    });
    expect(state.runId.length).toBeGreaterThan(8);
  });
});

describe("loopFromBranch", () => {
  const entry = (data: unknown) => ({
    type: "custom",
    customType: LOOP_ENTRY,
    data,
  });

  it("returns null when the branch has no loop", () => {
    expect(loopFromBranch([])).toBeNull();
  });

  it("takes the last state and skips malformed entries", () => {
    const first = createInitialLoopState({ goal: "a", now: "T0" });
    const second = { ...first, turn: 2 };
    expect(
      loopFromBranch([
        entry(first),
        { type: "message" },
        entry({ version: 1 }),
        entry(second),
      ])?.turn,
    ).toBe(2);
  });
});

describe("decideNextStep", () => {
  it("stops when the state is already terminal", () => {
    const state = running({ status: "completed" });
    expect(decideNextStep(state, null, { now: NOW })).toEqual({
      action: "stop",
      nextState: state,
    });
  });

  it("records an operator abort", () => {
    const decision = decideNextStep(running(), null, {
      outcome: "aborted",
      now: NOW,
    });
    expect(decision.nextState).toMatchObject({
      status: "stopped",
      reason: "operator-aborted",
    });
  });

  it("records a turn error", () => {
    const decision = decideNextStep(running(), null, {
      outcome: "error",
      now: NOW,
    });
    expect(decision.nextState).toMatchObject({
      status: "failed",
      reason: "turn-error",
    });
  });

  it("fails on a predicate timeout", () => {
    const decision = decideNextStep(
      running(),
      { exitCode: null, timedOut: true },
      { now: NOW },
    );
    expect(decision.nextState).toMatchObject({
      status: "failed",
      reason: "predicate-timeout",
    });
  });

  it("fails on a predicate that could not run", () => {
    for (const result of [
      { exitCode: null, error: "spawn failed" },
      { exitCode: 127 },
    ]) {
      expect(
        decideNextStep(running(), result, { now: NOW }).nextState,
      ).toMatchObject({
        status: "failed",
        reason: "predicate-error",
      });
    }
  });

  it("completes when the predicate passes", () => {
    const decision = decideNextStep(running(), { exitCode: 0 }, { now: NOW });
    expect(decision).toMatchObject({
      action: "stop",
      nextState: { status: "completed", reason: "predicate-satisfied" },
    });
  });

  it("keeps going while the predicate fails and budget remains", () => {
    const decision = decideNextStep(
      running({ turn: 1 }),
      { exitCode: 1 },
      { now: NOW },
    );
    expect(decision.action).toBe("continue");
    expect(decision.nextState.turn).toBe(2);
    expect(decision.nextState.lastPredicateResult).toEqual({ exitCode: 1 });
  });

  it("stops when the budget is exhausted", () => {
    const decision = decideNextStep(
      running({ turn: 3 }),
      { exitCode: 1 },
      { now: NOW },
    );
    expect(decision).toMatchObject({
      action: "stop",
      nextState: { status: "stopped", reason: "budget-exhausted" },
    });
  });

  it("advances even without a predicate", () => {
    expect(
      decideNextStep(running({ maxTurns: 2 }), null, { now: NOW }),
    ).toMatchObject({
      action: "continue",
      nextState: { turn: 2 },
    });
  });
});

describe("renderLoopPrompt", () => {
  it("carries goal, budget, predicate and the last exit code", () => {
    const state = running({ until: { command: "npm test", timeoutSec: 30 } });
    const text = renderLoopPrompt(state, 2, { exitCode: 1 });
    expect(text).toContain("[loop turn 2/3]");
    expect(text).toContain("Goal: make it pass");
    expect(text).toContain("`npm test`");
    expect(text).toContain("Last predicate exit code: 1");
    expect(text).toContain("Do not commit, push, or open a PR");
  });

  it("omits the predicate line when there is none", () => {
    const text = renderLoopPrompt(running(), 1);
    expect(text).not.toContain("Stop predicate");
    expect(text).not.toContain("Last predicate");
  });
});
