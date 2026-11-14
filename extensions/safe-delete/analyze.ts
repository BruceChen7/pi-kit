/**
 * safe-delete 的判定核心（ADR-0001 D4）。
 *
 * 这里只有"这条命令危不危险"：给定命令、cwd 和几个注入的端口，返回 Threat 列表。
 * 没有 fs、没有 subprocess、没有 UI、没有计时器 —— 目录大小由 `pathSize` 端口给，
 * 保护路径与 home 也由调用方给。人机确认与远程审批在 approval.ts，扩展接线在
 * safe-delete.ts。
 */

import * as path from "node:path";
import { stripHeredocBodies } from "../shared/shell-text.ts";

export type Threat = {
  description: string;
  severity: "critical" | "high" | "medium";
  paths: string[];
};

export type AnalyzePorts = {
  /** 目标路径的字节数；测不出来返回 0。 */
  pathSize: (targetPath: string) => number;
  /** 需要人确认的保护路径（已展开 ~ 与环境变量）。 */
  protectedPaths: readonly string[];
  sizeThreshold: number;
  home: string;
  /** 判定过程的旁路记录；不注入就什么都不记。 */
  trace?: (
    level: "debug" | "info" | "warn",
    message: string,
    data?: Record<string, unknown>,
  ) => void;
};

export type DetectorInput = {
  command: string;
  cwd: string;
  ports: AnalyzePorts;
};

export const DEFAULT_SIZE_THRESHOLD = 100 * 1024 * 1024; // 100MB

/** 相对 home 的保护路径；`home` 由调用方给，这样判定不依赖进程环境。 */
export const protectedPathsFor = (home: string): string[] => [
  "/",
  "/bin",
  "/sbin",
  "/usr",
  "/etc",
  "/var",
  "/lib",
  "/System",
  "/Applications",
  "/Library",
  "/opt",
  "/private",
  home,
  path.join(home, "Documents"),
  path.join(home, "Desktop"),
  path.join(home, "Downloads"),
  path.join(home, "Pictures"),
  path.join(home, "Work"),
  path.join(home, ".ssh"),
  path.join(home, ".config"),
  path.join(home, ".local"),
  path.join(home, ".gnupg"),
];

// --- Path Utilities ---

export function resolvePath({
  targetPath,
  cwd,
  ports,
}: {
  targetPath: string;
  cwd: string;
  ports: AnalyzePorts;
}): string {
  let resolved = targetPath;

  // Expand ~ to home directory
  if (resolved.startsWith("~/") || resolved === "~") {
    resolved = resolved.replace("~", ports.home);
  }

  // Expand common env vars
  resolved = resolved.replace(/\$HOME/g, ports.home);
  resolved = resolved.replace(/\$\{HOME\}/g, ports.home);

  return path.resolve(cwd, resolved);
}

export function isProtectedPath({
  targetPath,
  cwd,
  ports,
}: {
  targetPath: string;
  cwd: string;
  ports: AnalyzePorts;
}): boolean {
  const resolved = resolvePath({ targetPath, cwd, ports });

  for (const protectedPath of ports.protectedPaths) {
    // Exact match or the target IS a parent of a protected path
    if (resolved === protectedPath) return true;

    // Target is a parent of a protected path (deleting it would destroy the protected path)
    if (protectedPath.startsWith(`${resolved}/`)) return true;
  }

  return false;
}

function hasWildcardExplosion({ targetPath }: { targetPath: string }): boolean {
  // Patterns like /*, ~/*, ./* at the root of dangerous locations
  const isDangerousGlob =
    targetPath === "/*" ||
    targetPath === "~/*" ||
    targetPath === "$HOME/*" ||
    targetPath === String.raw`\${HOME}/*` ||
    targetPath === "../*";

  // Recursive glob from a shallow path
  const isDeepGlob = /^(\/|~\/|\.\.\/)[^/]*\*/.test(targetPath);

  return isDangerousGlob || isDeepGlob;
}

export function formatBytes({ bytes }: { bytes: number }): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

// --- Command Parsing ---

/**
 * Strip sudo prefix from a command so we can analyze the actual operation.
 * sudo makes everything worse, so we flag it separately.
 */
export function stripSudo({ command }: { command: string }): {
  command: string;
  hasSudo: boolean;
} {
  const sudoPattern = /^sudo\s+(?:-[a-zA-Z]*\s+)*/;
  const match = command.match(sudoPattern);
  if (match) {
    return { command: command.slice(match[0].length), hasSudo: true };
  }
  return { command, hasSudo: false };
}

/**
 * Extract arguments from a command, filtering out flags.
 * Handles quoted strings.
 */
export function extractArgs({ argsString }: { argsString: string }): string[] {
  const args: string[] = [];
  // Simple tokenizer that respects quotes
  const tokens = argsString.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];

  for (const token of tokens) {
    // Skip flags
    if (token.startsWith("-")) continue;
    // Strip quotes
    args.push(token.replace(/^["']|["']$/g, ""));
  }

  return args;
}

/**
 * Splits a command string into individual commands separated by &&, ||, ;, or |.
 * Handles quoted strings so we do not split inside them.
 */
export function splitCommands({ command }: { command: string }): string[] {
  const commands: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let i = 0;

  while (i < command.length) {
    const char = command[i];
    const next = command[i + 1];

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += char;
      i++;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += char;
      i++;
      continue;
    }

    if (inSingleQuote || inDoubleQuote) {
      current += char;
      i++;
      continue;
    }

    // Command separators
    if (
      char === ";" ||
      char === "|" ||
      (char === "&" && next === "&") ||
      (char === "|" && next === "|")
    ) {
      if (current.trim()) commands.push(current.trim());
      current = "";
      // Skip double-char operators
      if ((char === "&" && next === "&") || (char === "|" && next === "|")) i++;
      i++;
      continue;
    }

    current += char;
    i++;
  }

  if (current.trim()) commands.push(current.trim());
  return commands;
}

// --- Threat Detectors ---

function detectRmThreats(input: DetectorInput): Threat[] {
  const threats: Threat[] = [];
  const { command, cwd, ports } = input;

  // `rm` only counts where a command can start: not in prose after `echo "…`
  // and not inside a quoted argument.
  const rmPattern =
    /(?:^|[;&|()\n]|\$\()\s*(rm|rmdir)\s+((?:-[a-zA-Z]+\s+)*)(.*)/;
  const match = command.match(rmPattern);
  if (!match) return threats;

  const flags = match[2] || "";
  const isRecursive = /r/.test(flags) || /R/.test(flags);
  const argsString = match[3];
  const targets = extractArgs({ argsString });

  for (const target of targets) {
    // Wildcard explosion check
    if (hasWildcardExplosion({ targetPath: target })) {
      ports.trace?.("warn", "rm wildcard deletion detected", {
        targetPath: target,
        command,
      });
      threats.push({
        description: `Wildcard deletion: rm ${flags}${target}`,
        severity: "critical",
        paths: [target],
      });
      continue;
    }

    const resolved = resolvePath({ targetPath: target, cwd, ports });

    // Protected path check
    if (isProtectedPath({ targetPath: target, cwd, ports })) {
      ports.trace?.("warn", "rm protected path detected", {
        targetPath: target,
        resolved,
        command,
      });
      threats.push({
        description: `Deletion targets protected path: ${resolved}`,
        severity: "critical",
        paths: [resolved],
      });
      continue;
    }

    // Recursive + force on existing directory = check size
    if (isRecursive) {
      const size = ports.pathSize(resolved);
      if (size >= ports.sizeThreshold) {
        ports.trace?.("info", "rm large recursive deletion detected", {
          resolved,
          size,
          command,
        });
        threats.push({
          description: `Large recursive deletion: ${resolved} (${formatBytes({ bytes: size })})`,
          severity: "high",
          paths: [resolved],
        });
      }
    }
  }

  return threats;
}

function detectFindDeleteThreats(input: DetectorInput): Threat[] {
  const threats: Threat[] = [];
  const { command, cwd, ports } = input;

  // find ... -delete or find ... -exec rm
  const isFindDelete =
    /\bfind\b/.test(command) &&
    (/\s-delete\b/.test(command) || /\s-exec\s+rm\b/.test(command));
  if (!isFindDelete) return threats;

  // Extract the search root from find
  const findMatch = command.match(/\bfind\s+(\S+)/);
  const searchRoot = findMatch ? findMatch[1] : ".";
  const resolved = resolvePath({ targetPath: searchRoot, cwd, ports });

  if (isProtectedPath({ targetPath: searchRoot, cwd, ports })) {
    ports.trace?.("warn", "find -delete protected path detected", {
      searchRoot,
      resolved,
      command,
    });
    threats.push({
      description: `find -delete rooted at protected path: ${resolved}`,
      severity: "critical",
      paths: [resolved],
    });
  } else {
    const size = ports.pathSize(resolved);
    if (size >= ports.sizeThreshold) {
      ports.trace?.("info", "find -delete large directory detected", {
        resolved,
        size,
        command,
      });
      threats.push({
        description: `find -delete in large directory: ${resolved} (${formatBytes({ bytes: size })})`,
        severity: "high",
        paths: [resolved],
      });
    }
  }

  return threats;
}

function detectChmodChownThreats(input: DetectorInput): Threat[] {
  const threats: Threat[] = [];
  const { command, cwd, ports } = input;

  const match = command.match(/\b(chmod|chown)\s+((?:-[a-zA-Z]+\s+)*)(.*)/);
  if (!match) return threats;

  const flags = match[2] || "";
  const isRecursive = /R/.test(flags) || /r/.test(flags);
  if (!isRecursive) return threats;

  const targets = extractArgs({ argsString: match[3] });
  // For chmod/chown, the first non-flag arg is the mode/owner, rest are paths
  // Skip the first arg (mode like 777 or owner like root:root)
  const paths = targets.slice(1);

  for (const target of paths) {
    if (isProtectedPath({ targetPath: target, cwd, ports })) {
      const resolved = resolvePath({ targetPath: target, cwd, ports });
      ports.trace?.("warn", "recursive chmod/chown protected path detected", {
        operation: match[1],
        targetPath: target,
        resolved,
        command,
      });
      threats.push({
        description: `Recursive ${match[1]} on protected path: ${resolved}`,
        severity: "critical",
        paths: [resolved],
      });
    }
  }

  return threats;
}

function detectGitCleanThreats(input: DetectorInput): Threat[] {
  const threats: Threat[] = [];
  const { command, ports } = input;

  // git clean -fdx or similar aggressive clean
  const match = command.match(/\bgit\s+clean\b\s+((?:-[a-zA-Z]+\s*)*)/);
  if (!match) return threats;

  const flags = match[1] || "";
  const isForced = /f/.test(flags);
  const isDirectories = /d/.test(flags);
  const isIgnored = /x/.test(flags) || /X/.test(flags);

  if (isForced && (isDirectories || isIgnored)) {
    ports.trace?.("info", "git clean aggressive detected", {
      flags: flags.trim(),
      command,
    });
    threats.push({
      description: `Aggressive git clean (${flags.trim()}) -- will permanently delete untracked${isIgnored ? " and gitignored" : ""} files${isDirectories ? " and directories" : ""}`,
      severity: "high",
      paths: ["."],
    });
  }

  return threats;
}

function detectPipedDeletionThreats(input: DetectorInput): Threat[] {
  const threats: Threat[] = [];
  const { command, ports } = input;

  // xargs rm, xargs del, etc.
  if (/\|\s*xargs\s+(?:.*\s)?rm\b/.test(command)) {
    ports.trace?.("info", "piped deletion via xargs rm detected", { command });
    threats.push({
      description: "Piped deletion via xargs rm -- uncontrolled scope",
      severity: "high",
      paths: ["(piped input)"],
    });
  }

  return threats;
}

function detectTruncationThreats(input: DetectorInput): Threat[] {
  const threats: Threat[] = [];
  const { command, cwd, ports } = input;

  // > file (redirect that truncates)
  // Only catch bare redirections at the start, not echo "x" > file (which is intentional writes)
  const truncateRedirect = command.match(/^>\s*(\S+)/);
  if (truncateRedirect) {
    const target = truncateRedirect[1];
    const resolved = resolvePath({ targetPath: target, cwd, ports });
    if (isProtectedPath({ targetPath: target, cwd, ports })) {
      ports.trace?.("warn", "truncation of protected file detected", {
        targetPath: target,
        resolved,
        command,
      });
      threats.push({
        description: `Truncation of protected file: ${resolved}`,
        severity: "critical",
        paths: [resolved],
      });
    }
  }

  // truncate command
  const truncateCmd = command.match(/\btruncate\b.*?(?:-s\s*\d+\s+)?(\S+)/);
  if (truncateCmd) {
    const target = truncateCmd[1];
    const resolved = resolvePath({ targetPath: target, cwd, ports });
    const size = ports.pathSize(resolved);
    if (size >= ports.sizeThreshold) {
      ports.trace?.("info", "truncating large file detected", {
        resolved,
        size,
        command,
      });
      threats.push({
        description: `Truncating large file: ${resolved} (${formatBytes({ bytes: size })})`,
        severity: "high",
        paths: [resolved],
      });
    }
  }

  return threats;
}

export function getCommandName({ command }: { command: string }): string {
  const firstToken = command.match(/^\s*(\S+)/)?.[1] ?? "";
  return path.basename(firstToken);
}

export function isFilesystemFormatCommand({
  command,
}: {
  command: string;
}): boolean {
  const commandName = getCommandName({ command });

  return (
    commandName === "format" ||
    commandName === "mkfs" ||
    commandName.startsWith("mkfs.") ||
    commandName === "newfs" ||
    commandName.startsWith("newfs_")
  );
}

function detectDeviceThreats(input: DetectorInput): Threat[] {
  const threats: Threat[] = [];
  const { command, ports } = input;

  // dd writing to a device
  if (/\bdd\b/.test(command) && /\bof=\/dev\//.test(command)) {
    ports.trace?.("warn", "dd writing to device detected", { command });
    threats.push({
      description: "dd writing directly to a device",
      severity: "critical",
      paths: ["(device)"],
    });
  }

  // mkfs / newfs / format as the invoked executable, not language formatter subcommands.
  if (isFilesystemFormatCommand({ command })) {
    ports.trace?.("warn", "filesystem format command detected", { command });
    threats.push({
      description: "Filesystem format command detected",
      severity: "critical",
      paths: ["(device)"],
    });
  }

  // mv to /dev/null
  if (/\bmv\b/.test(command) && /\/dev\/null/.test(command)) {
    ports.trace?.("warn", "mv to /dev/null detected", { command });
    threats.push({
      description: "mv to /dev/null -- data will be destroyed",
      severity: "high",
      paths: ["/dev/null"],
    });
  }

  return threats;
}

// --- Main Analysis ---

/**
 * 这条命令会毁掉什么？返回空数组表示"没有需要人确认的破坏性操作"。
 *
 * `scanned` 用的是剥掉 heredoc 正文之后的文本：一条命令**写下去**的脚本不是它
 * **执行**的脚本。
 */
export function analyzeCommand(input: DetectorInput): Threat[] {
  const { command, cwd, ports } = input;
  const allThreats: Threat[] = [];

  ports.trace?.("debug", "analyzing command", { command, cwd });

  const scanned = stripHeredocBodies(command);

  // 管道相关的检测必须在拆分前跑：splitCommands 会在 | 处断开，管道上下文就丢了。
  allThreats.push(
    ...detectPipedDeletionThreats({ command: scanned, cwd, ports }),
  );

  const subcommands = splitCommands({ command: scanned });

  for (const sub of subcommands) {
    const { command: stripped, hasSudo } = stripSudo({ command: sub });

    const detectors = [
      detectRmThreats,
      detectFindDeleteThreats,
      detectChmodChownThreats,
      detectGitCleanThreats,
      detectTruncationThreats,
      detectDeviceThreats,
    ];

    for (const detect of detectors) {
      const threats = detect({ command: stripped, cwd, ports });

      // Escalate severity if sudo is involved
      if (hasSudo) {
        for (const threat of threats) {
          threat.description = `[sudo] ${threat.description}`;
          threat.severity = "critical";
        }
      }

      allThreats.push(...threats);
    }
  }

  ports.trace?.("debug", "analysis complete", {
    command,
    threatCount: allThreats.length,
  });

  return allThreats;
}

// --- Formatting ---

export function formatThreats({ threats }: { threats: Threat[] }): string {
  const severityOrder: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
  };
  const sorted = [...threats].sort(
    (a, b) =>
      (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3),
  );

  const lines: string[] = [];

  for (const threat of sorted) {
    const tag =
      threat.severity === "critical"
        ? "[CRITICAL]"
        : threat.severity === "high"
          ? "[HIGH]"
          : "[MEDIUM]";

    lines.push(`${tag} ${threat.description}`);
  }

  return lines.join("\n");
}
