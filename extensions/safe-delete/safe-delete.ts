/**
 * Safe Delete Extension（Imperative Shell）
 *
 * 毁数据的 bash 命令要先问人。判定在 analyze.ts（纯函数 + 注入端口），
 * 审批在 approval.ts；这里只做接线：读命令、量目录大小、把结论交给流水线。
 *
 * 覆盖的破坏性操作见 analyze.ts 的各个 detector：rm/rmdir、find -delete、
 * 递归 chmod/chown、git clean -fdx、xargs rm、truncate、mv /dev/null、
 * dd 写设备、mkfs/format、通配符爆炸，以及被 sudo 包住的以上任意一条。
 */

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  ask,
  type GuardStage,
  installGuardPipeline,
  PASS,
  registerGuard,
} from "../shared/guard-pipeline.ts";
import { createLogger } from "../shared/logger.ts";
import {
  type AnalyzePorts,
  analyzeCommand,
  DEFAULT_SIZE_THRESHOLD,
  formatThreats,
  protectedPathsFor,
  type Threat,
} from "./analyze.ts";
import { requestApproval } from "./approval.ts";

let log: ReturnType<typeof createLogger> | null = null;

/** 保护路径在启动时展开一次：`~` 与环境变量都定下来。 */
const PROTECTED_PATHS: string[] = protectedPathsFor(os.homedir());

/**
 * 目录大小：`du` 是唯一能给出"删掉会损失多少"的办法，所以它是注入进判定
 * 核心的一个端口，而不是核心自己去调。
 */
function getPathSize({ targetPath }: { targetPath: string }): number {
  try {
    const stat = fs.statSync(targetPath);

    if (stat.isFile()) {
      return stat.size;
    }

    if (stat.isDirectory()) {
      try {
        const result = child_process.execSync(
          `du -s "${targetPath}" 2>/dev/null`,
          {
            encoding: "utf-8",
            timeout: 10000,
          },
        );
        const sizeKb = parseInt(result.split("\t")[0], 10);
        return sizeKb * 1024;
      } catch {
        return 0;
      }
    }
  } catch {
    return 0;
  }
  return 0;
}

const buildPorts = (): AnalyzePorts => ({
  pathSize: (targetPath) => getPathSize({ targetPath }),
  protectedPaths: PROTECTED_PATHS,
  sizeThreshold: DEFAULT_SIZE_THRESHOLD,
  home: os.homedir(),
  trace: (level, message, data) => log?.[level](message, data ?? {}),
});

const analyzeThreats = (command: string, cwd: string): Threat[] =>
  analyzeCommand({ command, cwd, ports: buildPorts() });

async function confirmDestructiveBashCommand(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  command: string,
): Promise<{ block: true; reason: string } | undefined> {
  const threats = analyzeThreats(command, ctx.cwd);

  if (threats.length === 0) return;

  const hasCritical = threats.some((threat) => threat.severity === "critical");
  log?.info("destructive command detected", {
    command,
    threatCount: threats.length,
    hasCritical,
  });
  const title = hasCritical
    ? "CRITICAL: Destructive command detected"
    : "Destructive command detected";

  const body = `${formatThreats({ threats })}\n\nCommand:\n  ${command}\n\nAllow this command to run?`;

  log?.info("prompting for destructive command confirmation", {
    command,
    threatCount: threats.length,
  });
  const isConfirmed = await requestApproval(pi, ctx, {
    title,
    body,
    command,
  });

  if (!isConfirmed) {
    log?.warn("destructive command blocked", {
      command,
      threatCount: threats.length,
    });
    return {
      block: true,
      reason: `User blocked destructive command.\n${formatThreats({ threats })}`,
    };
  }

  log?.info("destructive command allowed", {
    command,
    threatCount: threats.length,
  });
  return undefined;
}

const readBashCommand = (input: unknown): string | null => {
  if (typeof input !== "object" || input === null) return null;
  const command = (input as { command?: unknown }).command;
  return typeof command === "string" && command.trim() !== "" ? command : null;
};

/**
 * 流水线阶段：毁数据的 bash 命令要人确认。这是 ask 阶段 —— 反过来，
 * 任何 deny 阶段的结论都会让它不必再问用户。
 */
export const createSafeDeleteStage = (pi: ExtensionAPI): GuardStage => ({
  id: "safe-delete",
  kind: "ask",
  evaluate: async (call, env) => {
    // Only bash is gated. MCP calls are deliberately not confirmed here: the
    // annotation hints are self-declared and unverified, so the gate was a
    // prompt on every call rather than a real check.
    if (call.toolName !== "bash" || !env.hasUI) return PASS;
    const command = readBashCommand(call.input);
    if (command === null) return PASS;
    const blocked = await confirmDestructiveBashCommand(pi, env.ctx, command);
    return blocked ? ask("safe-delete", blocked.reason) : PASS;
  },
});

export default function (pi: ExtensionAPI) {
  log = createLogger("safe-delete", { stderr: null });
  log?.debug("extension initialized", { pid: process.pid });

  registerGuard(createSafeDeleteStage(pi));
  installGuardPipeline(pi);
}
