import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { type FeatureRecord, listFeatureRecords } from "./storage.js";
import { buildWtSwitchCreateArgs, parseWtJsonResult } from "./wt.js";

export type WtExecutionResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type WtRunner = (args: string[]) => Promise<WtExecutionResult>;

const trimToNull = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const toErrorMessage = (result: WtExecutionResult, fallback: string): string =>
  trimToNull(result.stderr) ?? trimToNull(result.stdout) ?? fallback;

const getWorktreePath = (
  result: WtExecutionResult,
  fallbackPath: string = "",
): string => {
  const wtJson = parseWtJsonResult(result.stdout);
  if (!wtJson) {
    return fallbackPath;
  }

  return typeof wtJson.path === "string" ? wtJson.path : fallbackPath;
};

export function createWtRunner(pi: ExtensionAPI, repoRoot: string): WtRunner {
  return async (args: string[]): Promise<WtExecutionResult> => {
    const result = await pi.exec("wt", ["-C", repoRoot, ...args]);
    return {
      code: result.code ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };
}

export async function listFeatureRecordsFromWorktree(
  runWt: WtRunner,
): Promise<
  { ok: true; records: FeatureRecord[] } | { ok: false; message: string }
> {
  const result = await runWt(["list", "--format", "json"]);
  if (result.code !== 0) {
    return { ok: false, message: toErrorMessage(result, "wt list failed") };
  }

  return {
    ok: true,
    records: listFeatureRecords(result.stdout),
  };
}

export async function createFeatureWorktree(
  runWt: WtRunner,
  input: { branch: string; base: string },
): Promise<
  { ok: true; worktreePath: string } | { ok: false; message: string }
> {
  const result = await runWt(
    buildWtSwitchCreateArgs({
      branch: input.branch,
      base: input.base,
    }),
  );

  if (result.code !== 0) {
    return {
      ok: false,
      message: toErrorMessage(result, "wt switch failed"),
    };
  }

  return {
    ok: true,
    worktreePath: getWorktreePath(result),
  };
}

export async function ensureFeatureWorktree(
  runWt: WtRunner,
  input: {
    branch: string;
    fallbackWorktreePath: string;
  },
): Promise<
  { ok: true; worktreePath: string } | { ok: false; message: string }
> {
  const result = await runWt([
    "switch",
    input.branch,
    "--no-cd",
    "--format",
    "json",
    "--yes",
  ]);

  if (result.code !== 0) {
    return {
      ok: false,
      message: toErrorMessage(result, "wt switch failed"),
    };
  }

  return {
    ok: true,
    worktreePath: getWorktreePath(result, input.fallbackWorktreePath),
  };
}
