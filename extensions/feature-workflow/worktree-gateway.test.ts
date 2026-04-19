import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  createFeatureWorktree,
  createWtRunner,
  ensureFeatureWorktree,
  listFeatureRecordsFromWorktree,
  resolvePrimaryWorktreePathFromWt,
  runCopyIgnoredToFeatureWorktree,
  runWorktreeHook,
  type WtRunner,
} from "./worktree-gateway.js";

const okResult = (stdout: string) => ({ code: 0, stdout, stderr: "" });
const failResult = (stderr: string) => ({ code: 1, stdout: "", stderr });

describe("worktree-gateway", () => {
  it("creates worktree and extracts path from wt json output", async () => {
    const runWt: WtRunner = vi
      .fn()
      .mockResolvedValue(
        okResult(
          '{"action":"created","path":"/repo/.wt/feat-main-checkout-v2"}',
        ),
      );

    const result = await createFeatureWorktree(runWt, {
      branch: "feat/main/checkout-v2",
      base: "main",
    });

    expect(result).toEqual({
      ok: true,
      worktreePath: "/repo/.wt/feat-main-checkout-v2",
    });
    expect(runWt).toHaveBeenCalledWith([
      "switch",
      "--create",
      "feat/main/checkout-v2",
      "--base",
      "main",
      "--no-cd",
      "--yes",
    ]);
  });

  it("resolves create worktree path from wt list when switch output is not json", async () => {
    const runWt: WtRunner = vi
      .fn()
      .mockResolvedValueOnce(okResult("Switched to feat/main/checkout-v2"))
      .mockResolvedValueOnce(
        okResult(
          JSON.stringify([
            {
              branch: "feat/main/checkout-v2",
              path: "/repo/.wt/feat-main-checkout-v2",
            },
          ]),
        ),
      );

    const result = await createFeatureWorktree(runWt, {
      branch: "feat/main/checkout-v2",
      base: "main",
    });

    expect(result).toEqual({
      ok: true,
      worktreePath: "/repo/.wt/feat-main-checkout-v2",
    });
    expect(runWt).toHaveBeenNthCalledWith(1, [
      "switch",
      "--create",
      "feat/main/checkout-v2",
      "--base",
      "main",
      "--no-cd",
      "--yes",
    ]);
    expect(runWt).toHaveBeenNthCalledWith(2, ["list", "--format", "json"]);
  });

  it("returns mapped error message when wt create fails", async () => {
    const runWt: WtRunner = vi
      .fn()
      .mockResolvedValue(failResult("base branch missing"));

    const result = await createFeatureWorktree(runWt, {
      branch: "feat/main/checkout-v2",
      base: "main",
    });

    expect(result).toEqual({ ok: false, message: "base branch missing" });
  });

  it("ensures worktree and falls back to previous path when wt json omits path", async () => {
    const runWt: WtRunner = vi
      .fn()
      .mockResolvedValue(okResult('{"action":"already_at"}'));

    const result = await ensureFeatureWorktree(runWt, {
      branch: "feat/main/checkout-v2",
      fallbackWorktreePath: "/repo/.wt/feat-main-checkout-v2",
    });

    expect(result).toEqual({
      ok: true,
      worktreePath: "/repo/.wt/feat-main-checkout-v2",
    });
    expect(runWt).toHaveBeenCalledWith([
      "switch",
      "feat/main/checkout-v2",
      "--no-cd",
      "--yes",
    ]);
  });

  it("lists feature records from wt list output", async () => {
    const runWt: WtRunner = vi.fn().mockResolvedValue(
      okResult(
        JSON.stringify([
          {
            branch: "main/checkout-v2",
            path: "/repo/.wt/main-checkout-v2",
            commit: { timestamp: 100 },
          },
        ]),
      ),
    );

    const result = await listFeatureRecordsFromWorktree(runWt, [
      "main/checkout-v2",
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.records).toHaveLength(1);
      expect(result.records[0]).toMatchObject({
        branch: "main/checkout-v2",
        worktreePath: "/repo/.wt/main-checkout-v2",
      });
    }
    expect(runWt).toHaveBeenCalledWith(["list", "--format", "json"]);
  });

  it("returns mapped error when wt list fails", async () => {
    const runWt: WtRunner = vi
      .fn()
      .mockResolvedValue(failResult("wt list failed"));

    const result = await listFeatureRecordsFromWorktree(runWt, []);

    expect(result).toEqual({ ok: false, message: "wt list failed" });
  });

  it("runs named hook without forwarding branch flags", async () => {
    const runWt: WtRunner = vi.fn().mockResolvedValue(okResult("ok"));

    const result = await runWorktreeHook(runWt, {
      hookType: "pre-start",
      hook: "project-deps-link",
      branch: "feat/main/checkout-v2",
    });

    expect(result).toEqual({ ok: true });
    expect(runWt).toHaveBeenCalledWith([
      "hook",
      "pre-start",
      "project-deps-link",
      "--yes",
    ]);
  });

  it("runs copy-ignored fallback with timeout", async () => {
    const runWt: WtRunner = vi.fn().mockResolvedValue(okResult("ok"));

    const result = await runCopyIgnoredToFeatureWorktree(runWt, {
      toBranch: "feat/main/checkout-v2",
      timeoutMs: 1234,
    });

    expect(result).toEqual({ ok: true });
    expect(runWt).toHaveBeenCalledWith(
      ["step", "copy-ignored", "--to", "feat/main/checkout-v2"],
      { timeoutMs: 1234 },
    );
  });

  it("resolves primary worktree path from wt list output", async () => {
    const runWt: WtRunner = vi.fn().mockResolvedValue(
      okResult(
        JSON.stringify([
          {
            branch: "main",
            path: "/repo",
            is_main: true,
          },
          {
            branch: "feat/main/checkout-v2",
            path: "/repo/.wt/feat-main-checkout-v2",
            is_main: false,
          },
        ]),
      ),
    );

    const result = await resolvePrimaryWorktreePathFromWt(runWt);
    expect(result).toEqual({ ok: true, path: "/repo" });
  });

  it("returns error when primary worktree path cannot be determined", async () => {
    const runWt: WtRunner = vi
      .fn()
      .mockResolvedValue(okResult(JSON.stringify([])));

    const result = await resolvePrimaryWorktreePathFromWt(runWt);
    expect(result).toEqual({
      ok: false,
      message: "Failed to resolve primary worktree path from wt list output",
    });
  });

  it("creates wt runner with repo root prefix and normalized result", async () => {
    const exec = vi.fn().mockResolvedValue({
      code: undefined,
      stdout: undefined,
      stderr: undefined,
    });

    const pi = { exec } as unknown as ExtensionAPI;
    const runWt = createWtRunner(pi, "/repo");

    const result = await runWt(["list", "--format", "json"]);

    expect(exec).toHaveBeenCalledWith("wt", [
      "-C",
      "/repo",
      "list",
      "--format",
      "json",
    ]);
    expect(result).toEqual({ code: 1, stdout: "", stderr: "" });
  });

  it("forwards timeout option to pi.exec", async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "[]",
      stderr: "",
    });

    const pi = { exec } as unknown as ExtensionAPI;
    const runWt = createWtRunner(pi, "/repo");

    await runWt(["list", "--format", "json"], { timeoutMs: 5000 });

    expect(exec).toHaveBeenCalledWith(
      "wt",
      ["-C", "/repo", "list", "--format", "json"],
      { timeout: 5000 },
    );
  });
});
