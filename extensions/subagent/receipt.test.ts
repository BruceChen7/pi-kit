import { describe, expect, it } from "vitest";
import type { SubagentRun } from "./core.ts";
import { observeRun, observeRuns, RECEIPT_VERSION } from "./receipt.ts";

const run = (over: Partial<SubagentRun> = {}): SubagentRun => ({
  runId: "run-1",
  agent: "explore",
  task: "count dirs",
  status: "running",
  startedAt: 100,
  step: "grep",
  lastEventAt: 900,
  transcript: [{ role: "tool", text: "read a.ts", at: 500 }],
  background: true,
  ...over,
});

describe("observeRun", () => {
  it("keeps the identity and the observation", () => {
    expect(observeRun(run())).toEqual({
      runId: "run-1",
      agent: "explore",
      status: "running",
      background: true,
      taskChars: "count dirs".length,
      startedAt: 100,
    });
  });

  it("records sizes, never the task or result text", () => {
    const receipt = observeRun(run({ status: "done", resultText: "3 dirs" }));

    expect(receipt.resultChars).toBe("3 dirs".length);
    expect(JSON.stringify(receipt)).not.toContain("3 dirs");
    expect(JSON.stringify(receipt)).not.toContain("count dirs");
  });

  it("leaves out fields that change while the run lives", () => {
    const receipt = observeRun(run());
    const keys = Object.keys(receipt);

    expect(keys).not.toContain("step");
    expect(keys).not.toContain("lastEventAt");
    expect(keys).not.toContain("transcript");
    expect(keys).not.toContain("error");
    expect(keys).not.toContain("resultText");
  });

  it("includes endedAt once the run is settled", () => {
    expect(observeRun(run({ status: "done", endedAt: 700 })).endedAt).toBe(700);
  });
});

describe("observeRuns", () => {
  it("stamps the receipt version", () => {
    expect(observeRuns([run()]).version).toBe(RECEIPT_VERSION);
  });

  it("sorts by runId so the same input always renders the same", () => {
    const receipt = observeRuns([
      run({ runId: "run-9" }),
      run({ runId: "run-2" }),
    ]);

    expect(receipt.runs.map((entry) => entry.runId)).toEqual([
      "run-2",
      "run-9",
    ]);
  });

  it("handles an empty observation", () => {
    expect(observeRuns([])).toEqual({ version: RECEIPT_VERSION, runs: [] });
  });
});
