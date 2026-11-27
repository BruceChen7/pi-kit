/**
 * Safe Delete Extension
 *
 * Intercepts bash commands that could cause catastrophic data loss.
 * Goes beyond simple `rm` detection to catch the full spectrum of
 * destructive shell patterns.
 *
 * What it catches:
 *   - rm/rmdir on protected paths or large targets
 *   - find ... -delete / find ... -exec rm
 *   - Recursive chmod/chown on protected paths
 *   - git clean -fdx (untracked file wipe)
 *   - Piped deletions (xargs rm, xargs del)
 *   - File truncation (> file, truncate)
 *   - mv to /dev/null
 *   - dd writing to disk devices
 *   - mkfs/format on devices
 *   - sudo with any of the above
 *   - Wildcard explosions (rm -rf /*, rm -rf ~/*)
 */

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import {
  type PiKitSafeDeleteApprovalEvent,
  SAFE_DELETE_APPROVAL_CHANNEL,
} from "../shared/internal-events.ts";
import { createLogger } from "../shared/logger.ts";
import {
  analyzeShellCommand,
  type ShellCommandRef,
} from "../shared/shell-ast.ts";

// --- Configuration ---

const SIZE_THRESHOLD = 100 * 1024 * 1024; // 100MB

// Paths that should always require confirmation regardless of size.
// Resolved at startup so ~ and env vars are expanded.
const PROTECTED_PATHS: string[] = [
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
  os.homedir(),
  path.join(os.homedir(), "Documents"),
  path.join(os.homedir(), "Desktop"),
  path.join(os.homedir(), "Downloads"),
  path.join(os.homedir(), "Pictures"),
  path.join(os.homedir(), "Work"),
  path.join(os.homedir(), ".ssh"),
  path.join(os.homedir(), ".config"),
  path.join(os.homedir(), ".local"),
  path.join(os.homedir(), ".gnupg"),
];

let log: ReturnType<typeof createLogger> | null = null;

// --- Types ---

type Threat = {
  description: string;
  severity: "critical" | "high" | "medium";
  paths: string[];
};

// --- Path Utilities ---

function resolvePath({
  targetPath,
  cwd,
}: {
  targetPath: string;
  cwd: string;
}): string {
  let resolved = targetPath;

  // Expand ~ to home directory
  if (resolved.startsWith("~/") || resolved === "~") {
    resolved = resolved.replace("~", os.homedir());
  }

  // Expand common env vars
  resolved = resolved.replace(/\$HOME/g, os.homedir());
  resolved = resolved.replace(/\$\{HOME\}/g, os.homedir());

  return path.resolve(cwd, resolved);
}

/**
 * Dependency trees are untracked but expensive to rebuild: deleting one can
 * silently break every lint/test/typecheck script and the pre-push hook.
 * Protect the whole subtree, not just a directory literally named
 * `node_modules`, so `rm -rf node_modules/.bin` is gated too.
 */
function isDependencyPath(resolved: string): boolean {
  return resolved.split(path.sep).includes("node_modules");
}

function isProtectedPath({
  targetPath,
  cwd,
}: {
  targetPath: string;
  cwd: string;
}): boolean {
  const resolved = resolvePath({ targetPath, cwd });

  if (isDependencyPath(resolved)) return true;

  for (const protectedPath of PROTECTED_PATHS) {
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

function formatBytes({ bytes }: { bytes: number }): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

// --- Command Parsing ---

/**
 * Shell facts come from `shared/shell-ast.ts`. A single `CommandRef` already
 * accounts for `&&`/pipelines, wrappers (`sudo`, `xargs`, `find -exec`, `-c`)
 * and heredoc bodies, so the detectors below never scan command text.
 */

const flagArgs = (args: string[]): string[] =>
  args.filter((arg) => arg.startsWith("-"));

const plainArgs = (args: string[]): string[] =>
  args.filter((arg) => !arg.startsWith("-"));

const FIND_VALUE_FLAGS = new Set([
  "-maxdepth",
  "-mindepth",
  "-type",
  "-name",
  "-iname",
  "-path",
  "-ipath",
  "-regex",
  "-iregex",
  "-size",
  "-mtime",
  "-atime",
  "-ctime",
  "-user",
  "-group",
]);

/** `find <root> …`: skip flags (and their values) before the search root. */
const findSearchRoot = (args: string[]): string => {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (FIND_VALUE_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    if (!arg.startsWith("-")) return arg;
  }
  return ".";
};

// --- Threat Detectors ---

type DetectorInput = {
  ref: ShellCommandRef;
  original: string;
  cwd: string;
};

function detectRmThreats({ ref, original, cwd }: DetectorInput): Threat[] {
  const threats: Threat[] = [];
  const name = path.basename(ref.name);
  if (name !== "rm" && name !== "rmdir") return threats;

  const flags = flagArgs(ref.args).join(" ");
  const isRecursive = /[rR]/.test(flags);

  for (const target of plainArgs(ref.args)) {
    if (hasWildcardExplosion({ targetPath: target })) {
      log?.warn("rm wildcard deletion detected", {
        targetPath: target,
        command: original,
      });
      threats.push({
        description: `Wildcard deletion: ${name} ${flags} ${target}`,
        severity: "critical",
        paths: [target],
      });
      continue;
    }

    const resolved = resolvePath({ targetPath: target, cwd });
    if (isProtectedPath({ targetPath: target, cwd })) {
      log?.warn("rm protected path detected", {
        targetPath: target,
        resolved,
        command: original,
      });
      threats.push({
        description: isDependencyPath(resolved)
          ? `Deletion targets dependency directory: ${resolved}`
          : `Deletion targets protected path: ${resolved}`,
        severity: "critical",
        paths: [resolved],
      });
      continue;
    }

    if (isRecursive) {
      const size = getPathSize({ targetPath: resolved });
      if (size >= SIZE_THRESHOLD) {
        log?.info("rm large recursive deletion detected", {
          resolved,
          size,
          command: original,
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

function detectFindDeleteThreats({
  ref,
  original,
  cwd,
}: DetectorInput): Threat[] {
  const threats: Threat[] = [];
  if (path.basename(ref.name) !== "find") return threats;
  if (!ref.args.includes("-delete")) return threats;

  const searchRoot = findSearchRoot(ref.args);
  const resolved = resolvePath({ targetPath: searchRoot, cwd });

  if (isProtectedPath({ targetPath: searchRoot, cwd })) {
    log?.warn("find -delete protected path detected", {
      searchRoot,
      resolved,
      command: original,
    });
    threats.push({
      description: `find -delete rooted at protected path: ${resolved}`,
      severity: "critical",
      paths: [resolved],
    });
  } else {
    const size = getPathSize({ targetPath: resolved });
    if (size >= SIZE_THRESHOLD) {
      log?.info("find -delete large directory detected", {
        resolved,
        size,
        command: original,
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

function detectChmodChownThreats({
  ref,
  original,
  cwd,
}: DetectorInput): Threat[] {
  const threats: Threat[] = [];
  const name = path.basename(ref.name);
  if (name !== "chmod" && name !== "chown") return threats;

  const flags = flagArgs(ref.args).join(" ");
  if (!/[rR]/.test(flags)) return threats;

  // First non-flag arg is the mode/owner; the rest are paths.
  const paths = plainArgs(ref.args).slice(1);
  for (const target of paths) {
    if (isProtectedPath({ targetPath: target, cwd })) {
      const resolved = resolvePath({ targetPath: target, cwd });
      log?.warn("recursive chmod/chown protected path detected", {
        operation: name,
        targetPath: target,
        resolved,
        command: original,
      });
      threats.push({
        description: `Recursive ${name} on protected path: ${resolved}`,
        severity: "critical",
        paths: [resolved],
      });
    }
  }

  return threats;
}

function detectGitCleanThreats({ ref, original }: DetectorInput): Threat[] {
  const threats: Threat[] = [];
  if (path.basename(ref.name) !== "git" || ref.args[0] !== "clean") {
    return threats;
  }

  const flags = ref.args.slice(1).join("");
  const isForced = /f/.test(flags);
  const isDirectories = /d/.test(flags);
  const isIgnored = /[xX]/.test(flags);

  if (isForced && (isDirectories || isIgnored)) {
    log?.info("git clean aggressive detected", {
      flags: flags.trim(),
      command: original,
    });
    threats.push({
      description: `Aggressive git clean (${flags.trim()}) -- will permanently delete untracked${isIgnored ? " and gitignored" : ""} files${isDirectories ? " and directories" : ""}`,
      severity: "high",
      paths: ["."],
    });
  }

  return threats;
}

function detectPipedDeletionThreats({
  ref,
  original,
}: DetectorInput): Threat[] {
  const threats: Threat[] = [];
  const name = path.basename(ref.name);
  if (name !== "rm" && name !== "rmdir") return threats;
  if (!ref.wrappedBy.includes("xargs")) return threats;

  log?.info("piped deletion via xargs rm detected", {
    command: original,
  });
  threats.push({
    description: "Piped deletion via xargs rm -- uncontrolled scope",
    severity: "high",
    paths: ["(piped input)"],
  });
  return threats;
}

const OUTFILE_OPERATORS = new Set([">", ">>", "&>", "&>>", ">|"]);

function detectTruncationThreats({
  ref,
  original,
  cwd,
}: DetectorInput): Threat[] {
  const threats: Threat[] = [];

  // A bare `> file` is a redirect-only Command in the AST. `echo x > file`
  // keeps its command name and is an intentional write, so it is not gated.
  if (ref.name === "") {
    for (const redirect of ref.redirects) {
      if (!OUTFILE_OPERATORS.has(redirect.operator)) continue;
      const target = redirect.target;
      if (target === undefined) continue;
      const resolved = resolvePath({ targetPath: target, cwd });
      if (isProtectedPath({ targetPath: target, cwd })) {
        log?.warn("truncation of protected file detected", {
          targetPath: target,
          resolved,
          command: original,
        });
        threats.push({
          description: `Truncation of protected file: ${resolved}`,
          severity: "critical",
          paths: [resolved],
        });
      }
    }
    return threats;
  }

  if (path.basename(ref.name) !== "truncate") return threats;
  const target =
    ref.args[0] === "-s" ? ref.args[2] : (plainArgs(ref.args)[0] ?? "");
  const resolved = resolvePath({ targetPath: target, cwd });
  const size = getPathSize({ targetPath: resolved });
  if (size >= SIZE_THRESHOLD) {
    log?.info("truncating large file detected", {
      resolved,
      size,
      command: original,
    });
    threats.push({
      description: `Truncating large file: ${resolved} (${formatBytes({ bytes: size })})`,
      severity: "high",
      paths: [resolved],
    });
  }

  return threats;
}

function isFilesystemFormatCommand(name: string): boolean {
  return (
    name === "format" ||
    name === "mkfs" ||
    name.startsWith("mkfs.") ||
    name === "newfs" ||
    name.startsWith("newfs_")
  );
}

function detectDeviceThreats({ ref, original }: DetectorInput): Threat[] {
  const threats: Threat[] = [];
  const name = path.basename(ref.name);

  if (name === "dd" && ref.args.some((arg) => arg.startsWith("of=/dev/"))) {
    log?.warn("dd writing to device detected", { command: original });
    threats.push({
      description: "dd writing directly to a device",
      severity: "critical",
      paths: ["(device)"],
    });
  }

  // mkfs / newfs / format as the invoked executable, not language formatter subcommands.
  if (isFilesystemFormatCommand(name)) {
    log?.warn("filesystem format command detected", { command: original });
    threats.push({
      description: "Filesystem format command detected",
      severity: "critical",
      paths: ["(device)"],
    });
  }

  if (name === "mv" && ref.args.includes("/dev/null")) {
    log?.warn("mv to /dev/null detected", { command: original });
    threats.push({
      description: "mv to /dev/null -- data will be destroyed",
      severity: "high",
      paths: ["/dev/null"],
    });
  }

  return threats;
}

// --- Main Analysis ---

function analyzeCommand({
  command,
  cwd,
}: {
  command: string;
  cwd: string;
}): Threat[] {
  const allThreats: Threat[] = [];
  const analysis = analyzeShellCommand(command);

  log?.debug("analyzing command", { command, cwd });

  // A wrapper whose payload cannot be resolved may conceal any operation;
  // this gate is a confirmation prompt, so fail closed.
  if (
    analysis.errors.some((error) => error.startsWith("unresolvable wrapper"))
  ) {
    allThreats.push({
      description: "Unresolvable shell wrapper may hide a destructive command",
      severity: "critical",
      paths: ["(shell)"],
    });
  }

  const detectors = [
    detectRmThreats,
    detectFindDeleteThreats,
    detectChmodChownThreats,
    detectGitCleanThreats,
    detectPipedDeletionThreats,
    detectTruncationThreats,
    detectDeviceThreats,
  ];

  for (const ref of analysis.commands) {
    for (const detect of detectors) {
      const threats = detect({ ref, original: command, cwd });
      for (const threat of threats) {
        if (ref.wrappedBy.includes("sudo")) {
          threat.description = `[sudo] ${threat.description}`;
          threat.severity = "critical";
        }
        allThreats.push(threat);
      }
    }
  }

  log?.debug("analysis complete", {
    command,
    threatCount: allThreats.length,
  });

  return allThreats;
}

// --- Formatting ---

function formatThreats({ threats }: { threats: Threat[] }): string {
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

// --- Approval ---

type ApprovalRaceInput = {
  localDecision: Promise<boolean>;
  remoteDecisions: Array<Promise<boolean>>;
  localAbortController: AbortController;
};

async function waitForApprovalDecision({
  localDecision,
  remoteDecisions,
  localAbortController,
}: ApprovalRaceInput): Promise<boolean> {
  if (remoteDecisions.length === 0) {
    return await localDecision;
  }

  const result = await Promise.race([
    localDecision.then((decision) => ({ decision, source: "local" as const })),
    Promise.race(remoteDecisions).then((decision) => ({
      decision,
      source: "remote" as const,
    })),
  ]);

  if (result.source === "remote") {
    localAbortController.abort();
  }

  return result.decision;
}

// --- Extension ---

type ApprovalRequest = {
  title: string;
  body: string;
  /** Legacy field name of the approval event; a one-line handle for the request. */
  command: string;
};

/**
 * Imperative shell for one approval: the local dialog plus the remote-approval
 * event other pi-kit surfaces can answer. The bash analyzer and the MCP gate
 * share it so both report the same shape.
 */
async function requestApproval(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  request: ApprovalRequest,
): Promise<boolean> {
  const localAbortController = new AbortController();
  const localDecision = ctx.ui.confirm(request.title, request.body, {
    signal: localAbortController.signal,
  });
  const remoteDecisions: Array<Promise<boolean>> = [];
  pi.events.emit(SAFE_DELETE_APPROVAL_CHANNEL, {
    type: "safe-delete.approval",
    requestId: `safe_delete_${Date.now()}`,
    createdAt: Date.now(),
    command: request.command,
    title: request.title,
    body: request.body,
    contextPreview: [],
    fullContextLines: [],
    localDecision,
    attachRemoteDecision: (decision: Promise<boolean>) => {
      remoteDecisions.push(decision);
    },
    ctx,
  } satisfies PiKitSafeDeleteApprovalEvent);

  return await waitForApprovalDecision({
    localDecision,
    remoteDecisions,
    localAbortController,
  });
}

async function confirmDestructiveBashCommand(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  event: { input: { command: string } },
): Promise<{ block: true; reason: string } | undefined> {
  const command = event.input.command;
  const threats = analyzeCommand({ command, cwd: ctx.cwd });

  if (threats.length === 0) return;

  const hasCritical = threats.some((t) => t.severity === "critical");
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

export default function (pi: ExtensionAPI) {
  log = createLogger("safe-delete", { stderr: null });
  log?.debug("extension initialized", { pid: process.pid });

  // Only bash is gated. MCP calls are deliberately not confirmed here: the
  // annotation hints are self-declared and unverified, so the gate was a
  // prompt on every call rather than a real check.
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    if (!ctx.hasUI) return;
    return await confirmDestructiveBashCommand(pi, ctx, event);
  });
}
