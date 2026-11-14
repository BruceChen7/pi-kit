import { describe, expect, it } from "vitest";
import type { SubagentRun } from "./core.ts";
import {
  openAgents,
  STATE_BY_STATUS,
  sameSnapshot,
  snapshotOf,
} from "./state-snapshot.ts";

const run = (over: Partial<SubagentRun> = {}): SubagentRun => ({
  runId: "run-1",
  agent: "explore",
  task: "count dirs",
  status: "running",
  startedAt: 100,
  step: "grep",
  lastEventAt: 900,
  transcript: [],
  background: true,
  ...over,
});

describe("snapshotOf", () => {
  it("maps every internal status to the coarser public one", () => {
    expect(STATE_BY_STATUS).toEqual({
      queued: "waiting",
      running: "working",
      done: "idle",
      failed: "failed",
      stopped: "skipped",
      intermediate: "interrupted",
    });
  });

  it("carries metadata only", () => {
    const snapshot = snapshotOf([run({ resultText: "3 directories" })]);

    expect(snapshot.entries[0]).toEqual({
      id: "run-1",
      name: "explore",
      state: "working",
      closed: false,
    });
    expect(JSON.stringify(snapshot)).not.toContain("count dirs");
    expect(JSON.stringify(snapshot)).not.toContain("3 directories");
  });

  it("marks settled runs as closed", () => {
    const snapshot = snapshotOf([run({ status: "done" })]);

    expect(snapshot.entries[0]?.closed).toBe(true);
  });

  it("sorts by id and reports emptiness explicitly", () => {
    expect(snapshotOf([])).toEqual({
      kind: "snapshot",
      empty: true,
      entries: [],
    });
    expect(
      snapshotOf([run({ runId: "b" }), run({ runId: "a" })]).entries.map(
        (entry) => entry.id,
      ),
    ).toEqual(["a", "b"]);
  });

  it("is a full replacement: the same runs always render the same snapshot", () => {
    expect(snapshotOf([run()])).toEqual(snapshotOf([run()]));
  });
});

describe("sameSnapshot / openAgents", () => {
  it("detects unchanged snapshots", () => {
    const first = snapshotOf([run()]);

    expect(sameSnapshot(first, snapshotOf([run()]))).toBe(true);
    expect(sameSnapshot(first, snapshotOf([run({ status: "done" })]))).toBe(
      false,
    );
    expect(sameSnapshot(undefined, first)).toBe(false);
  });

  it("lists the agents that are not closed yet", () => {
    const snapshot = snapshotOf([
      run({ runId: "a", status: "running" }),
      run({ runId: "b", status: "done" }),
      run({ runId: "c", status: "queued" }),
    ]);

    expect(openAgents(snapshot).map((entry) => entry.id)).toEqual(["a", "c"]);
  });
});
