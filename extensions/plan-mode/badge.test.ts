import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { PLAN_MODE_BADGE_CHANNEL } from "../shared/internal-events.js";
import { MODE_WIDGET_KEY, STATUS_KEY } from "./constants.js";
import {
  buildCtx,
  buildHarness,
  markPiWebHost,
  planModeExtension,
  recordUiCalls,
  type UiCall,
} from "./test-harness.js";

/**
 * footer badge 协议：别的扩展广播，plan-mode 渲染。这里钉住三件事：
 * 只认本会话 cwd、同一个 key 后写覆盖、`null` 撤下。
 */

const start = async () => {
  const harness = buildHarness();
  const ctx = buildCtx();
  const calls = recordUiCalls(ctx);
  planModeExtension(harness.api as unknown as ExtensionAPI);
  await harness.emit("session_start", {}, ctx);
  return { harness, ctx, calls };
};

const badge = (ctx: { cwd: string }, text: string | null, cwd = ctx.cwd) => ({
  type: "plan-mode.badge" as const,
  ctx,
  cwd,
  key: "poteto",
  text,
});

const widgetLines = (calls: UiCall[]): string[] => {
  const widgets = calls.filter(
    (call): call is Extract<UiCall, { call: "setWidget" }> =>
      call.call === "setWidget" && call.key === MODE_WIDGET_KEY,
  );
  return widgets.at(-1)?.lines ?? [];
};

const statusText = (calls: UiCall[]): string | undefined => {
  const statuses = calls.filter(
    (call): call is Extract<UiCall, { call: "setStatus" }> =>
      call.call === "setStatus" && call.key === STATUS_KEY,
  );
  return statuses.at(-1)?.text;
};

describe("footer badges", () => {
  it("renders a badge in the TUI mode widget", async () => {
    const { harness, ctx, calls } = await start();
    await harness.api.events.emit(
      PLAN_MODE_BADGE_CHANNEL,
      badge(ctx, "poteto on"),
    );

    expect(widgetLines(calls).at(-1)).toContain("poteto on");
    // TUI 的模式文案在 widget 里，状态行按设计清空。
    expect(statusText(calls)).toBeUndefined();
  });

  it("renders a badge in the pi-web status line instead", async () => {
    markPiWebHost();
    const harness = buildHarness();
    const ctx = { ...buildCtx(), mode: "rpc" };
    const calls = recordUiCalls(ctx);
    planModeExtension(harness.api as unknown as ExtensionAPI);
    await harness.emit("session_start", {}, ctx);

    await harness.api.events.emit(
      PLAN_MODE_BADGE_CHANNEL,
      badge(ctx, "poteto on"),
    );

    expect(statusText(calls)).toContain("poteto on");
  });

  it("drops a badge from another workspace", async () => {
    const { harness, ctx, calls } = await start();
    const before = calls.length;

    await harness.api.events.emit(
      PLAN_MODE_BADGE_CHANNEL,
      badge(ctx, "poteto on", "/somewhere/else"),
    );

    expect(calls).toHaveLength(before);
    expect(widgetLines(calls).at(-1)).not.toContain("poteto on");
  });

  it("removes the badge when text is null", async () => {
    const { harness, ctx, calls } = await start();
    await harness.api.events.emit(
      PLAN_MODE_BADGE_CHANNEL,
      badge(ctx, "poteto on"),
    );
    await harness.api.events.emit(PLAN_MODE_BADGE_CHANNEL, badge(ctx, null));

    expect(widgetLines(calls).at(-1)).not.toContain("poteto on");
  });

  it("ignores a repeated badge with the same text", async () => {
    const { harness, ctx, calls } = await start();
    await harness.api.events.emit(
      PLAN_MODE_BADGE_CHANNEL,
      badge(ctx, "poteto on"),
    );
    const settled = calls.length;

    await harness.api.events.emit(
      PLAN_MODE_BADGE_CHANNEL,
      badge(ctx, "poteto on"),
    );

    expect(calls).toHaveLength(settled);
  });
});
