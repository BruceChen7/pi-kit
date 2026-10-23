/**
 * `git_read` 的命令白名单（纯函数）。
 *
 * 为什么要有这个工具：`extensions/subagent` 的 tools 是扁平白名单，pi 没有
 * 「只给 bash 的 git 子集」这种授权。只读审阅要么有完整 bash，要么有一个只能
 * 读历史的窄工具。这个文件就是那个窄边界。
 *
 * 设计：只放行 `git diff|show|log` 与不会改变行为、不会执行程序、不会写文件的
 * 选项。校验在这里，执行走 `execFile`，所以命令串永远不会到达 shell。
 */

export const DEFAULT_RANGE = "main...HEAD";
export const READ_SUBCOMMANDS = ["diff", "show", "log"] as const;
export type ReadSubcommand = (typeof READ_SUBCOMMANDS)[number];

const OPTIONS: Record<ReadSubcommand, ReadonlySet<string>> = {
  diff: new Set([
    "--stat",
    "--numstat",
    "--name-only",
    "--name-status",
    "--raw",
    "--patch",
    "-p",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--check",
    "--word-diff",
    "--ignore-space-change",
    "--ignore-all-space",
    "--ignore-blank-lines",
    "--minimal",
    "--patience",
    "--histogram",
    "--binary",
  ]),
  show: new Set([
    "--stat",
    "--numstat",
    "--name-only",
    "--name-status",
    "--patch",
    "-p",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--summary",
    "--abbrev-commit",
    "--no-renames",
  ]),
  log: new Set([
    "--stat",
    "--numstat",
    "--name-only",
    "--name-status",
    "--patch",
    "-p",
    "--no-color",
    "--oneline",
    "--decorate",
    "--graph",
    "--first-parent",
    "--merges",
    "--no-merges",
    "--reverse",
    "--date-order",
    "--topo-order",
    "--abbrev-commit",
  ]),
};

const VALUE_OPTIONS: Record<ReadSubcommand, readonly RegExp[]> = {
  diff: [
    /^--unified=\d{1,4}$/,
    /^-U\d{1,4}$/,
    /^--inter-hunk-context=\d{1,4}$/,
  ],
  show: [/^--unified=\d{1,4}$/, /^-U\d{1,4}$/],
  log: [/^-n\d{1,6}$/, /^--max-count=\d{1,6}$/, /^--skip=\d{1,6}$/],
};

/** 裸形式：值写在下一个 token。工具说明里给的就是 `-n 20`，那就得真支持。 */
const BARE_VALUE_OPTIONS: Record<ReadSubcommand, readonly string[]> = {
  diff: ["-U", "--unified", "--inter-hunk-context"],
  show: ["-U", "--unified"],
  log: ["-n", "--max-count", "--skip"],
};

const NUMERIC_VALUE = /^\d{1,6}$/;

// revision 令牌必须以字母数字开头：`-c`、`--exec` 这类因此永远进不来。
const REVISION = /^[A-Za-z0-9_][A-Za-z0-9_./~^@:{}+-]*$/;
// 路径只在 `--` 之后接受，字符集刻意收窄。
const SAFE_PATH = /^[A-Za-z0-9_@.:+,/-]+$/;

export type GitReadParse =
  | { ok: true; argv: string[]; defaultedRange: boolean }
  | { ok: false; reason: string };

const reject = (reason: string): GitReadParse => ({ ok: false, reason });

const isSubcommand = (value: string): value is ReadSubcommand =>
  (READ_SUBCOMMANDS as readonly string[]).includes(value);

const isValueOption = (subcommand: ReadSubcommand, token: string): boolean =>
  VALUE_OPTIONS[subcommand].some((pattern) => pattern.test(token));

export const parseGitReadCommand = (command: unknown): GitReadParse => {
  if (typeof command !== "string") {
    return reject("The command must be a string.");
  }
  const trimmed = command.trim();
  if (!trimmed) {
    return reject("The command is empty.");
  }
  if (/[\0\n\r]/.test(command)) {
    return reject(
      "The command must be a single line without control characters.",
    );
  }

  const tokens = trimmed.split(/\s+/);
  if (tokens[0] !== "git") {
    return reject(`Only git is allowed; refused: ${tokens[0]}`);
  }
  const subcommand = tokens[1] ?? "";
  if (!isSubcommand(subcommand)) {
    return reject(
      `Only git ${READ_SUBCOMMANDS.join(", git ")} are allowed; refused: git ${subcommand}`.trim(),
    );
  }

  const argv: string[] = [subcommand];
  let revision = false;
  let pathMode = false;
  let pathCount = 0;

  const rest = tokens.slice(2);
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] as string;
    if (token === "--") {
      if (pathMode) {
        return reject("Only one `--` separator is allowed.");
      }
      pathMode = true;
      argv.push(token);
      continue;
    }
    if (pathMode) {
      if (!SAFE_PATH.test(token)) {
        return reject(`Unsafe path argument: ${token}`);
      }
      pathCount += 1;
      argv.push(token);
      continue;
    }
    if (token.startsWith("-")) {
      if (OPTIONS[subcommand].has(token) || isValueOption(subcommand, token)) {
        argv.push(token);
        continue;
      }
      const value = rest[index + 1];
      if (
        BARE_VALUE_OPTIONS[subcommand].includes(token) &&
        value !== undefined &&
        NUMERIC_VALUE.test(value)
      ) {
        argv.push(token, value);
        index += 1;
        continue;
      }
      return reject(
        `Git option is not in the read-only whitelist (no --output, -c, --exec or --ext-diff): ${token}`,
      );
    }
    if (!REVISION.test(token)) {
      return reject(`Unsafe revision argument: ${token}`);
    }
    revision = true;
    argv.push(token);
  }

  if (pathMode && pathCount === 0) {
    return reject("`--` must be followed by a path.");
  }

  const defaultedRange = !revision;
  if (defaultedRange) {
    // 审阅默认对比分叉点；`show` 需要一个具体对象，所以用 HEAD。
    argv.splice(1, 0, subcommand === "show" ? "HEAD" : DEFAULT_RANGE);
  }

  return { ok: true, argv, defaultedRange };
};
