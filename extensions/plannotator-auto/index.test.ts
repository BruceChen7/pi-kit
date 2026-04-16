import { describe, expect, it } from "vitest";

type ImportedModule = {
  buildPlanCommands?: (...args: unknown[]) => string[];
  shouldQueueReviewForToolPath?: (
    planConfig: {
      planFile: string;
      resolvedPlanPath: string;
      mode: "file" | "directory";
    } | null,
    targetPath: string,
  ) => boolean;
  getSessionKey?: (ctx: {
    cwd: string;
    sessionManager: { getSessionFile: () => string | null | undefined };
  }) => string;
};

const importPlannotatorAuto = async (): Promise<ImportedModule> =>
  (await import("./index.js")) as ImportedModule;

const createPi = () => ({
  getCommands: () => [
    { name: "plannotator", source: "extension" },
    { name: "plannotator-set-file", source: "extension" },
    { name: "plannotator-annotate", source: "extension" },
    { name: "plannotator-review", source: "extension" },
  ],
});

describe("buildPlanCommands", () => {
  it("queues file activation commands without auto-annotate", async () => {
    const { buildPlanCommands } = await importPlannotatorAuto();

    expect(buildPlanCommands).toBeTypeOf("function");

    const commands = buildPlanCommands?.(
      createPi(),
      {
        cwd: "/repo",
        sessionManager: {
          getSessionFile: () => "/repo/.pi/sessions/one.jsonl",
        },
      },
      "PLAN.md",
      null,
    );

    expect(commands).toEqual([
      "/plannotator-set-file PLAN.md",
      "/plannotator PLAN.md",
    ]);
  });
});

describe("shouldQueueReviewForToolPath", () => {
  it("skips code review when only the single configured plan file changed", async () => {
    const { shouldQueueReviewForToolPath } = await importPlannotatorAuto();

    expect(shouldQueueReviewForToolPath).toBeTypeOf("function");
    expect(
      shouldQueueReviewForToolPath?.(
        {
          planFile: ".pi/PLAN.md",
          resolvedPlanPath: "/repo/.pi/PLAN.md",
          mode: "file",
        },
        "/repo/.pi/PLAN.md",
      ),
    ).toBe(false);
  });

  it("skips code review when a generated plan file changed inside the plan directory", async () => {
    const { shouldQueueReviewForToolPath } = await importPlannotatorAuto();

    expect(
      shouldQueueReviewForToolPath?.(
        {
          planFile: ".pi/plans/repo/plan",
          resolvedPlanPath: "/repo/.pi/plans/repo/plan",
          mode: "directory",
        },
        "/repo/.pi/plans/repo/plan/2026-04-15-auth-flow.md",
      ),
    ).toBe(false);
  });

  it("still queues code review when a non-plan file changed", async () => {
    const { shouldQueueReviewForToolPath } = await importPlannotatorAuto();

    expect(
      shouldQueueReviewForToolPath?.(
        {
          planFile: ".pi/plans/repo/plan",
          resolvedPlanPath: "/repo/.pi/plans/repo/plan",
          mode: "directory",
        },
        "/repo/src/auth.ts",
      ),
    ).toBe(true);
  });
});

describe("getSessionKey", () => {
  it("falls back to a cwd-scoped ephemeral key when the session file is unavailable", async () => {
    const { getSessionKey } = await importPlannotatorAuto();

    expect(getSessionKey).toBeTypeOf("function");
    expect(
      getSessionKey?.({
        cwd: "/repo",
        sessionManager: { getSessionFile: () => null },
      }),
    ).toBe("/repo::ephemeral");
  });
});
