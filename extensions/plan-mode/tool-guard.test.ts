import { describe, expect, it } from "vitest";
import {
  buildCtx,
  buildHarness,
  expectToolAllowed,
  expectToolBlocked,
  fs,
  markFileRead,
  path,
  planModeExtension,
  startPlanModeSession,
  withTempCtx,
  writeSourceFile,
} from "./test-harness.js";

describe("plan-mode extension: tool guards", () => {
  it("blocks source writes during plan mode phase but allows review artifact writes", async () => {
    const { harness, ctx } = await startPlanModeSession();

    await expectToolBlocked(harness, ctx, "write", { path: "x.ts" });
    await expectToolBlocked(harness, ctx, "edit", { path: "x.ts" });
    await expectToolBlocked(harness, ctx, "bash", { command: "npm test" });
    await expectToolAllowed(harness, ctx, "write", {
      path: ".pi/plans/pi-kit/plan/2026-05-08-demo.md",
    });
    await expectToolAllowed(harness, ctx, "write", {
      path: ".pi/plans/pi-kit/plan/2026-05-08-demo.html",
    });
    await expectToolAllowed(harness, ctx, "edit", {
      patch: `*** Begin Patch
*** Update File: .pi/plans/pi-kit/plan/2026-05-08-demo.md
@@
-old
+new
*** End Patch`,
    });
    await expectToolAllowed(harness, ctx, "write", {
      path: ".pi/plans/pi-kit/specs/2026-05-08-demo-design.md",
    });
    await expectToolAllowed(harness, ctx, "write", {
      path: ".pi/plans/pi-kit/issues/session-switch-lifecycle/01-cleanup.md",
    });
    await expectToolAllowed(harness, ctx, "write", {
      path: ".pi/plans/pi-kit/shaping/current-notes.md",
    });
    await expectToolBlocked(harness, ctx, "write", {
      path: ".pi/plans/pi-kit/specs/2026-05-08-demo-design.html",
    });
    await expectToolBlocked(harness, ctx, "write", {
      path: ".pi/plans/pi-kit/issues/01-root-issue.md",
    });

    await harness.runCommand("plan-mode", "act", ctx);
    await expectToolAllowed(harness, ctx, "write", { path: "x.ts" });
  });

  it("allows date-prefixed plan writes even when .pi does not exist yet", async () => {
    await withTempCtx(async (ctx) => {
      const { harness } = await startPlanModeSession("act", ctx);

      expect(fs.existsSync(path.join(ctx.cwd, ".pi"))).toBe(false);
      await expectToolAllowed(harness, ctx, "write", {
        path: ".pi/plans/pi-kit/plan/2026-05-08-demo.md",
      });
    });
  });

  it("explains the date-prefixed review artifact filename when blocking plan writes", async () => {
    const harness = buildHarness();
    const ctx = buildCtx();
    planModeExtension(harness.api as unknown as ExtensionAPI);

    await harness.emit("session_start", {}, ctx);
    await harness.runCommand("plan-mode", "plan", ctx);

    const result = await harness.runToolCall(
      "write",
      { path: ".pi/plans/pi-kit/plan/demo.md" },
      ctx,
    );

    expect(result).toMatchObject({
      block: true,
      reason: expect.stringContaining(
        ".pi/plans/<repo>/plan/YYYY-MM-DD-<slug>.md",
      ),
    });
    expect(result).toMatchObject({
      reason: expect.stringContaining("No mkdir is needed"),
    });
  });

  it("allows reads and writes outside cwd in act phase", async () => {
    const { harness, ctx } = await startPlanModeSession("act");
    const outsidePath = "/tmp/outside-cwd.txt";

    for (const toolName of ["read", "grep", "find", "ls", "rg", "fd"]) {
      await expectToolAllowed(harness, ctx, toolName, { path: outsidePath });
    }

    for (const toolName of ["write", "edit"]) {
      await expectToolAllowed(harness, ctx, toolName, { path: outsidePath });
    }
  });

  it("allows act patch edits for existing files that were read first", async () => {
    await withTempCtx(async (ctx) => {
      const targetPath = "src/example.ts";
      writeSourceFile(ctx, targetPath, "export const value = 1;\n");

      const { harness } = await startPlanModeSession("act", ctx);
      await markFileRead(harness, ctx, targetPath);

      await expectToolAllowed(harness, ctx, "edit", {
        patch: `*** Begin Patch
*** Update File: ${targetPath}
@@
-export const value = 1;
+export const value = 2;
*** End Patch`,
      });
    });
  });

  it("requires every existing multi-edit target to be read first", async () => {
    await withTempCtx(async (ctx) => {
      const firstPath = "src/first.ts";
      const secondPath = "src/second.ts";
      for (const targetPath of [firstPath, secondPath]) {
        writeSourceFile(ctx, targetPath);
      }

      const { harness } = await startPlanModeSession("act", ctx);
      await markFileRead(harness, ctx, firstPath);

      await expectToolBlocked(
        harness,
        ctx,
        "edit",
        {
          multi: [
            { path: firstPath, oldText: "export {};", newText: "export {};" },
            { path: secondPath, oldText: "export {};", newText: "export {};" },
          ],
        },
        {
          block: true,
          reason: expect.stringContaining(secondPath),
        },
      );
    });
  });

  it("allows multi-edit entries to inherit the top-level path", async () => {
    await withTempCtx(async (ctx) => {
      const targetPath = "src/inherited.ts";
      writeSourceFile(ctx, targetPath);

      const { harness } = await startPlanModeSession("act", ctx);
      await markFileRead(harness, ctx, targetPath);

      await expectToolAllowed(harness, ctx, "edit", {
        path: targetPath,
        multi: [{ oldText: "export {};", newText: "export {};" }],
      });
    });
  });

  it("allows patch add-file writes inside cwd without requiring a prior read", async () => {
    await withTempCtx(async (ctx) => {
      const { harness } = await startPlanModeSession("act", ctx);

      await expectToolAllowed(harness, ctx, "edit", {
        patch: `*** Begin Patch
*** Add File: src/new-file.ts
+export const value = 1;
*** End Patch`,
      });
    });
  });

  it("allows follow-up edits after a successful fresh write in the same session", async () => {
    await withTempCtx(async (ctx) => {
      const targetPath = "src/fresh-write.ts";
      const { harness } = await startPlanModeSession("act", ctx);

      await expectToolAllowed(harness, ctx, "write", {
        path: targetPath,
        content: "export const value = 1;\n",
      });
      writeSourceFile(ctx, targetPath, "export const value = 1;\n");
      await harness.emit(
        "tool_result",
        {
          toolName: "write",
          input: { path: targetPath, content: "export const value = 1;\n" },
          isError: false,
        },
        ctx,
      );

      await expectToolAllowed(harness, ctx, "edit", {
        path: targetPath,
        oldText: "export const value = 1;\n",
        newText: "export const value = 2;\n",
      });
    });
  });

  it("allows patch add-file writes outside cwd in act phase", async () => {
    const { harness, ctx } = await startPlanModeSession("act");

    await expectToolAllowed(harness, ctx, "edit", {
      patch: `*** Begin Patch
*** Add File: /tmp/outside-plan-mode.ts
+export const value = 1;
*** End Patch`,
    });
  });

  it("requires patch delete-file targets to be read first", async () => {
    await withTempCtx(async (ctx) => {
      const targetPath = "src/delete-me.ts";
      writeSourceFile(ctx, targetPath);
      const { harness } = await startPlanModeSession("act", ctx);

      await expectToolBlocked(
        harness,
        ctx,
        "edit",
        {
          patch: `*** Begin Patch
*** Delete File: ${targetPath}
*** End Patch`,
        },
        {
          block: true,
          reason: expect.stringContaining(targetPath),
        },
      );
    });
  });

  it("keeps read-only tools using dot as their default path", async () => {
    const { harness, ctx } = await startPlanModeSession("act");

    await expectToolAllowed(harness, ctx, "ls", {});
  });

  it("blocks unresolved write targets without falling back to dot", async () => {
    const { harness, ctx } = await startPlanModeSession("act");

    const result = await harness.runToolCall(
      "edit",
      { patch: "*** Begin Patch\n*** End Patch" },
      ctx,
    );

    expect(result).toMatchObject({
      block: true,
      reason: expect.stringContaining("unable to determine target file paths"),
    });
    expect(result).not.toMatchObject({
      reason: expect.stringContaining(": ."),
    });
  });
});
