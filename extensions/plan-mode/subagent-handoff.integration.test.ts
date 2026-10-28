/* biome-ignore-all lint/suspicious/noExplicitAny: pi session 的测试替身必须是 any。 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: vi.fn(),
  createCodemodeExtension: () => ({ name: "codemode" }),
  createMcpExtension: () => ({ name: "mcp" }),
  DefaultResourceLoader: class {
    options: unknown;
    constructor(options: unknown) {
      this.options = options;
    }
    async reload(): Promise<void> {}
  },
  getAgentDir: () => "/agent",
  SessionManager: { inMemory: () => ({ kind: "in-memory" }) },
}));

const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
const { registerSubagent } = await import("../subagent/index.js");
const {
  buildCtx,
  buildHarness,
  buildPiWebCtx,
  clearPiWebHost,
  lastModeWidgetCall,
  markPiWebHost,
  planModeExtension,
  recordUiCalls,
} = await import("./test-harness.js");

const hangingSession = () => ({
  messages: [],
  prompt: vi.fn(async () => new Promise(() => undefined)),
  subscribe: vi.fn(() => () => undefined),
  dispose: vi.fn(),
  steer: vi.fn(async () => "queued"),
  abort: vi.fn(async () => undefined),
  bindExtensions: vi.fn(async () => undefined),
});

beforeEach(() => {
  vi.mocked(createAgentSession).mockReset();
});

/**
 * 两个扩展一起跑，共用同一份真事件总线与宿主 ui。
 *
 * 这是本条需求真实立面的最小复刻：subagent 广播文本，plan-mode 把它拼进自己的
 * mode widget，并把 footer 面收回去 —— 同一个计数只出现一次。
 */
describe("plan-mode + subagent：同一个 widget，不再有第二个 footer", () => {
  it("把运行中的 subagent 计数并进 mode widget，footer 让位", async () => {
    vi.mocked(createAgentSession).mockImplementation((async () => ({
      session: hangingSession(),
    })) as never);
    const harness = buildHarness();
    const ctx = buildCtx();
    const calls = recordUiCalls(ctx);
    planModeExtension(harness.api as unknown as ExtensionAPI);
    const runtime = registerSubagent(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);

    await harness.runTool(
      "subagent",
      { action: "run", agent: "explore", task: "a1" },
      ctx,
    );
    await harness.runTool(
      "subagent",
      { action: "run", agent: "explore", task: "a2" },
      ctx,
    );
    // 等两次 launch 真正落地，别把异步的 createAgentSession 漏到下一个用例里。
    await vi.waitFor(() =>
      expect(vi.mocked(createAgentSession)).toHaveBeenCalledTimes(2),
    );

    const widget = (lastModeWidgetCall(ctx)[1] as string[]).join("\n");
    expect(widget).toContain("subagent 2 running, 0 queued");

    const footerWrites = calls.filter(
      (call) => call.call === "setStatus" && call.key === "subagent",
    );
    expect(footerWrites.length).toBeGreaterThan(0);
    expect(
      footerWrites.every((call) => "text" in call && call.text === undefined),
    ).toBe(true);

    for (const run of runtime.readState().runs) {
      runtime.stopRun(run.runId);
    }

    const after = (lastModeWidgetCall(ctx)[1] as string[]).join("\n");
    expect(after).not.toContain("subagent");
  });

  it("pi-web：接管发生在 run 进行中，状态行接走文本、footer 让位", async () => {
    vi.mocked(createAgentSession).mockImplementation((async () => ({
      session: hangingSession(),
    })) as never);
    markPiWebHost();
    try {
      const harness = buildHarness();
      const ctx = buildPiWebCtx();
      const calls = recordUiCalls(ctx);
      planModeExtension(harness.api as unknown as ExtensionAPI);
      const runtime = registerSubagent(harness.api as unknown as ExtensionAPI);
      await harness.emit("session_start", {}, ctx);

      // 纯 act：没人接管，subagent 自己写 footer。
      await harness.runTool(
        "subagent",
        { action: "run", agent: "explore", task: "a1" },
        ctx,
      );
      await harness.runTool(
        "subagent",
        { action: "run", agent: "explore", task: "a2" },
        ctx,
      );
      await vi.waitFor(() =>
        expect(vi.mocked(createAgentSession)).toHaveBeenCalledTimes(2),
      );
      const footerWrites = () =>
        calls.filter(
          (call) => call.call === "setStatus" && call.key === "subagent",
        );
      expect(footerWrites().at(-1)).toEqual({
        call: "setStatus",
        key: "subagent",
        text: "subagent 2 running, 0 queued",
      });

      // 进入 plan：plan-mode 接管，状态行接走这段文本，footer 清空。
      await harness.runCommand("plan-mode", "plan", ctx);

      expect(footerWrites().at(-1)).toEqual({
        call: "setStatus",
        key: "subagent",
        text: undefined,
      });
      // 最终一帧里，带这个计数的只有 plan-mode 那一段。
      const lastPlanStatus = calls
        .filter((call) => call.call === "setStatus" && call.key === "plan-mode")
        .at(-1);
      const lastPlanStatusText =
        lastPlanStatus && "text" in lastPlanStatus
          ? lastPlanStatus.text
          : undefined;
      expect(lastPlanStatusText).toContain(
        "Plan Mode: Plan · Planning · subagent 2 running, 0 queued",
      );
      expect(
        calls
          .filter(
            (call) =>
              call.call === "setStatus" &&
              call.key === "subagent" &&
              "text" in call &&
              typeof call.text === "string",
          )
          .at(-1),
      ).toEqual({
        call: "setStatus",
        key: "subagent",
        text: "subagent 2 running, 0 queued",
      });

      for (const run of runtime.readState().runs) {
        runtime.stopRun(run.runId);
      }
    } finally {
      clearPiWebHost();
    }
  });
});
