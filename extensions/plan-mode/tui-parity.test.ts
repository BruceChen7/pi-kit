import { writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildCtx,
  buildHarness,
  completeApprovedDemoRun,
  PLAN_MODE_TODO_TOOL,
  planModeExtension,
  recordUiCalls,
  type TestCtx,
  type UiCall,
} from "./test-harness.js";
import { TUI_CALL_BASELINE } from "./tui-call-baseline.js";

/**
 * TUI 基线（characterization）：为 pi-web 做的适配不得改变终端下的输出，逐条固定
 * `setStatus` / `setWidget` 的顺序、key、行数与行内容（含 ANSI 主题包装）。
 *
 * 只有确实要让 TUI 有意变更时才重新录制：
 *   PLAN_MODE_RECORD_TUI_PARITY=1 npx vitest run extensions/plan-mode/tui-parity.test.ts
 * 其它不一致一律按回归处理：改实现，不改基线。
 */

type Scenario = () => Promise<UiCall[]>;

const scenario = async (
  options: { plan?: boolean },
  run: (
    harness: ReturnType<typeof buildHarness>,
    ctx: TestCtx,
  ) => Promise<void>,
): Promise<UiCall[]> => {
  const harness = buildHarness();
  const ctx = buildCtx();
  const calls = recordUiCalls(ctx);
  planModeExtension(harness.api as unknown as ExtensionAPI);
  await harness.emit("session_start", {}, ctx);
  if (options.plan) {
    await harness.runCommand("plan-mode", "plan", ctx);
  }
  await run(harness, ctx);
  return calls;
};

const TUI_SCENARIOS: Record<string, Scenario> = {
  "session_start：Act、无 todo": () => scenario({}, async () => {}),
  "切到 plan 模式": () => scenario({ plan: true }, async () => {}),
  "1 个 todo（set、in_progress）": () =>
    scenario({ plan: true }, async (harness, ctx) => {
      await harness.runTool(
        PLAN_MODE_TODO_TOOL,
        {
          action: "set",
          items: [{ text: "实现状态机", status: "in_progress" }],
        },
        ctx,
      );
    }),
  "4 个 todo：set + 完成一个": () =>
    scenario({}, async (harness, ctx) => {
      await harness.runTool(
        PLAN_MODE_TODO_TOOL,
        {
          action: "set",
          items: [
            { text: "实现状态机", status: "in_progress" },
            { text: "补充 README", status: "todo" },
            { text: "补测试", status: "todo" },
            { text: "提交", status: "todo" },
          ],
        },
        ctx,
      );
      await harness.runTool(
        PLAN_MODE_TODO_TOOL,
        { action: "update", id: 1, status: "done" },
        ctx,
      );
    }),
  "已批准计划跑完（completeApprovedDemoRun）": () =>
    scenario({}, async (harness, ctx) => {
      await completeApprovedDemoRun(harness, ctx);
    }),
  "plan → act 切换": () =>
    scenario({ plan: true }, async (harness, ctx) => {
      await harness.runCommand("plan-mode", "act", ctx);
    }),
  "/plan-mode status": () =>
    scenario({}, async (harness, ctx) => {
      await harness.runCommand("plan-mode", "status", ctx);
    }),
};

const collectBaseline = async (): Promise<Record<string, UiCall[]>> => {
  const recorded: Record<string, UiCall[]> = {};
  for (const [name, run] of Object.entries(TUI_SCENARIOS)) {
    recorded[name] = await run();
  }
  return recorded;
};

const BASELINE_PATH = new URL("./tui-call-baseline.ts", import.meta.url);

const RERECORD_HEADER = `/**
 * 终端下的 \`ctx.ui\` 调用基线（characterization fixture）。由 \`tui-parity.test.ts\`
 * 生成，不要手改：
 *   PLAN_MODE_RECORD_TUI_PARITY=1 npx vitest run extensions/plan-mode/tui-parity.test.ts
 * 只有确实要让 TUI 有意变更时才重新录制；其它不一致一律按回归处理（改实现，不改基线）。
 */
import type { UiCall } from "./test-harness.js";

`;

beforeEach(() => {
  // 宿主判定必须走“无标记 + 无逃生口 ⇒ tui”，否则基线不再代表终端。
  delete process.env.PI_KIT_UI_HOST;
  delete (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("@agegr/pi-web/session-liveness/v1")
  ];
});

if (process.env.PLAN_MODE_RECORD_TUI_PARITY === "1") {
  it("重新录制 TUI 基线（写回 tui-call-baseline.ts）", async () => {
    const recorded = await collectBaseline();
    await writeFile(
      BASELINE_PATH,
      `${RERECORD_HEADER}export const TUI_CALL_BASELINE: Record<string, UiCall[]> = ` +
        `${JSON.stringify(recorded, null, 2)};\n`,
      "utf8",
    );
    expect(Object.keys(recorded).sort()).toEqual(
      Object.keys(TUI_SCENARIOS).sort(),
    );
  });
}

describe("plan-mode TUI parity (characterization)", () => {
  it("baseline covers every scenario", () => {
    expect(Object.keys(TUI_CALL_BASELINE).sort()).toEqual(
      Object.keys(TUI_SCENARIOS).sort(),
    );
  });

  for (const name of Object.keys(TUI_SCENARIOS)) {
    it(name, async () => {
      const expected = TUI_CALL_BASELINE[name];
      expect(expected, `缺少基线：${name}`).toBeDefined();
      const recorded = await TUI_SCENARIOS[name]();
      expect(recorded).toEqual(expected);
    });
  }
});
