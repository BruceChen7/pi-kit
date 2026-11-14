/**
 * safe-delete 的判定核心（ADR-0001 D4）。
 *
 * 这里只有"这条命令危不危险"：给定命令、cwd 和几个注入的端口，返回 Threat 列表。
 * 没有 fs、没有 subprocess、没有 UI、没有计时器 —— 目录大小由 `pathSize` 端口给，
 * 保护路径与 home 也由调用方给。人机确认与远程审批在 approval.ts，扩展接线在
 * safe-delete.ts。
 */

import * as path from "node:path";
import {
  analyzeShell,
  commandSegments,
  type EffectiveCommand,
  effectiveCommand,
  type ShellSegment,
} from "../shared/shell/index.ts";

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
//
// 每个 detector 读的是结构层给的一段命令（有效命令名 + 参数 + 重定向），不是原文
// 正则。`sudo` 由 wrappers 标出来；heredoc 正文根本不是命令段；`sh -c "rm -rf ~"`
// 的内层脚本由结构层摊平成独立命令段，所以也在判定范围内。

type SegmentInput = {
  segment: ShellSegment;
  command: EffectiveCommand;
  cwd: string;
  ports: AnalyzePorts;
};

const flagTexts = (command: EffectiveCommand): string[] =>
  command.args.map((arg) => arg.text).filter((text) => text.startsWith("-"));

const argTexts = (command: EffectiveCommand): string[] =>
  command.args.map((arg) => arg.text).filter((text) => !text.startsWith("-"));

const joinedFlags = (command: EffectiveCommand): string =>
  flagTexts(command).join(" ");

const commandBaseName = (name: string): string => path.basename(name);

const detectRmThreats = (input: SegmentInput): Threat[] => {
  const threats: Threat[] = [];
  const { command, cwd, ports } = input;
  if (command.name === null) return threats;

  const name = commandBaseName(command.name);
  if (name !== "rm" && name !== "rmdir") return threats;

  const flags = joinedFlags(command);
  const isRecursive = name === "rmdir" || /[rR]/.test(flags);
  const targets = argTexts(command);

  for (const target of targets) {
    // Wildcard explosion check
    if (hasWildcardExplosion({ targetPath: target })) {
      ports.trace?.("warn", "rm wildcard deletion detected", {
        targetPath: target,
        command: input.segment.raw,
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
        command: input.segment.raw,
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
          command: input.segment.raw,
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
};

const isFindDelete = (command: EffectiveCommand): boolean => {
  const args = command.args.map((arg) => arg.text);
  if (args.includes("-delete")) return true;
  const execIndex = args.indexOf("-exec");
  return (
    execIndex !== -1 && commandBaseName(args[execIndex + 1] ?? "") === "rm"
  );
};

const detectFindDeleteThreats = (input: SegmentInput): Threat[] => {
  const threats: Threat[] = [];
  const { command, cwd, ports } = input;
  if (command.name === null) return threats;
  if (commandBaseName(command.name) !== "find") return threats;
  if (!isFindDelete(command)) return threats;

  const [searchRoot = "."] = argTexts(command);
  const resolved = resolvePath({ targetPath: searchRoot, cwd, ports });

  if (isProtectedPath({ targetPath: searchRoot, cwd, ports })) {
    ports.trace?.("warn", "find -delete protected path detected", {
      searchRoot,
      resolved,
      command: input.segment.raw,
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
        command: input.segment.raw,
      });
      threats.push({
        description: `find -delete in large directory: ${resolved} (${formatBytes({ bytes: size })})`,
        severity: "high",
        paths: [resolved],
      });
    }
  }

  return threats;
};

const detectChmodChownThreats = (input: SegmentInput): Threat[] => {
  const threats: Threat[] = [];
  const { command, cwd, ports } = input;
  if (command.name === null) return threats;

  const name = commandBaseName(command.name);
  if (name !== "chmod" && name !== "chown") return threats;
  if (!/[rR]/.test(joinedFlags(command))) return threats;

  // 第一个非 flag 参数是 mode/owner，其余才是路径。
  const [, ...targets] = argTexts(command);
  for (const target of targets) {
    if (!isProtectedPath({ targetPath: target, cwd, ports })) continue;
    const resolved = resolvePath({ targetPath: target, cwd, ports });
    ports.trace?.("warn", "recursive chmod/chown protected path detected", {
      operation: name,
      targetPath: target,
      resolved,
      command: input.segment.raw,
    });
    threats.push({
      description: `Recursive ${name} on protected path: ${resolved}`,
      severity: "critical",
      paths: [resolved],
    });
  }

  return threats;
};

const detectGitCleanThreats = (input: SegmentInput): Threat[] => {
  const threats: Threat[] = [];
  const { command, ports } = input;
  if (command.name === null) return threats;
  if (commandBaseName(command.name) !== "git") return threats;

  const [subcommand, ...rest] = command.args.map((arg) => arg.text);
  if (subcommand !== "clean") return threats;

  const flags = rest.filter((text) => text.startsWith("-")).join("");
  const isForced = flags.includes("f");
  const isDirectories = flags.includes("d");
  const isIgnored = flags.includes("x") || flags.includes("X");

  if (isForced && (isDirectories || isIgnored)) {
    ports.trace?.("info", "git clean aggressive detected", {
      flags,
      command: input.segment.raw,
    });
    threats.push({
      description: `Aggressive git clean (${flags}) -- will permanently delete untracked${isIgnored ? " and gitignored" : ""} files${isDirectories ? " and directories" : ""}`,
      severity: "high",
      paths: ["."],
    });
  }

  return threats;
};

const detectPipedDeletionThreats = (input: SegmentInput): Threat[] => {
  const threats: Threat[] = [];
  const { command, ports } = input;
  if (command.name === null) return threats;
  if (commandBaseName(command.name) !== "xargs") return threats;
  if (!argTexts(command).some((text) => commandBaseName(text) === "rm")) {
    return threats;
  }

  ports.trace?.("info", "piped deletion via xargs rm detected", {
    command: input.segment.raw,
  });
  threats.push({
    description: "Piped deletion via xargs rm -- uncontrolled scope",
    severity: "high",
    paths: ["(piped input)"],
  });

  return threats;
};

const detectTruncationThreats = (input: SegmentInput): Threat[] => {
  const threats: Threat[] = [];
  const { segment, command, cwd, ports } = input;

  // `> file` 单独出现：这条命令的产物是一次截断。
  if (segment.words.length === 0) {
    for (const redirect of segment.redirects) {
      if (redirect.operator !== ">" || redirect.target === undefined) continue;
      if (redirect.targetDynamic) continue;
      const target = redirect.target.text;
      if (!isProtectedPath({ targetPath: target, cwd, ports })) continue;
      const resolved = resolvePath({ targetPath: target, cwd, ports });
      ports.trace?.("warn", "truncation of protected file detected", {
        targetPath: target,
        resolved,
        command: segment.raw,
      });
      threats.push({
        description: `Truncation of protected file: ${resolved}`,
        severity: "critical",
        paths: [resolved],
      });
    }
    return threats;
  }

  // `truncate` 命令
  if (command.name === null) return threats;
  if (commandBaseName(command.name) !== "truncate") return threats;

  const targets = argTexts(command);
  const target = targets[targets.length - 1];
  if (target === undefined) return threats;
  const resolved = resolvePath({ targetPath: target, cwd, ports });
  const size = ports.pathSize(resolved);
  if (size >= ports.sizeThreshold) {
    ports.trace?.("info", "truncating large file detected", {
      resolved,
      size,
      command: segment.raw,
    });
    threats.push({
      description: `Truncating large file: ${resolved} (${formatBytes({ bytes: size })})`,
      severity: "high",
      paths: [resolved],
    });
  }

  return threats;
};

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

const detectDeviceThreats = (input: SegmentInput): Threat[] => {
  const threats: Threat[] = [];
  const { command, ports } = input;
  if (command.name === null) return threats;

  const name = commandBaseName(command.name);
  const args = argTexts(command);

  // dd writing to a device
  if (name === "dd" && args.some((text) => text.startsWith("of=/dev/"))) {
    ports.trace?.("warn", "dd writing to device detected", {
      command: input.segment.raw,
    });
    threats.push({
      description: "dd writing directly to a device",
      severity: "critical",
      paths: ["(device)"],
    });
  }

  // mkfs / newfs / format 作为被执行程序，不是语言 formatter 的子命令。
  if (isFilesystemFormatCommand({ command: name })) {
    ports.trace?.("warn", "filesystem format command detected", {
      command: input.segment.raw,
    });
    threats.push({
      description: "Filesystem format command detected",
      severity: "critical",
      paths: ["(device)"],
    });
  }

  // mv to /dev/null
  if (name === "mv" && args.includes("/dev/null")) {
    ports.trace?.("warn", "mv to /dev/null detected", {
      command: input.segment.raw,
    });
    threats.push({
      description: "mv to /dev/null -- data will be destroyed",
      severity: "high",
      paths: ["/dev/null"],
    });
  }

  return threats;
};

// --- Main Analysis ---

const DETECTORS = [
  detectRmThreats,
  detectFindDeleteThreats,
  detectChmodChownThreats,
  detectGitCleanThreats,
  detectPipedDeletionThreats,
  detectTruncationThreats,
  detectDeviceThreats,
];

/**
 * 这条命令会毁掉什么？空数组表示"没有需要人确认的破坏性操作"。
 *
 * 判定按结构层的命令段走：heredoc 正文不是命令；`sh -c "…"` 的内层脚本由结构层
 * 摊平成独立命令段，因此也在判定范围内。
 */
export function analyzeCommand(input: DetectorInput): Threat[] {
  const { command, cwd, ports } = input;
  const allThreats: Threat[] = [];

  ports.trace?.("debug", "analyzing command", { command, cwd });

  const analysis = analyzeShell(command);
  for (const { segment } of commandSegments(analysis)) {
    const effective = effectiveCommand(segment);
    // sudo 让每条结论都更严重：它意味着没有二次确认的机会。
    const hasSudo = effective.wrappers.includes("sudo");

    for (const detect of DETECTORS) {
      const threats = detect({ segment, command: effective, cwd, ports });
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
