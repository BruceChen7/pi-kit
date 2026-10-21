import { describe, expect, it } from "vitest";
import type { AgentProfile } from "./agents.js";
import {
  activeRuns,
  admit,
  appendTranscript,
  clipResult,
  createState,
  DEFAULT_MAX_CONCURRENT,
  eventToTranscriptLine,
  findRun,
  isTerminal,
  MAX_RESULT_CHARS,
  renderDoctor,
  renderTranscript,
  renderWidgetLines,
  setStep,
  settle,
  start,
  stop,
} from "./core.js";

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
    const { state, admitted, queued } = admit(
      createState(),
      request("a1"),
      4,
      1000,
    );

    expect(admitted).toEqual(["a1"]);
    expect(queued).toEqual([]);
    expect(findRun(state, "a1")?.status).toBe("running");
  });

  it("queues past the concurrency ceiling", () => {
    const state = admitMany(["a1", "a2", "a3", "a4"]);
    const { state: next, queued } = admit(state, request("a5"), 4, 1000);

    expect(queued).toEqual(["a5"]);
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

  it("shows the running count, the agent and the elapsed time", () => {
    const state = admitMany(["a1", "a2"]);
    const lines = renderWidgetLines(state, 13_000);

    expect(lines[0]).toBe("Subagents · 2 running, 0 queued");
    expect(lines[1]).toContain("explore a1 12s");
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
    expect(lines[5]).toContain("· explore a5");
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
