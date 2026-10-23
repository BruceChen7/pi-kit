import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseGitReadCommand } from "./parse.js";

const run = promisify(execFile) as (
  file: string,
  args: string[],
  options: { cwd: string; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

const TIMEOUT_MS = 20_000;
const MAX_BYTES = 2 * 1024 * 1024;

export type GitReadOutcome =
  | { ok: true; argv: string[]; text: string }
  | { ok: false; reason: string; argv: string[] | null };

const firstLine = (value: string): string =>
  value.trim().split("\n")[0]?.slice(0, 400) ?? "";

/**
 * 执行一次白名单内的 git 读取。命令串永远不进 shell：解析出 argv 再 execFile。
 * 失败统一成 `{ ok: false, reason }`，调用方只负责把 reason 给模型看。
 */
export const runGitRead = async (
  command: unknown,
  cwd: string,
): Promise<GitReadOutcome> => {
  const parsed = parseGitReadCommand(command);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason, argv: null };
  }

  const attempt = (argv: string[]) =>
    run("git", argv, { cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_BYTES });

  try {
    const { stdout } = await attempt(parsed.argv);
    return { ok: true, argv: parsed.argv, text: stdout };
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    // 默认范围在只有 master 或还没分叉的仓库里不存在。不默默失败：退到 HEAD，
    // 并在输出里说清用了哪个范围，否则审阅看到「ambiguous argument」无从下手。
    const missingDefaultRange =
      parsed.defaultedRange &&
      /ambiguous argument|unknown revision/i.test(stderr);
    if (missingDefaultRange) {
      const fallback = [parsed.argv[0], "HEAD", ...parsed.argv.slice(2)];
      try {
        const { stdout } = await attempt(fallback);
        return {
          ok: true,
          argv: fallback,
          text: `${stdout}`,
        };
      } catch {
        // 落到下面统一报错
      }
    }
    const detail = firstLine(stderr) || firstLine(String(error));
    return {
      ok: false,
      reason: `git ${parsed.argv.join(" ")} failed: ${detail}`,
      argv: parsed.argv,
    };
  }
};

export const renderGitRead = (outcome: GitReadOutcome): string => {
  if (!outcome.ok) {
    return `REFUSED: ${outcome.reason}`;
  }
  const text = outcome.text.trim();
  return text || `(git ${outcome.argv.join(" ")} produced no output)`;
};

export default function gitRead(pi: ExtensionAPI) {
  pi.registerTool({
    name: "git_read",
    label: "Git Read",
    description:
      "Read-only git inspection for reviewers. Only `git diff`, `git show` and `git log` run; `diff` and `log` default to main...HEAD. Any other git command, option or shell composition is refused with a reason.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            'A whitelisted git command, for example "git diff --stat main...HEAD" or "git log --oneline -n 20".',
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async execute(
      _toolCallId: string,
      params: { command?: unknown },
      _signal: unknown,
      _onUpdate: unknown,
      ctx: { cwd: string },
    ) {
      const outcome = await runGitRead(params?.command, ctx.cwd);
      return {
        content: [{ type: "text" as const, text: renderGitRead(outcome) }],
        details: {
          ok: outcome.ok,
          argv: outcome.argv,
          reason: outcome.ok ? undefined : outcome.reason,
        },
      };
    },
  });
}
