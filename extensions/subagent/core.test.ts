import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { AgentProfile } from "./agents.js";
import {
  activeRuns,
  admit,
  appendTranscript,
  type Colorize,
  clipResult,
  collectWaitResult,
  createState,
  DEFAULT_MAX_CONCURRENT,
  eventToTranscriptLine,
  findRun,
  isTerminal,
  MAX_RESULT_CHARS,
  progressLine,
  renderDoctor,
  renderTranscript,
  renderWaitResult,
  renderWidgetLines,
  type SubagentState,
  selectWaitTargets,
  setStep,
  settle,
  start,
  statusLine,
  stop,
  summarizeTask,
  truncateToColumns,
  WIDGET_LINE_BUDGET,
} from "./core.js";

const runOf = (state: SubagentState, runId: string) => {
  const run = findRun(state, runId);
  if (!run) throw new Error(`missing run ${runId}`);
  return run;
};

const request = (runId: string, agent = "explore") => ({
  runId,
  agent,
  task: `task ${runId}`,
  background: true,
});

const admitMany = (ids: string[], max = DEFAULT_MAX_CONCURRENT) =>
  ids.reduce(
    (state, id) => admit(state, request(id), max, 1000).state,
    createState(),
  );

const profile = (over: Partial<AgentProfile> = {}): AgentProfile => ({
  name: "reviewer",
  description: "",
  tools: ["read", "grep"],
  promptMode: "append",
  prompt: "review",
  mcp: "inherit",
  source: "builtin",
  ...over,
});

describe("admit", () => {
  it("runs the first request immediately", () => {
    const { state, outcome } = admit(createState(), request("a1"), 4, 1000);

    expect(outcome).toBe("running");
    expect(findRun(state, "a1")?.status).toBe("running");
  });

  it("queues past the concurrency ceiling", () => {
    const state = admitMany(["a1", "a2", "a3", "a4"]);
    const { state: next, outcome } = admit(state, request("a5"), 4, 1000);

    expect(outcome).toBe("queued");
    expect(findRun(next, "a5")?.status).toBe("queued");
    expect(next.runs.filter((run) => run.status === "running")).toHaveLength(4);
    expect(activeRuns(next)).toHaveLength(5);
  });
});

describe("settle", () => {
  it("promotes the oldest queued run when a slot frees up", () => {
    const state = admitMany(["a1", "a2", "a3", "a4"]);
    const withQueued = admit(state, request("a5"), 4, 1000).state;

    const next = settle(
      withQueued,
      { runId: "a1", status: "done", resultText: "ok" },
      4,
      2000,
    );

    expect(findRun(next, "a1")?.status).toBe("done");
    expect(findRun(next, "a5")?.status).toBe("running");
  });

  it("is idempotent: a second settle does not overwrite the first", () => {
    const state = admit(createState(), request("a1"), 4, 1000).state;
    const done = settle(
      state,
      { runId: "a1", status: "done", resultText: "first" },
      4,
      2000,
    );
    const again = settle(
      done,
      { runId: "a1", status: "failed", error: "late" },
      4,
      9000,
    );

    expect(findRun(again, "a1")?.status).toBe("done");
    expect(findRun(again, "a1")?.resultText).toBe("first");
    expect(findRun(again, "a1")?.endedAt).toBe(2000);
  });

  it("ignores an unknown runId", () => {
    const state = admit(createState(), request("a1"), 4, 1000).state;

    expect(settle(state, { runId: "ghost", status: "done" }, 4, 2000)).toBe(
      state,
    );
  });

  it("clips an oversized result", () => {
    const state = admit(createState(), request("a1"), 4, 1000).state;
    const next = settle(
      state,
      {
        runId: "a1",
        status: "done",
        resultText: "x".repeat(MAX_RESULT_CHARS + 50),
      },
      4,
      2000,
    );

    expect(findRun(next, "a1")?.resultText).toContain("[truncated 50 chars]");
  });
});

describe("stop", () => {
  it("marks a running run stopped and frees a slot", () => {
    const state = admit(createState(), request("a1"), 1, 1000).state;
    const withQueued = admit(state, request("a2"), 1, 1000).state;

    const next = stop(withQueued, "a1", 1, 2000);

    expect(findRun(next, "a1")?.status).toBe("stopped");
    expect(findRun(next, "a2")?.status).toBe("running");
  });

  it("does nothing for an already terminal run", () => {
    const state = admit(createState(), request("a1"), 4, 1000).state;
    const done = settle(state, { runId: "a1", status: "done" }, 4, 2000);

    expect(stop(done, "a1", 4, 3000)).toBe(done);
  });
});

describe("start and setStep", () => {
  it("moves a queued run to running with the given clock", () => {
    const state = admitMany(["a1", "a2", "a3", "a4"]);
    const queued = admit(state, request("a5"), 4, 1000).state;

    const next = start(queued, "a5", 5000);

    expect(findRun(next, "a5")?.status).toBe("running");
    expect(findRun(next, "a5")?.startedAt).toBe(5000);
  });

  it("records the latest tool name and clears it on settle", () => {
    const state = admit(createState(), request("a1"), 4, 1000).state;
    const stepping = setStep(state, "a1", "bash");
    const cleared = settle(stepping, { runId: "a1", status: "done" }, 4, 2000);

    expect(findRun(stepping, "a1")?.step).toBe("bash");
    expect(findRun(cleared, "a1")?.step).toBeNull();
  });
});

describe("appendTranscript", () => {
  it("keeps only the tail", () => {
    let state = admit(createState(), request("a1"), 4, 1000).state;
    for (let i = 0; i < 60; i++) {
      state = appendTranscript(state, "a1", {
        role: "tool",
        text: `line ${i}`,
        at: i,
      });
    }

    const lines = findRun(state, "a1")?.transcript ?? [];
    expect(lines).toHaveLength(40);
    expect(lines[39]?.text).toBe("line 59");
  });
});

describe("clipResult", () => {
  it("leaves short text untouched", () => {
    expect(clipResult("short", 100)).toBe("short");
  });

  it("marks how much was dropped", () => {
    expect(clipResult("abcd", 2)).toBe("ab\n\n[truncated 2 chars]");
  });
});

describe("renderWidgetLines", () => {
  it("returns nothing when no run is active", () => {
    const state = admit(createState(), request("a1"), 4, 1000).state;
    const done = settle(state, { runId: "a1", status: "done" }, 4, 2000);

    expect(renderWidgetLines(done, 3000)).toEqual([]);
  });

  it("shows the agent, the elapsed time and the task on one row", () => {
    const state = admit(
      createState(),
      { ...request("a1"), task: "找 widget 的渲染路径" },
      4,
      1000,
    ).state;
    const lines = renderWidgetLines(state, 13_000);

    expect(lines[0]).toBe("Subagents · 1 running, 0 queued");
    expect(lines[1]).toContain("explore a1");
    expect(lines[1]).toContain("12s");
    expect(lines[1]).toContain("找 widget 的渲染路径");
  });

  it("keeps the first non-empty task line and drops the rest", () => {
    const state = admit(
      createState(),
      { ...request("a1"), task: "\n  第一行\n第二行" },
      4,
      1000,
    ).state;
    const lines = renderWidgetLines(state, 2000);

    expect(lines[1]).toContain("第一行");
    expect(lines[1]).not.toContain("第二行");
  });

  it("right-aligns the status column inside the widget budget", () => {
    const long = admit(
      createState(),
      {
        runId: "a1",
        agent: "code-reviewer",
        task: "找 widget 的渲染路径，对比三个第三方实现并给出结论",
        background: true,
      },
      4,
      1000,
    ).state;
    const state = admit(
      long,
      { ...request("a2"), background: true },
      4,
      5000,
    ).state;
    const lines = renderWidgetLines(state, 13_000);

    expect(visibleWidth(lines[1])).toBe(WIDGET_LINE_BUDGET);
    expect(visibleWidth(lines[2])).toBe(WIDGET_LINE_BUDGET);
  });

  it("keeps a very long tool name inside the budget", () => {
    let state = admit(createState(), request("a1"), 4, 1000).state;
    state = setStep(
      state,
      "a1",
      "mcp__some_server__long_tool_name".repeat(3),
      5000,
    );
    const lines = renderWidgetLines(state, 13_000);

    expect(visibleWidth(lines[1])).toBe(WIDGET_LINE_BUDGET);
    expect(lines[1]).toContain("explore a1");
  });

  it("marks queued runs distinctly", () => {
    const state = admit(
      admitMany(["a1", "a2", "a3", "a4"]),
      request("a5"),
      4,
      1000,
    ).state;
    const lines = renderWidgetLines(state, 2000);

    expect(lines[0]).toBe("Subagents · 4 running, 1 queued");
    expect(lines[5]).toContain("explore a5");
    expect(lines[5]).toContain("queued");
  });

  it("says quiet instead of the stale tool once the child goes silent", () => {
    let state = admit(createState(), request("a1"), 4, 1000).state;
    state = setStep(state, "a1", "grep", 5000);
    const lines = renderWidgetLines(state, 60_000);

    expect(lines[1]).toContain("quiet 55s");
    expect(lines[1]).not.toContain("grep");
  });

  it("leaves escape codes out when no colorize is passed", () => {
    const state = admit(
      createState(),
      { ...request("a1"), task: "很长很长的任务描述，用来触发截断路径" },
      4,
      1000,
    ).state;
    const lines = renderWidgetLines(state, 13_000);

    expect(lines.join("")).not.toContain("\x1b");
  });

  it("paints the glyph, the agent and the status without changing the width", () => {
    const colorize: Colorize = (tone, text) =>
      tone === "accent" ? `\x1b[36m${text}\x1b[39m` : `\x1b[90m${text}\x1b[39m`;
    const state = admit(createState(), request("a1"), 4, 1000).state;
    const lines = renderWidgetLines(state, 13_000, { colorize });

    expect(lines[1]).toContain("\x1b[36mexplore\x1b[39m");
    expect(visibleWidth(lines[1])).toBe(WIDGET_LINE_BUDGET);
  });

  it("truncates a long agent name instead of dropping the whole row", () => {
    let state = admit(
      createState(),
      {
        runId: "a1",
        agent: "x".repeat(60),
        task: "任务",
        background: true,
      },
      4,
      1000,
    ).state;
    state = setStep(
      state,
      "a1",
      "mcp__some_server__long_tool_name".repeat(3),
      5000,
    );
    const lines = renderWidgetLines(state, 13_000);

    expect(visibleWidth(lines[1])).toBe(WIDGET_LINE_BUDGET);
    expect(lines[1]).toContain("a1");
    expect(lines[1]).toContain("…");
  });

  it("keeps only the header when the host can expand zero rows", () => {
    const state = admitMany(["a1"]);

    expect(renderWidgetLines(state, 2000, { maxRows: 0 })).toEqual([
      "Subagents · 1 running, 0 queued · +1 more",
    ]);
  });

  it("caps the rows a host will auto-expand and folds the rest into the header", () => {
    const state = admitMany(["a1", "a2", "a3", "a4"]);
    const lines = renderWidgetLines(state, 2000, { maxRows: 2 });

    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("Subagents · 4 running, 0 queued · +2 more");
    expect(lines[1]).toContain("explore a1");
    expect(lines[2]).toContain("explore a2");
  });

  it("lists every run when the host has no line limit", () => {
    const state = admitMany(["a1", "a2", "a3", "a4"]);

    expect(renderWidgetLines(state, 2000)).toHaveLength(5);
  });
});

describe("truncateToColumns", () => {
  it("returns nothing when there is no room", () => {
    expect(truncateToColumns("abc", 0)).toBe("");
  });

  it("keeps the ellipsis when it is the whole budget", () => {
    expect(truncateToColumns("abc", 1)).toBe("…");
  });

  it("counts wide characters as two columns", () => {
    expect(truncateToColumns("中文中文", 5)).toBe("中文…");
  });

  it("never exceeds the column budget for emoji sequences", () => {
    expect(
      visibleWidth(truncateToColumns("⚠️".repeat(20), 10)),
    ).toBeLessThanOrEqual(10);
  });
});

describe("summarizeTask", () => {
  it("keeps the first non-empty line and collapses inner spaces", () => {
    expect(summarizeTask("\n  找   widget\n第二行")).toBe("找 widget");
  });
});

describe("progressLine", () => {
  it("counts elapsed time and says when no tool ran yet", () => {
    const state = admit(createState(), request("a1"), 4, 1000).state;

    expect(progressLine(runOf(state, "a1"), 13_000)).toBe(
      "explore a1 · running 12s · no tool yet",
    );
  });

  it("shows the last tool and the quiet time once the child goes silent", () => {
    let state = admit(createState(), request("a1"), 4, 1000).state;
    state = setStep(state, "a1", "grep", 5_000);

    expect(progressLine(runOf(state, "a1"), 10_000)).toBe(
      "explore a1 · running 9s · grep",
    );
    expect(progressLine(runOf(state, "a1"), 36_000)).toBe(
      "explore a1 · running 35s · grep · quiet 31s",
    );
  });

  it("reports queued runs as waiting instead of quiet", () => {
    const running = admitMany(["a1", "a2", "a3", "a4"]);
    const state = admit(running, request("a5"), 4, 1000).state;

    expect(progressLine(runOf(state, "a5"), 61_000)).toBe(
      "explore a5 · queued 1m00s · waiting for slot",
    );
  });

  it("returns nothing once the run settles", () => {
    const state = admit(createState(), request("a1"), 4, 1000).state;
    const done = settle(state, { runId: "a1", status: "done" }, 4, 2000);

    expect(progressLine(runOf(done, "a1"), 3000)).toBeUndefined();
  });
});

describe("statusLine", () => {
  it("keeps the single run short: agent and elapsed only", () => {
    const state = admit(createState(), request("a1"), 4, 1000).state;

    expect(statusLine(state, 3000)).toBe("subagent explore 2s");
  });

  it("stays short even when the child has been quiet for a while", () => {
    let state = admit(createState(), request("a1"), 4, 1000).state;
    state = setStep(state, "a1", "grep", 2000);

    const text = statusLine(state, 200_000);
    expect(text).toBe("subagent explore 3m19s");
    expect(text?.length).toBeLessThanOrEqual(40);
  });

  it("counts runs when several are active", () => {
    const state = admitMany(["a1", "a2"]);

    expect(statusLine(state, 3000)).toBe("subagent 2 running, 0 queued");
  });

  it("returns nothing when no run is active", () => {
    const state = settle(
      admit(createState(), request("a1"), 4, 1000).state,
      { runId: "a1", status: "done" },
      4,
      2000,
    );

    expect(statusLine(state, 3000)).toBeUndefined();
  });
});

describe("lastEventAt", () => {
  it("advances with transcript lines and tool steps", () => {
    let state = admit(createState(), request("a1"), 4, 1000).state;
    expect(runOf(state, "a1").lastEventAt).toBe(1000);

    state = appendTranscript(state, "a1", {
      role: "tool",
      text: "read",
      at: 7000,
    });
    expect(runOf(state, "a1").lastEventAt).toBe(7000);

    state = setStep(state, "a1", "grep", 9000);
    expect(runOf(state, "a1").lastEventAt).toBe(9000);
  });
});

describe("renderTranscript", () => {
  it("prefixes each line with its role", () => {
    let state = admit(createState(), request("a1"), 4, 1000).state;
    state = appendTranscript(state, "a1", {
      role: "user",
      text: "find auth",
      at: 1,
    });
    state = appendTranscript(state, "a1", {
      role: "assistant",
      text: "here it is",
      at: 2,
    });

    const run = findRun(state, "a1");
    const lines = run ? renderTranscript(run) : [];

    expect(lines[0]).toContain("explore a1 · running");
    expect(lines[2]).toBe("[user] find auth");
    expect(lines[3]).toBe("[assistant] here it is");
  });

  it("says so when nothing happened yet", () => {
    const state = admit(createState(), request("a1"), 4, 1000).state;
    const run = findRun(state, "a1");

    expect(run && renderTranscript(run)).toContain("(no activity yet)");
  });
});

describe("renderDoctor", () => {
  it("lists scanned dirs, profiles and host capability", () => {
    const lines = renderDoctor({
      scannedDirs: ["/repo/.pi/agents"],
      profiles: [
        profile(),
        profile({
          name: "general",
          source: "project",
          tools: ["read", "bash"],
          model: "m",
          thinking: "high",
        }),
      ],
      maxConcurrent: 4,
      hostKind: "pi-web",
      customPanels: false,
      parentModel: "opencode-go/deepseek-v4.1-flash",
      parentThinking: "max",
      cwd: "/repo",
    }).join("\n");

    expect(lines).toContain("/repo/.pi/agents");
    expect(lines).toContain("host: pi-web (customPanels: false)");
    expect(lines).toContain(
      "reviewer [builtin] tools=read,grep model=(inherit) thinking=(inherit)",
    );
    expect(lines).toContain(
      "general [project] tools=read,bash model=m thinking=high",
    );
    expect(lines).toContain("max concurrent: 4");
  });

  it("says (none) when no dir was scanned", () => {
    const lines = renderDoctor({
      scannedDirs: [],
      profiles: [],
      maxConcurrent: 4,
      hostKind: "tui",
      customPanels: true,
      parentModel: "",
      parentThinking: "",
      cwd: "/repo",
    }).join("\n");

    expect(lines).toContain("(none)");
    expect(lines).toContain("parent model: (unset)");
  });
});

describe("isTerminal", () => {
  it("treats done, failed and stopped as terminal", () => {
    expect(isTerminal("done")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("stopped")).toBe(true);
    expect(isTerminal("running")).toBe(false);
    expect(isTerminal("queued")).toBe(false);
  });
});

describe("eventToTranscriptLine", () => {
  it("turns a tool start into a tool line", () => {
    expect(
      eventToTranscriptLine(
        { type: "tool_execution_start", toolName: "grep" },
        7,
      ),
    ).toEqual({ role: "tool", text: "grep", at: 7 });
  });

  it("takes the text out of an assistant message", () => {
    expect(
      eventToTranscriptLine(
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "found it " },
              { type: "text", text: "in auth.ts" },
            ],
          },
        },
        9,
      ),
    ).toEqual({ role: "assistant", text: "found it in auth.ts", at: 9 });
  });

  it("ignores tool events without a name and empty assistant text", () => {
    expect(
      eventToTranscriptLine({ type: "tool_execution_start" }, 1),
    ).toBeNull();
    expect(
      eventToTranscriptLine(
        { type: "message_end", message: { role: "assistant", content: [] } },
        1,
      ),
    ).toBeNull();
  });

  it("ignores unrelated events", () => {
    expect(eventToTranscriptLine({ type: "agent_end" }, 1)).toBeNull();
  });
});

describe("selectWaitTargets", () => {
  const twoActive = () => {
    let state = admit(createState(), request("a"), 4, 1).state;
    state = admit(state, request("b"), 4, 2).state;
    return state;
  };

  it("waits for every non-terminal run when no ids are given", () => {
    const state = settle(twoActive(), { runId: "a", status: "done" }, 4, 3);
    expect(selectWaitTargets(state).targets.map((run) => run.runId)).toEqual([
      "b",
    ]);
  });

  it("keeps the requested order and drops duplicate ids", () => {
    const state = twoActive();
    expect(
      selectWaitTargets(state, ["b", "a", "b"]).targets.map((run) => run.runId),
    ).toEqual(["b", "a"]);
  });

  it("reports unknown ids instead of throwing", () => {
    const state = twoActive();
    expect(selectWaitTargets(state, ["a", "nope"])).toEqual({
      targets: [runOf(state, "a")],
      unknown: ["nope"],
    });
  });

  it("treats an explicit id list as authoritative even when empty", () => {
    expect(selectWaitTargets(twoActive(), []).targets).toEqual([]);
  });
});

describe("collectWaitResult", () => {
  it("reads the result text of a settled run", () => {
    const state = settle(
      admit(createState(), request("a"), 4, 1).state,
      { runId: "a", status: "done", resultText: "found it" },
      4,
      2,
    );
    expect(collectWaitResult(state, ["a"], false)).toEqual({
      runs: [
        { runId: "a", agent: "explore", status: "done", text: "found it" },
      ],
      timedOut: false,
    });
  });

  it("reports a still-running run as non-terminal on timeout", () => {
    const state = admit(createState(), request("a"), 4, 1).state;
    expect(collectWaitResult(state, ["a"], true)).toEqual({
      runs: [{ runId: "a", agent: "explore", status: "running", text: "" }],
      timedOut: true,
    });
  });

  it("reads a vanished run as stopped rather than dropping it", () => {
    expect(collectWaitResult(createState(), ["gone"], false).runs).toEqual([
      { runId: "gone", agent: "unknown", status: "stopped", text: "" },
    ]);
  });
});

describe("renderWaitResult", () => {
  it("returns the child text without a timeout banner", () => {
    const text = renderWaitResult({
      runs: [
        { runId: "a", agent: "explore", status: "done", text: "found it" },
      ],
      timedOut: false,
    });
    expect(text).toContain("found it");
    expect(text).not.toContain("timed out");
  });

  it("says how many runs settled before a timeout", () => {
    const text = renderWaitResult({
      runs: [
        { runId: "a", agent: "explore", status: "done", text: "found it" },
        { runId: "b", agent: "explore", status: "running", text: "" },
      ],
      timedOut: true,
    });
    expect(text).toContain("1/2 settled");
    expect(text).toContain("1 still running");
    expect(text).toContain("found it");
  });

  it("says so when there was nothing to wait for", () => {
    expect(renderWaitResult({ runs: [], timedOut: false })).toBe(
      "no subagent runs to wait for",
    );
  });
});
