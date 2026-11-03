import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  ACT_MODE_TODO_TOOL,
  type buildCtx,
  buildHarness,
  emitAbortedAgentEnd,
  lastPersistedPlanModeSnapshot,
  planModeExtension,
  startPlanModeSession,
  withTempCtx,
} from "./test-harness.js";

const seedOpenTodos = async (
  harness: ReturnType<typeof buildHarness>,
  ctx: ReturnType<typeof buildCtx>,
) => {
  await harness.runTool(
    ACT_MODE_TODO_TOOL,
    {
      action: "set",
      items: [
        { text: "run e2e", status: "in_progress" },
        { text: "update README", status: "todo" },
      ],
    },
    ctx,
  );
};

const closeoutCalls = (harness: ReturnType<typeof buildHarness>) =>
  harness.api.sendUserMessage.mock.calls.filter((call) =>
    String(call[0]).includes("Act Mode is stopping"),
  );

describe("act todo closeout gate", () => {
  it("asks once when the run stops with open items", async () => {
    const { harness, ctx } = await startPlanModeSession("act");
    await seedOpenTodos(harness, ctx);
    harness.api.sendUserMessage.mockClear();

    await harness.emit("agent_end", { messages: [] }, ctx);

    const calls = closeoutCalls(harness);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toEqual({ deliverAs: "followUp" });
    expect(String(calls[0]?.[0])).toContain("#1");
  });

  it("never writes the todo list itself", async () => {
    const { harness, ctx } = await startPlanModeSession("act");
    await seedOpenTodos(harness, ctx);
    const before = lastPersistedPlanModeSnapshot(harness)?.todos;
    expect(before).toBeDefined();

    await harness.emit("agent_end", { messages: [] }, ctx);

    expect(lastPersistedPlanModeSnapshot(harness)?.todos).toEqual(before);
  });

  it("stays silent once the list is settled", async () => {
    const { harness, ctx } = await startPlanModeSession("act");
    await seedOpenTodos(harness, ctx);
    await harness.runTool(
      ACT_MODE_TODO_TOOL,
      {
        action: "update",
        updates: [
          { id: 1, status: "done" },
          { id: 2, status: "blocked", notes: "waiting on review" },
        ],
      },
      ctx,
    );
    harness.api.sendUserMessage.mockClear();

    await harness.emit("agent_end", { messages: [] }, ctx);

    expect(closeoutCalls(harness)).toHaveLength(0);
  });

  it("asks once, then notifies once, then stays silent", async () => {
    const { harness, ctx } = await startPlanModeSession("act");
    await seedOpenTodos(harness, ctx);
    harness.api.sendUserMessage.mockClear();
    ctx.ui.notify.mockClear();

    await harness.emit("agent_end", { messages: [] }, ctx);
    await harness.emit("agent_end", { messages: [] }, ctx);
    await harness.emit("agent_end", { messages: [] }, ctx);
    await harness.emit("agent_end", { messages: [] }, ctx);

    expect(closeoutCalls(harness)).toHaveLength(1);
    const notices = ctx.ui.notify.mock.calls.filter((call) =>
      String(call[0]).includes("still has"),
    );
    expect(notices).toHaveLength(1);
  });

  it("gives up without a follow-up when hasUI is false", async () => {
    const { harness, ctx } = await startPlanModeSession("act");
    await seedOpenTodos(harness, ctx);
    harness.api.sendUserMessage.mockClear();
    const headless = { ...ctx, hasUI: false };

    await harness.emit("agent_end", { messages: [] }, headless);
    await harness.emit("agent_end", { messages: [] }, headless);
    await harness.emit("agent_end", { messages: [] }, headless);

    expect(closeoutCalls(harness)).toHaveLength(1);
  });

  it("does not fire on an aborted run", async () => {
    const { harness, ctx } = await startPlanModeSession("act");
    await seedOpenTodos(harness, ctx);
    harness.api.sendUserMessage.mockClear();

    await emitAbortedAgentEnd(harness, ctx);

    expect(closeoutCalls(harness)).toHaveLength(0);
  });

  it("leaves the plan phase review gate alone", async () => {
    const { harness, ctx } = await startPlanModeSession("plan");
    await harness.runTool(
      ACT_MODE_TODO_TOOL,
      { action: "set", items: [{ text: "plan step", status: "todo" }] },
      ctx,
    );
    harness.api.sendUserMessage.mockClear();

    await harness.emit("agent_end", { messages: [] }, ctx);

    expect(closeoutCalls(harness)).toHaveLength(0);
    // The existing review-gate follow-up must still be the one that fires.
    expect(
      harness.api.sendUserMessage.mock.calls.some((call) =>
        String(call[0]).includes("approved Plannotator plan/spec"),
      ),
    ).toBe(true);
  });

  it("does not stack the in-run reminder on the closeout turn", async () => {
    const { harness, ctx } = await startPlanModeSession("act");
    await seedOpenTodos(harness, ctx);
    harness.api.sendUserMessage.mockClear();
    await harness.emit("turn_start", {}, ctx);
    await harness.emit("turn_end", { toolResults: [] }, ctx);

    await harness.emit("agent_end", { messages: [] }, ctx);
    const context = (await harness.emit("context", { messages: [] }, ctx)) as {
      messages?: unknown[];
    };

    expect(context.messages ?? []).toHaveLength(0);
  });

  it("resets the budget once the list is closed out", async () => {
    const { harness, ctx } = await startPlanModeSession("act");
    await seedOpenTodos(harness, ctx);
    harness.api.sendUserMessage.mockClear();
    await harness.emit("agent_end", { messages: [] }, ctx);
    await harness.emit("agent_end", { messages: [] }, ctx);
    await harness.emit("agent_end", { messages: [] }, ctx);
    expect(closeoutCalls(harness)).toHaveLength(1);

    // Closing the list out rebuilds the ledger; the next list gets a fresh
    // budget instead of inheriting the exhausted one.
    await harness.runTool(ACT_MODE_TODO_TOOL, { action: "clear" }, ctx);
    await harness.emit("agent_end", { messages: [] }, ctx);
    await seedOpenTodos(harness, ctx);
    harness.api.sendUserMessage.mockClear();

    await harness.emit("agent_end", { messages: [] }, ctx);

    expect(closeoutCalls(harness)).toHaveLength(1);
  });
});

describe("act todo closeout gate: extension wiring", () => {
  it("registers the gate only for the act todo tool name", async () => {
    await withTempCtx(async (ctx) => {
      const harness = buildHarness();
      planModeExtension(harness.api as unknown as ExtensionAPI);
      await harness.emit("session_start", {}, ctx);
      await harness.runCommand("plan-mode", "act", ctx);
      await seedOpenTodos(harness, ctx);
      harness.api.sendUserMessage.mockClear();

      await harness.emit("agent_end", { messages: [] }, ctx);

      expect(closeoutCalls(harness)[0]?.[0]).toContain(ACT_MODE_TODO_TOOL);
    });
  });
});
