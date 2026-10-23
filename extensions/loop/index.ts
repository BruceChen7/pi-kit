import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { parseLoopArgs } from "./parse.js";
import {
  createInitialLoopState,
  decideNextStep,
  LOOP_ENTRY,
  LOOP_TURN_TYPE,
  type LoopState,
  loopFromBranch,
  type PredicateResult,
  renderLoopPrompt,
} from "./state.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile) as (
  file: string,
  args: string[],
  options: { cwd: string },
) => Promise<{ stdout: string }>;

const MAX_OUTPUT = 1024 * 1024;

/** 判据命令来自操作者，需要 shell 语义（`&&`、重定向）。空命令在解析期已拒。 */
export const runPredicate = async (
  until: { command: string; timeoutSec: number },
  cwd: string,
): Promise<PredicateResult> => {
  try {
    await execAsync(until.command, {
      cwd,
      timeout: until.timeoutSec * 1000,
      maxBuffer: MAX_OUTPUT,
    });
    return { exitCode: 0 };
  } catch (error) {
    const failure = error as {
      code?: number | string | null;
      killed?: boolean;
      message?: string;
    };
    if (failure.killed) {
      return { exitCode: null, timedOut: true };
    }
    if (typeof failure.code === "number") {
      return { exitCode: failure.code };
    }
    return { exitCode: null, error: failure.message ?? String(error) };
  }
};

const dirtyFileCount = async (cwd: string): Promise<number> => {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd,
    });
    return stdout.split("\n").filter((line) => line.trim() !== "").length;
  } catch {
    return 0;
  }
};

const branchEntries = (ctx: ExtensionContext): unknown[] => {
  const sessionManager = ctx.sessionManager as {
    getBranch?: () => unknown[];
    getEntries: () => unknown[];
  };
  return typeof sessionManager.getBranch === "function"
    ? sessionManager.getBranch()
    : sessionManager.getEntries();
};

export const formatLoopStatus = (state: LoopState | null): string => {
  if (!state) {
    return "loop: no run in this session";
  }
  const parts = [
    `loop: ${state.status} turn ${state.turn}/${state.maxTurns}`,
    `goal=${state.goal}`,
  ];
  if (state.until) {
    parts.push(`until=\`${state.until.command}\``);
  }
  if (
    state.lastPredicateResult?.exitCode !== null &&
    state.lastPredicateResult
  ) {
    parts.push(`last-exit=${state.lastPredicateResult.exitCode}`);
  }
  if (state.reason) {
    parts.push(`reason=${state.reason}`);
  }
  return parts.join(" | ");
};

export default function loop(pi: ExtensionAPI) {
  const readState = (ctx: ExtensionContext) =>
    loopFromBranch(branchEntries(ctx));

  const startTurn = (state: LoopState) => {
    pi.sendUserMessage(renderLoopPrompt(state, state.turn, null));
  };

  pi.registerCommand("loop", {
    description:
      "Bounded continuation: /loop run --until <cmd> [--max-turns n] <goal>",
    handler: async (args, ctx) => {
      let command: ReturnType<typeof parseLoopArgs>;
      try {
        command = parseLoopArgs(args);
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
        return;
      }

      switch (command.action) {
        case "status":
          ctx.ui.notify(formatLoopStatus(readState(ctx)), "info");
          return;

        case "stop": {
          const state = readState(ctx);
          if (!state) {
            ctx.ui.notify("loop: no run to stop", "info");
            return;
          }
          pi.appendEntry(LOOP_ENTRY, {
            ...state,
            status: "stopped",
            reason: "operator-stopped",
            updatedAt: new Date().toISOString(),
          });
          ctx.ui.notify("loop: stopped", "info");
          return;
        }

        case "resume": {
          const state = readState(ctx);
          if (!state) {
            ctx.ui.notify("loop: nothing to resume", "error");
            return;
          }
          const next: LoopState = {
            ...state,
            status: "running",
            maxTurns: command.maxTurns ?? state.maxTurns,
            turn: Math.min(state.turn, command.maxTurns ?? state.maxTurns),
            reason: "operator-resumed",
            updatedAt: new Date().toISOString(),
          };
          pi.appendEntry(LOOP_ENTRY, next);
          startTurn(next);
          return;
        }

        case "run": {
          const dirty = await dirtyFileCount(ctx.cwd);
          if (dirty > 0 && !command.allowDirty) {
            ctx.ui.notify(
              `loop: workspace has ${dirty} uncommitted change(s); commit them or pass --allow-dirty`,
              "error",
            );
            return;
          }
          const state = createInitialLoopState({
            goal: command.goal,
            maxTurns: command.maxTurns,
            until: command.until,
            allowDirty: command.allowDirty,
          });
          pi.appendEntry(LOOP_ENTRY, state);
          startTurn(state);
          return;
        }
      }
    },
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    const state = readState(ctx);
    if (state?.status !== "running") {
      return {};
    }

    // 中止或报错时不跑判据：那次运行没有产出可判的东西。
    const predicateResult =
      event.outcome === "completed" && state.until
        ? await runPredicate(state.until, ctx.cwd)
        : null;

    const { action, nextState } = decideNextStep(state, predicateResult, {
      outcome: event.outcome,
    });
    pi.appendEntry(LOOP_ENTRY, nextState);

    if (action === "stop") {
      return {};
    }
    return {
      entries: [
        {
          type: "custom_message" as const,
          customType: LOOP_TURN_TYPE,
          content: renderLoopPrompt(nextState, nextState.turn, predicateResult),
          display: false,
        },
      ],
      continue: true,
    };
  });

  // before_settle 在中止路径上可能不跑；这里补一条终态，避免状态卡在 running。
  pi.on("agent_settled", async (event, ctx) => {
    if (!event.aborted) {
      return;
    }
    const state = readState(ctx);
    if (state?.status !== "running") {
      return;
    }
    pi.appendEntry(LOOP_ENTRY, {
      ...state,
      status: "interrupted",
      reason: "operator-aborted",
      updatedAt: new Date().toISOString(),
    });
  });
}
