import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { type FeatureRecord, listFeatureRecords } from "./storage.js";
import {
  buildWtSwitchArgs,
  buildWtSwitchCreateArgs,
  parseWtJsonResult,
} from "./wt.js";

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

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

const parseWorktreePathFromWtList = (
  stdout: string,
  matcher: (item: Record<string, unknown>) => boolean,
): string | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) {
    return null;
  }

  for (const item of parsed) {
    if (!isRecord(item)) continue;
    if (!matcher(item)) continue;
    if (typeof item.path !== "string") continue;
    const path = trimToNull(item.path);
    if (path) {
      return path;
    }
  }

  return null;
};

const parsePrimaryWorktreePath = (stdout: string): string | null => {
  return parseWorktreePathFromWtList(stdout, (item) => item.is_main === true);
};

const parseWorktreePathForBranch = (
  stdout: string,
  branch: string,
): string | null => {
  const normalizedBranch = trimToNull(branch);
  if (!normalizedBranch) {
    return null;
  }

  return parseWorktreePathFromWtList(
    stdout,
    (item) => item.branch === normalizedBranch,
  );
};

const resolveWorktreePathForBranchFromWtList = async (
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
    parseWorktreePathForBranch(result.stdout, input.branch) ??
    input.fallbackPath
  );
};

export function createWtRunner(pi: ExtensionAPI, repoRoot: string): WtRunner {
  return async (
    args: string[],
    options: WtRunOptions = {},
  ): Promise<WtExecutionResult> => {
    const timeout =
      typeof options.timeoutMs === "number" &&
      Number.isFinite(options.timeoutMs) &&
      options.timeoutMs > 0
        ? options.timeoutMs
        : undefined;

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

export async function listFeatureRecordsFromWorktree(
  runWt: WtRunner,
  managedBranches: Iterable<string>,
): Promise<
  { ok: true; records: FeatureRecord[] } | { ok: false; message: string }
> {
  const result = await runWt(["list", "--format", "json"]);
  if (result.code !== 0) {
    return { ok: false, message: toErrorMessage(result, "wt list failed") };
  }

  return {
    ok: true,
    records: listFeatureRecords(result.stdout, managedBranches),
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

  const switchPath = getWorktreePath(result);
  if (switchPath) {
    return {
      ok: true,
      worktreePath: switchPath,
    };
  }

  return {
    ok: true,
    worktreePath: await resolveWorktreePathForBranchFromWtList(runWt, {
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
    worktreePath: await resolveWorktreePathForBranchFromWtList(runWt, {
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

  const path = parsePrimaryWorktreePath(result.stdout);
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
