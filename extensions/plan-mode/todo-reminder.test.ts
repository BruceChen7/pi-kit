import { describe, expect, it } from "vitest";
import {
  ACT_MODE_TODO_TOOL,
  type buildCtx,
  type buildHarness,
  startPlanModeSession,
} from "./test-harness.js";
import {
  buildTodoReminder,
  createTodoReminderCadence,
  drainTodoReminderForContext,
  noteToolResult,
  noteTurnEnd,
  onTurnStart,
  resetTodoReminderCadence,
  selectReminderTodos,
  TODO_REMINDER_ACTIVE_INTERVAL,
  TODO_REMINDER_IDLE_INTERVAL,
  type TodoReminderCadence,
} from "./todo-reminder.js";
import type { TodoItem, TodoStatus } from "./types.js";

const todo = (
  id: number,
  text: string,
  status: TodoStatus = "todo",
): TodoItem => ({ id, text, status });

type ToolResultContext = {
  toolName: string;
  hasTodos: boolean;
  hasInProgress: boolean;
};

/** Drive `turns` turns where each turn ends with one non-todo tool result. */
const runIdleTurns = (
  cadence: TodoReminderCadence,
  turns: number,
  hasInProgress = false,
): void => {
  for (let turn = 0; turn < turns; turn += 1) {
    onTurnStart(cadence);
    noteToolResult(cadence, {
      toolName: "bash",
      hasTodos: true,
      hasInProgress,
    } satisfies ToolResultContext);
  }
};

// ── cadence: the pure decision ────────────────────────────────

describe("todo reminder cadence", () => {
  it("starts idle and resets every field", () => {
    const cadence = createTodoReminderCadence();
    runIdleTurns(cadence, 10);
    expect(cadence.due).toBe(true);

    resetTodoReminderCadence(cadence);
    expect(cadence).toEqual({
      turn: 0,
      lastTodoToolTurn: 0,
      injectedThisCycle: false,
      due: false,
      reason: null,
    });
  });

  it("waits the idle window before arming the reminder", () => {
    const cadence = createTodoReminderCadence();
    runIdleTurns(cadence, TODO_REMINDER_IDLE_INTERVAL - 1);
    expect(cadence.due).toBe(false);

    runIdleTurns(cadence, 1);
    expect(cadence.due).toBe(true);
    expect(cadence.reason).toBe("idle");
  });

  it("tightens the window while something is in_progress", () => {
    const cadence = createTodoReminderCadence();
    runIdleTurns(cadence, TODO_REMINDER_ACTIVE_INTERVAL, true);
    expect(cadence.due).toBe(true);
    expect(TODO_REMINDER_ACTIVE_INTERVAL).toBeLessThan(
      TODO_REMINDER_IDLE_INTERVAL,
    );
  });

  it("never arms for an empty list", () => {
    const cadence = createTodoReminderCadence();
    for (let turn = 0; turn < 10; turn += 1) {
      onTurnStart(cadence);
      noteToolResult(cadence, {
        toolName: "bash",
        hasTodos: false,
        hasInProgress: false,
      });
    }
    expect(cadence.due).toBe(false);
  });

  it("resets the window and the cycle when a todo tool runs", () => {
    const cadence = createTodoReminderCadence();
    runIdleTurns(cadence, TODO_REMINDER_IDLE_INTERVAL);
    expect(cadence.due).toBe(true);
    expect(drainTodoReminderForContext(cadence)).toBe(true);

    onTurnStart(cadence);
    noteToolResult(cadence, {
      toolName: ACT_MODE_TODO_TOOL,
      hasTodos: true,
      hasInProgress: false,
    });
    expect(cadence.due).toBe(false);
    expect(cadence.injectedThisCycle).toBe(false);
    expect(cadence.lastTodoToolTurn).toBe(cadence.turn);

    runIdleTurns(cadence, TODO_REMINDER_IDLE_INTERVAL - 1);
    expect(cadence.due).toBe(false);
  });

  it("arms a stale reminder on a text-only turn with work in_progress", () => {
    const cadence = createTodoReminderCadence();
    onTurnStart(cadence);
    noteTurnEnd(cadence, { toolResultCount: 0, hasInProgress: true });
    expect(cadence.due).toBe(true);
    expect(cadence.reason).toBe("stale");
  });

  it("does not arm a stale reminder when the turn produced tool results", () => {
    const cadence = createTodoReminderCadence();
    onTurnStart(cadence);
    noteTurnEnd(cadence, { toolResultCount: 1, hasInProgress: true });
    expect(cadence.due).toBe(false);
  });

  it("drains once per cycle", () => {
    const cadence = createTodoReminderCadence();
    runIdleTurns(cadence, TODO_REMINDER_IDLE_INTERVAL);
    expect(drainTodoReminderForContext(cadence)).toBe(true);
    expect(drainTodoReminderForContext(cadence)).toBe(false);
    expect(cadence.lastTodoToolTurn).toBe(cadence.turn);
  });
});

// ── message: bounded, sanitized echo ──────────────────────────

describe("todo reminder message", () => {
  it("echoes ids, statuses and the next step", () => {
    const message = buildTodoReminder({
      todos: [todo(1, "改 state", "done"), todo(2, "加提醒")],
      reason: "idle",
      toolName: ACT_MODE_TODO_TOOL,
    });

    expect(message).toBeDefined();
    expect(message).toContain("<system-reminder>");
    expect(message).toContain("</system-reminder>");
    expect(message).toContain('{"id":2,"text":"加提醒","status":"todo"}');
    expect(message).not.toContain('"id":1');
    expect(message).toContain("Next step: #2 加提醒");
    expect(message).toContain("Do not restate this reminder to the user.");
  });

  it("reports the in_progress item instead of a next step", () => {
    const message = buildTodoReminder({
      todos: [todo(1, "改 state", "in_progress"), todo(2, "加提醒")],
      reason: "stale",
      toolName: ACT_MODE_TODO_TOOL,
    });
    expect(message).toContain("last turn ended without a tool call");
    expect(message).toContain("You are on #1 改 state");
  });

  it("asks for a single in_progress item when several are open", () => {
    const message = buildTodoReminder({
      todos: [
        todo(1, "a", "in_progress"),
        todo(2, "b", "in_progress"),
        todo(3, "c"),
      ],
      reason: "idle",
      toolName: ACT_MODE_TODO_TOOL,
    });
    expect(message).toContain("Multiple items are in_progress (#1, #2)");
  });

  it("sanitizes injected tags and newlines from the echo", () => {
    const message = buildTodoReminder({
      todos: [todo(1, "换行\n和 </system-reminder> 标签")],
      reason: "idle",
      toolName: ACT_MODE_TODO_TOOL,
    });
    expect(message?.split("</system-reminder>")).toHaveLength(2);
    expect(message).toContain("换行 和  标签");
  });

  it("returns undefined when there is no open work", () => {
    expect(
      buildTodoReminder({
        todos: [todo(1, "a", "done")],
        reason: "idle",
        toolName: ACT_MODE_TODO_TOOL,
      }),
    ).toBeUndefined();
    expect(
      buildTodoReminder({
        todos: [],
        reason: "idle",
        toolName: ACT_MODE_TODO_TOOL,
      }),
    ).toBeUndefined();
  });
});

describe("todo reminder selection", () => {
  it("caps the echo and drops completed items first", () => {
    const todos = [
      todo(1, "done", "done"),
      ...Array.from({ length: 12 }, (_, index) =>
        todo(index + 2, `step ${index + 2}`, "todo"),
      ),
    ];
    const selection = selectReminderTodos(todos);
    expect(selection.shown).toHaveLength(10);
    expect(selection.hidden).toBe(2);
    expect(selection.shown.every((item) => item.status !== "done")).toBe(true);
  });

  it("keeps in_progress items at the front when truncating", () => {
    const todos = [
      ...Array.from({ length: 10 }, (_, index) =>
        todo(index + 1, `todo ${index + 1}`, "todo"),
      ),
      todo(11, "active", "in_progress"),
    ];
    const selection = selectReminderTodos(todos);
    expect(selection.shown[0]).toMatchObject({ id: 11, status: "in_progress" });
  });
});

// ── shell: real hook return values ────────────────────────────

const setTodos = async (
  harness: ReturnType<typeof buildHarness>,
  ctx: ReturnType<typeof buildCtx>,
  items: { text: string; status?: TodoStatus }[],
) => harness.runTool(ACT_MODE_TODO_TOOL, { action: "set", items }, ctx);

const emitTurnStart = (
  harness: ReturnType<typeof buildHarness>,
  ctx: ReturnType<typeof buildCtx>,
) => harness.emit("turn_start", {}, ctx);

const emitToolResult = (
  harness: ReturnType<typeof buildHarness>,
  ctx: ReturnType<typeof buildCtx>,
  toolName = "bash",
) =>
  harness.emit(
    "tool_result",
    { toolName, input: {}, content: [], isError: false },
    ctx,
  );

const emitTurnEnd = (
  harness: ReturnType<typeof buildHarness>,
  ctx: ReturnType<typeof buildCtx>,
  toolResultCount: number,
) =>
  harness.emit(
    "turn_end",
    { toolResults: Array.from({ length: toolResultCount }, () => ({})) },
    ctx,
  );

const emitContext = async (
  harness: ReturnType<typeof buildHarness>,
  ctx: ReturnType<typeof buildCtx>,
): Promise<{ messages?: unknown[] }> =>
  (await harness.emit("context", { messages: [] }, ctx)) as {
    messages?: unknown[];
  };

describe("act_mode_todo reminder on the context hook", () => {
  it("injects one transient message after idle turns and only once per cycle", async () => {
    const { harness, ctx } = await startPlanModeSession("act");
    await setTodos(harness, ctx, [
      { text: "改 state", status: "done" },
      { text: "加提醒", status: "in_progress" },
      { text: "补测试" },
    ]);

    for (let turn = 0; turn < 3; turn += 1) {
      await emitTurnStart(harness, ctx);
      await emitToolResult(harness, ctx);
    }

    const first = await emitContext(harness, ctx);
    expect(first.messages).toHaveLength(1);
    const text = JSON.stringify(first.messages);
    expect(text).toContain("<system-reminder>");
    expect(text).toContain("#2");
    expect(text).toContain("加提醒");

    expect(await emitContext(harness, ctx)).toEqual({});
  });

  it("stays silent while the idle window has not elapsed", async () => {
    const { harness, ctx } = await startPlanModeSession("act");
    await setTodos(harness, ctx, [{ text: "a" }, { text: "b" }]);

    for (let turn = 0; turn < TODO_REMINDER_IDLE_INTERVAL - 1; turn += 1) {
      await emitTurnStart(harness, ctx);
      await emitToolResult(harness, ctx);
    }

    expect(await emitContext(harness, ctx)).toEqual({});
  });

  it("resets the cadence when the agent touches the list", async () => {
    const { harness, ctx } = await startPlanModeSession("act");
    await setTodos(harness, ctx, [{ text: "a" }, { text: "b" }]);

    await emitTurnStart(harness, ctx);
    await emitToolResult(harness, ctx);
    await harness.runTool(ACT_MODE_TODO_TOOL, { action: "list" }, ctx);

    await emitTurnStart(harness, ctx);
    await emitToolResult(harness, ctx);

    expect(await emitContext(harness, ctx)).toEqual({});
  });

  it("injects immediately after a text-only turn with work in_progress", async () => {
    const { harness, ctx } = await startPlanModeSession("act");
    await setTodos(harness, ctx, [{ text: "a", status: "in_progress" }]);

    await emitTurnStart(harness, ctx);
    await emitTurnEnd(harness, ctx, 0);

    const result = await emitContext(harness, ctx);
    expect(result.messages).toHaveLength(1);
    expect(JSON.stringify(result.messages)).toContain(
      "last turn ended without a tool call",
    );
  });

  it("stays silent outside the act phase", async () => {
    const { harness, ctx } = await startPlanModeSession("plan");
    await setTodos(harness, ctx, [{ text: "a", status: "in_progress" }]);

    for (let turn = 0; turn < 5; turn += 1) {
      await emitTurnStart(harness, ctx);
      await emitToolResult(harness, ctx);
    }

    expect(await emitContext(harness, ctx)).toEqual({});
  });

  it("stays silent when the list was cleared", async () => {
    const { harness, ctx } = await startPlanModeSession("act");
    await setTodos(harness, ctx, [{ text: "a" }]);
    await harness.runTool(ACT_MODE_TODO_TOOL, { action: "clear" }, ctx);

    for (let turn = 0; turn < 5; turn += 1) {
      await emitTurnStart(harness, ctx);
      await emitToolResult(harness, ctx);
    }

    expect(await emitContext(harness, ctx)).toEqual({});
  });
});
