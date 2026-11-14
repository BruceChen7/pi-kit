import { describe, expect, it } from "vitest";
import {
  ledgerEntriesOf,
  RUN_LEDGER_ENTRY_TYPE,
  type RunLedgerEntry,
  renderUnsettled,
  toLedgerEntry,
  truncateTask,
  unsettledRuns,
} from "./ledger.ts";

const entry = (
  runId: string,
  event: RunLedgerEntry["event"],
  at: number,
  agent = "explore",
  task = "count dirs",
): RunLedgerEntry => ({ runId, event, agent, task, at });

const customEntry = (data: unknown) => ({
  type: "custom",
  customType: RUN_LEDGER_ENTRY_TYPE,
  data,
});

describe("truncateTask / toLedgerEntry", () => {
  it("keeps a short task as-is", () => {
    expect(truncateTask("count dirs")).toBe("count dirs");
  });

  it("truncates a long task and marks it", () => {
    const task = "x".repeat(200);
    const truncated = truncateTask(task, 20);

    expect(truncated).toHaveLength(20);
    expect(truncated.endsWith("…")).toBe(true);
  });

  it("stores the task摘要 and the result size, not the result text", () => {
    const built = toLedgerEntry({
      runId: "r1",
      event: "settled",
      agent: "explore",
      task: "count dirs",
      at: 5,
      resultChars: 120,
    });

    expect(built).toEqual({
      runId: "r1",
      event: "settled",
      agent: "explore",
      task: "count dirs",
      at: 5,
      resultChars: 120,
    });
    expect(JSON.stringify(built)).not.toContain("resultText");
  });
});

describe("ledgerEntriesOf", () => {
  it("keeps only this extension's entries", () => {
    const entries = ledgerEntriesOf([
      customEntry({
        runId: "r1",
        event: "start",
        agent: "explore",
        task: "t",
        at: 1,
      }),
      { type: "custom", customType: "something-else", data: {} },
      { type: "message", data: {} },
      "not an entry",
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.runId).toBe("r1");
  });

  it("drops entries with an unknown event or no runId", () => {
    expect(
      ledgerEntriesOf([
        customEntry({ runId: "r1", event: "exploded", at: 1 }),
        customEntry({ event: "start", at: 1 }),
        customEntry({ runId: "", event: "start", at: 1 }),
      ]),
    ).toEqual([]);
  });

  it("fills in defaults for missing agent/task/at", () => {
    expect(
      ledgerEntriesOf([customEntry({ runId: "r1", event: "start" })]),
    ).toEqual([
      { runId: "r1", event: "start", agent: "unknown", task: "", at: 0 },
    ]);
  });
});

describe("unsettledRuns", () => {
  it("lists a run that never closed", () => {
    expect(unsettledRuns([entry("r1", "start", 10)])).toEqual([
      { runId: "r1", agent: "explore", task: "count dirs", startedAt: 10 },
    ]);
  });

  it.each(["settled", "failed", "stopped"] as const)(
    "drops a run closed by %s",
    (event) => {
      expect(
        unsettledRuns([entry("r1", "start", 10), entry("r1", event, 20)]),
      ).toEqual([]);
    },
  );

  it("keeps a run that only reported an intermediate answer", () => {
    const [run] = unsettledRuns([
      entry("r1", "start", 10),
      entry("r1", "intermediate", 20),
    ]);

    expect(run).toMatchObject({ runId: "r1", lastIntermediateAt: 20 });
  });

  it("orders by start time and ignores unrelated runs", () => {
    const runs = unsettledRuns([
      entry("late", "start", 30),
      entry("early", "start", 10),
      entry("done", "start", 5),
      entry("done", "settled", 6),
    ]);

    expect(runs.map((run) => run.runId)).toEqual(["early", "late"]);
  });

  it("uses the last start for a reused run id", () => {
    const runs = unsettledRuns([
      entry("r1", "start", 10, "explore", "first try"),
      entry("r1", "settled", 11),
      entry("r1", "start", 20, "explore", "second try"),
    ]);

    expect(runs).toEqual([
      { runId: "r1", agent: "explore", task: "second try", startedAt: 20 },
    ]);
  });
});

describe("renderUnsettled", () => {
  it("says nothing when every run settled", () => {
    expect(renderUnsettled([])).toBe("");
  });

  it("names the runs, the missing session, and the two choices", () => {
    const text = renderUnsettled([
      { runId: "r1", agent: "explore", task: "count dirs", startedAt: 10 },
      {
        runId: "r2",
        agent: "reviewer",
        task: "review auth",
        startedAt: 20,
        lastIntermediateAt: 25,
      },
    ]);

    expect(text).toContain("2 subagent run(s)");
    expect(text).toContain("- r1 explore: count dirs");
    expect(text).toContain("中间回答");
    expect(text).toContain("Nothing was resumed");
  });
});
