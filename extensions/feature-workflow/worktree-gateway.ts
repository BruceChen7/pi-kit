import { execFile } from "node:child_process";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type { FeatureRecord } from "./storage.js";
import { trimToNull } from "./utils.ts";
import {
  buildWtSwitchArgs,
  buildWtSwitchCreateArgs,
  parseWtJsonResult,
} from "./wt.ts";
import {
  resolveWorktreePathForBranchFromWtList as findWorktreePathForBranchFromWtList,
  listFeatureRecordsFromWtList,
  listSwitchableFeatureRecordsFromWtList,
  resolvePrimaryWorktreePathFromWtList,
} from "./wt-list.ts";

export type WtExecutionResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type WtRunOptions = {
  timeoutMs?: number;
};

export type WtRunner = (
  args: string[],
  options?: WtRunOptions,
) => Promise<WtExecutionResult>;

const toErrorMessage = (result: WtExecutionResult, fallback: string): string =>
  trimToNull(result.stderr) ?? trimToNull(result.stdout) ?? fallback;

const isExistingBranchSwitchHint = (message: string): boolean =>
  /branch\s+.+\s+already exists/i.test(message) &&
  /without\s+--create/i.test(message);

const timeoutFromOptions = (options: WtRunOptions): number | undefined => {
  if (typeof options.timeoutMs !== "number") return undefined;
  if (!Number.isFinite(options.timeoutMs)) return undefined;
  return options.timeoutMs > 0 ? options.timeoutMs : undefined;
};

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

const resolveWorktreePathForBranch = async (
  runWt: WtRunner,
  input: {
    branch: string;
    fallbackPath: string;
  },
): Promise<string> => {
  const result = await runWt(["list", "--format", "json"]);
  if (result.code !== 0) {
    return input.fallbackPath;
  }

  return (
    findWorktreePathForBranchFromWtList(result.stdout, input.branch) ??
    input.fallbackPath
  );
};

export function createWtRunner(pi: ExtensionAPI, repoRoot: string): WtRunner {
  return async (
    args: string[],
    options: WtRunOptions = {},
  ): Promise<WtExecutionResult> => {
    const timeout = timeoutFromOptions(options);
    const execOptions = typeof timeout === "number" ? { timeout } : undefined;

    const result =
      typeof execOptions === "undefined"
        ? await pi.exec("wt", ["-C", repoRoot, ...args])
        : await pi.exec("wt", ["-C", repoRoot, ...args], execOptions);
    return {
      code: result.code ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };
}

export function createProcessWtRunner(repoRoot: string): WtRunner {
  return async (
    args: string[],
    options: WtRunOptions = {},
  ): Promise<WtExecutionResult> => {
    const timeout = timeoutFromOptions(options);

    return new Promise((resolve) => {
      execFile(
        "wt",
        ["-C", repoRoot, ...args],
        {
          encoding: "utf-8",
          timeout,
        },
        (error, stdout, stderr) => {
          const normalizedStdout = stdout ?? "";
          const normalizedStderr = stderr ?? "";
          if (!error) {
            resolve({
              code: 0,
              stdout: normalizedStdout,
              stderr: normalizedStderr,
            });
            return;
          }

          const maybeCode =
            typeof error === "object" && error && "code" in error
              ? error.code
              : undefined;

          resolve({
            code: typeof maybeCode === "number" ? maybeCode : 1,
            stdout: normalizedStdout,
            stderr:
              normalizedStderr ||
              (error instanceof Error ? error.message : String(error)),
          });
        },
      );
    });
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
    records: listFeatureRecordsFromWtList(result.stdout),
  };
}

export function listSwitchableFeatureRecords(
  wtListJson: string,
): FeatureRecord[] {
  return listSwitchableFeatureRecordsFromWtList(wtListJson);
}

export async function listSwitchableFeatureRecordsFromWorktree(
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
    records: listSwitchableFeatureRecords(result.stdout),
  };
}

export async function createFeatureWorktree(
  runWt: WtRunner,
  input: { branch: string; base: string },
): Promise<
  { ok: true; worktreePath: string } | { ok: false; message: string }
> {
  let result = await runWt(
    buildWtSwitchCreateArgs({
      branch: input.branch,
      base: input.base,
    }),
  );

  if (result.code !== 0) {
    const message = toErrorMessage(result, "wt switch failed");
    if (!isExistingBranchSwitchHint(message)) {
      return {
        ok: false,
        message,
      };
    }

    result = await runWt(
      buildWtSwitchArgs({
        branch: input.branch,
      }),
    );
    if (result.code !== 0) {
      return {
        ok: false,
        message: toErrorMessage(result, message),
      };
    }
  }

  const switchPath = getWorktreePath(result);
  if (switchPath) {
    return {
      ok: true,
      worktreePath: switchPath,
    };
  }

  return {
    ok: true,
    worktreePath: await resolveWorktreePathForBranch(runWt, {
      branch: input.branch,
      fallbackPath: "",
    }),
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
  const result = await runWt(
    buildWtSwitchArgs({
      branch: input.branch,
    }),
  );

  if (result.code !== 0) {
    return {
      ok: false,
      message: toErrorMessage(result, "wt switch failed"),
    };
  }

  const switchPath = getWorktreePath(result, input.fallbackWorktreePath);
  if (switchPath) {
    return {
      ok: true,
      worktreePath: switchPath,
    };
  }

  return {
    ok: true,
    worktreePath: await resolveWorktreePathForBranch(runWt, {
      branch: input.branch,
      fallbackPath: input.fallbackWorktreePath,
    }),
  };
}

export async function runWorktreeHook(
  runWt: WtRunner,
  input: {
    hookType: string;
    hook?: string | null;
    branch?: string | null;
  },
): Promise<{ ok: true } | { ok: false; message: string }> {
  const args = ["hook", input.hookType];

  const hook = trimToNull(input.hook ?? null);
  if (hook) {
    args.push(hook);
  }

  args.push("--yes");

  const result = await runWt(args);
  if (result.code !== 0) {
    return {
      ok: false,
      message: toErrorMessage(result, `wt hook ${input.hookType} failed`),
    };
  }

  return { ok: true };
}

export async function runCopyIgnoredToFeatureWorktree(
  runWt: WtRunner,
  input: {
    toBranch: string;
    fromBranch?: string | null;
    timeoutMs?: number;
  },
): Promise<{ ok: true } | { ok: false; message: string }> {
  const args = ["step", "copy-ignored", "--to", input.toBranch];

  const fromBranch = trimToNull(input.fromBranch ?? null);
  if (fromBranch) {
    args.push("--from", fromBranch);
  }

  const result = await runWt(args, {
    timeoutMs: input.timeoutMs,
  });

  if (result.code !== 0) {
    return {
      ok: false,
      message: toErrorMessage(result, "wt step copy-ignored failed"),
    };
  }

  return { ok: true };
}

export async function resolvePrimaryWorktreePathFromWt(
  runWt: WtRunner,
): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  const result = await runWt(["list", "--format", "json"]);
  if (result.code !== 0) {
    return {
      ok: false,
      message: toErrorMessage(result, "wt list failed"),
    };
  }

  const path = resolvePrimaryWorktreePathFromWtList(result.stdout);
  if (!path) {
    return {
      ok: false,
      message: "Failed to resolve primary worktree path from wt list output",
    };
  }

  return {
    ok: true,
    path,
  };
}
