import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePi,
  createTempRepo,
  createTestContext,
  flushMicrotasks,
  mockPlannotatorApi,
  removeTempRepo,
  type TestCtx,
  writeTestFile,
} from "./test-helpers.js";

async function importPlannotatorAuto() {
  return (await import("./index.js")).default;
}

type FakePi = ReturnType<typeof createFakePi>;

async function emitToolCall(
  emit: FakePi["emit"],
  ctx: TestCtx,
  toolName: string,
  args: Record<string, unknown>,
  toolCallId = "mcp-call-1",
): Promise<void> {
  await emit("tool_execution_start", { toolName, toolCallId, args }, ctx);
  await emit(
    "tool_execution_end",
    { toolName, toolCallId, isError: false },
    ctx,
  );
}

type PlannotatorAutoHarness = FakePi & {
  repoRoot: string;
  repoName: string;
  createCtx: (options?: Parameters<typeof createTestContext>[1]) => TestCtx;
};

async function withPlannotatorAutoTest(
  repoPrefix: string,
  runTest: (harness: PlannotatorAutoHarness) => Promise<void>,
): Promise<void> {
  vi.resetModules();
  mockPlannotatorApi();

  const plannotatorAuto = await importPlannotatorAuto();
  const pi = createFakePi();
  plannotatorAuto(pi.api as never);

  const repoRoot = await createTempRepo(repoPrefix);
  const repoName = repoRoot.split("/").pop() ?? "repo";
  let ctx: TestCtx | undefined;

  try {
    await runTest({
      ...pi,
      repoRoot,
      repoName,
      createCtx: (options) => {
        ctx = createTestContext(repoRoot, options);
        return ctx;
      },
    });
  } finally {
    if (ctx) {
      await pi.emit("session_shutdown", {}, ctx);
    }
    await removeTempRepo(repoRoot);
  }
}

async function writePlanDraft(
  repoRoot: string,
  repoName: string,
): Promise<string> {
  const relativePath = `.pi/plans/${repoName}/plan/2026-10-08-mcp.md`;
  await writeTestFile(repoRoot, relativePath, "# Plan\n\n- [ ] test\n");
  return relativePath;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("MCP writes and the review gates", () => {
  it("queues a plan review for an MCP write to a plan artifact", async () => {
    await withPlannotatorAutoTest(
      "plannotator-auto-mcp-plan-",
      async ({ emit, repoRoot, repoName, setToolInfos, createCtx }) => {
        const planFileRelative = await writePlanDraft(repoRoot, repoName);
        const ctx = createCtx({ isIdle: false });

        setToolInfos([{ name: "mcp__filesystem__write_file" }]);
        await emit("session_start", {}, ctx);

        await emitToolCall(emit, ctx, "mcp__filesystem__write_file", {
          file_path: planFileRelative,
          content: "# Plan\n",
        });
        await flushMicrotasks();

        const result = (await emit("before_agent_start", {}, ctx)) as {
          message?: { content?: string };
        };
        expect(result.message?.content ?? "").toContain(planFileRelative);
        expect(result.message?.content ?? "").toContain(
          "plannotator_auto_submit_review",
        );
      },
    );
  });

  it("ignores MCP reads that declare readOnlyHint", async () => {
    await withPlannotatorAutoTest(
      "plannotator-auto-mcp-read-",
      async ({ emit, repoRoot, repoName, setToolInfos, createCtx }) => {
        const planFileRelative = await writePlanDraft(repoRoot, repoName);
        const ctx = createCtx({ isIdle: true });

        setToolInfos([
          {
            name: "mcp__filesystem__read_file",
            annotations: { readOnlyHint: true },
          },
        ]);
        await emit("session_start", {}, ctx);

        await emitToolCall(emit, ctx, "mcp__filesystem__read_file", {
          path: planFileRelative,
        });
        await flushMicrotasks();

        await expect(
          emit("before_agent_start", {}, ctx),
        ).resolves.toBeUndefined();
      },
    );
  });

  it("ignores MCP calls that name no file path", async () => {
    await withPlannotatorAutoTest(
      "plannotator-auto-mcp-nopath-",
      async ({ emit, repoRoot, repoName, setToolInfos, createCtx }) => {
        await writePlanDraft(repoRoot, repoName);
        const ctx = createCtx({ isIdle: true });

        setToolInfos([{ name: "mcp__linear__create_issue" }]);
        await emit("session_start", {}, ctx);

        await emitToolCall(emit, ctx, "mcp__linear__create_issue", {
          title: "issue title",
        });
        await flushMicrotasks();

        await expect(
          emit("before_agent_start", {}, ctx),
        ).resolves.toBeUndefined();
      },
    );
  });
});
