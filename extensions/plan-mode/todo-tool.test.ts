import { describe, expect, it } from "vitest";
import {
  ACT_MODE_TODO_TOOL,
  registeredTool,
  startPlanModeSession,
} from "./test-harness.js";
import {
  formatTodoUpdateSummary,
  planTodoPatchApplication,
} from "./todo-tool.js";

type ToolResult = {
  content: Array<{ text: string }>;
  details?: { todos?: Array<{ id: number; status: string; text: string }> };
  isError?: boolean;
};

const callTodo = async (
  harness: Awaited<ReturnType<typeof startPlanModeSession>>["harness"],
  ctx: Awaited<ReturnType<typeof startPlanModeSession>>["ctx"],
  params: Record<string, unknown>,
): Promise<ToolResult> =>
  (await harness.runTool(ACT_MODE_TODO_TOOL, params, ctx)) as ToolResult;

const statuses = (result: ToolResult) =>
  (result.details?.todos ?? []).map((todo) => `${todo.id}:${todo.status}`);

const seed = async (
  harness: Awaited<ReturnType<typeof startPlanModeSession>>["harness"],
  ctx: Awaited<ReturnType<typeof startPlanModeSession>>["ctx"],
) =>
  callTodo(harness, ctx, {
    action: "set",
    items: [
      { text: "第一步", status: "todo" },
      { text: "第二步", status: "todo" },
      { text: "第三步", status: "todo" },
    ],
  });

// ── core: which patches may land ──────────────────────────────

describe("planTodoPatchApplication", () => {
  it("accepts patches whose ids all exist", () => {
    const plan = planTodoPatchApplication(
      [1, 2, 3],
      [
        { id: 1, status: "done" },
        { id: 2, status: "in_progress" },
      ],
    );

    expect(plan).toEqual({
      kind: "apply",
      patches: [
        { id: 1, status: "done" },
        { id: 2, status: "in_progress" },
      ],
    });
  });

  it("reports the first missing id so nothing lands half applied", () => {
    const plan = planTodoPatchApplication(
      [1, 2],
      [
        { id: 1, status: "done" },
        { id: 9, status: "done" },
      ],
    );

    expect(plan).toEqual({ kind: "missing", id: 9 });
  });

  it("accepts an empty patch list as a no-op", () => {
    expect(planTodoPatchApplication([1], [])).toEqual({
      kind: "apply",
      patches: [],
    });
  });
});

// ── core: one-line summary instead of the whole list ──────────

describe("formatTodoUpdateSummary", () => {
  const todos = [
    { id: 1, text: "甲", status: "done" as const },
    { id: 2, text: "乙", status: "in_progress" as const },
    { id: 3, text: "丙", status: "todo" as const },
  ];

  it("names what changed and what is still open", () => {
    const summary = formatTodoUpdateSummary(
      [
        { id: 1, status: "done" },
        { id: 2, status: "in_progress" },
      ],
      todos,
    );

    expect(summary).toBe(
      "Updated #1 → done, #2 → in_progress. Open: 2 (in_progress: #2).",
    );
  });

  it("says none when no item is in progress", () => {
    const summary = formatTodoUpdateSummary(
      [{ id: 1, status: "done" }],
      [todos[0], { id: 3, text: "丙", status: "todo" }],
    );

    expect(summary).toContain("in_progress: none");
  });

  it("marks a patch that only touched text or notes as edited", () => {
    expect(formatTodoUpdateSummary([{ id: 3, notes: "改备注" }], todos)).toBe(
      "Updated #3 → edited. Open: 2 (in_progress: #2).",
    );
  });

  it("does not repeat the todo text", () => {
    const summary = formatTodoUpdateSummary([{ id: 1, status: "done" }], todos);

    expect(summary).not.toContain("甲");
    expect(summary).not.toContain("TODO list");
  });
});

// ── shell: the tool contract ─────────────────────────────────

describe("act_mode_todo: batch update", () => {
  it("applies several status changes in one call", async () => {
    const { harness, ctx } = await startPlanModeSession("act");
    await seed(harness, ctx);

    const result = await callTodo(harness, ctx, {
      action: "update",
      updates: [
        { id: 1, status: "done" },
        { id: 2, status: "in_progress" },
      ],
    });

    expect(statuses(result)).toEqual(["1:done", "2:in_progress", "3:todo"]);
  });

  it("rejects the whole batch when one id is unknown", async () => {
    const { harness, ctx } = await startPlanModeSession("act");
    await seed(harness, ctx);

    const result = await callTodo(harness, ctx, {
      action: "update",
      updates: [
        { id: 1, status: "done" },
        { id: 9, status: "done" },
      ],
    });

    expect(result.content[0]?.text).toContain("TODO #9 not found");
    expect(result.isError).toBe(true);
    const after = await callTodo(harness, ctx, { action: "list" });
    expect(statuses(after)).toEqual(["1:todo", "2:todo", "3:todo"]);
  });

  it("marks a rejected call as an error result, not a success", async () => {
    const { harness, ctx } = await startPlanModeSession("act");
    await seed(harness, ctx);

    const missingText = await callTodo(harness, ctx, { action: "add" });
    expect(missingText.content[0]?.text).toContain("text is required");
    expect(missingText.isError).toBe(true);

    const missingId = await callTodo(harness, ctx, { action: "update" });
    expect(missingId.content[0]?.text).toContain("id or updates is required");
    expect(missingId.isError).toBe(true);
  });

  it("still accepts a single id and keeps an empty text from erasing it", async () => {
    const { harness, ctx } = await startPlanModeSession("act");
    await seed(harness, ctx);

    const result = await callTodo(harness, ctx, {
      action: "update",
      id: 2,
      status: "done",
      text: "",
    });

    expect(statuses(result)).toEqual(["1:todo", "2:done", "3:todo"]);
    expect(result.details?.todos?.[1]?.text).toBe("第二步");
  });

  it("prefers the batch when a filling model also sends the single-item fields", async () => {
    const { harness, ctx } = await startPlanModeSession("act");
    await seed(harness, ctx);

    // 实录形状：cc-switch-gateway/gpt-5.6-sol 把 schema 里声明的字段全填了。
    const result = await callTodo(harness, ctx, {
      action: "update",
      id: 0,
      items: [],
      notes: "",
      status: "todo",
      text: "unused",
      updates: [
        { id: 1, status: "done", text: "第一步" },
        { id: 2, status: "in_progress", text: "第二步" },
      ],
    });

    expect(statuses(result)).toEqual(["1:done", "2:in_progress", "3:todo"]);
    expect(result.content[0]?.text).not.toContain("Error");
  });

  it("accepts a single-id update next to an empty updates array", async () => {
    const { harness, ctx } = await startPlanModeSession("act");
    await seed(harness, ctx);

    const result = await callTodo(harness, ctx, {
      action: "update",
      id: 2,
      status: "done",
      updates: [],
    });

    expect(statuses(result)).toEqual(["1:todo", "2:done", "3:todo"]);
  });

  it("reports an unknown id on remove instead of a silent success", async () => {
    const { harness, ctx } = await startPlanModeSession("act");
    await seed(harness, ctx);

    const result = await callTodo(harness, ctx, { action: "remove", id: 0 });

    expect(result.content[0]?.text).toContain("TODO #0 not found");
    const after = await callTodo(harness, ctx, { action: "list" });
    expect(statuses(after)).toEqual(["1:todo", "2:todo", "3:todo"]);
  });
});

describe("act_mode_todo: result size", () => {
  it("returns a one-line summary for update instead of the whole list", async () => {
    const { harness, ctx } = await startPlanModeSession("act");
    await seed(harness, ctx);

    const result = await callTodo(harness, ctx, {
      action: "update",
      id: 1,
      status: "done",
    });
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("Updated #1 → done");
    expect(text).not.toContain("Current Act Mode TODO list");
    expect(text.split("\n")).toHaveLength(1);
  });

  it("keeps the full list for set, add, remove and list", async () => {
    const { harness, ctx } = await startPlanModeSession("act");
    const seeded = await seed(harness, ctx);

    expect(seeded.content[0]?.text).toContain("Current Act Mode TODO list");
    for (const params of [
      { action: "add", text: "第四步" },
      { action: "remove", id: 4 },
      { action: "list" },
    ]) {
      const result = await callTodo(harness, ctx, params);
      expect(result.content[0]?.text).toContain("Current Act Mode TODO list");
    }
  });
});

describe("act_mode_todo: guidance", () => {
  it("tells the agent to batch status changes in one call", async () => {
    const { harness } = await startPlanModeSession("act");
    const guidance =
      registeredTool(harness, ACT_MODE_TODO_TOOL).promptGuidelines?.join(
        "\n",
      ) ?? "";

    expect(guidance).toContain("updates");
    expect(guidance).toContain("one call");
  });
});
