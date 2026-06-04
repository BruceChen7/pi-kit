// Session management — tmux session name encoding + lifecycle
// All metadata is encoded in the tmux session name itself (no external storage).
// Naming convention: pw__<dirname>__<branchname>

import { execSync } from "node:child_process";
import { resolve } from "node:path";
import {
  ensureSession,
  hasSession,
  killSession,
  listSessions,
} from "./tmux.js";

// ─── Types ─────────────────────────────────────────────────────

export type SessionStatus = "running" | "stopped" | "crashed" | "starting";

export interface SessionInfo {
  name: string; // full tmux session name: pw__<dirname>__<branch>
  dirname: string;
  branch: string;
  status: SessionStatus;
  attached: boolean; // whether a PTY bridge exists (filled by caller)
}

// ─── Naming ────────────────────────────────────────────────────

const PW_PREFIX = "pw__";

/**
 * Sanitize a name component for safe tmux session names.
 * tmux allows: [a-zA-Z0-9_.-] on all platforms.
 * We replace everything else with '_', then collapse consecutive '_'.
 */
function sanitizeComponent(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * Build a tmux session name from dirname and branch.
 *
 * Format: pw__<dirname>__<branchname>
 * Example: pw__my-app__main, pw__pi-kit__feature_add-auth
 */
export function getTmuxSessionName(dirname: string, branch: string): string {
  const d = sanitizeComponent(dirname) || "root";
  const b = sanitizeComponent(branch) || "main";
  return `${PW_PREFIX}${d}__${b}`;
}

/**
 * Parse a tmux session name back into dirname and branch.
 * Returns null if the name doesn't match the pw__*__* pattern.
 */
export function parseTmuxSessionName(
  name: string,
): { dirname: string; branch: string } | null {
  if (!name.startsWith(PW_PREFIX)) return null;

  const rest = name.slice(PW_PREFIX.length);
  // Split on first '__' to separate dirname from branch.
  // This is why dirname and branch must not contain '__'.
  const sepIdx = rest.lastIndexOf("__");
  if (sepIdx <= 0) return null; // No separator or empty dirname

  const dirname = rest.slice(0, sepIdx);
  const branch = rest.slice(sepIdx + 2);

  if (!dirname || !branch) return null;

  return { dirname, branch };
}

// ─── Status Detection ─────────────────────────────────────────

// Shell names that indicate the agent has likely exited
const SHELL_NAMES = new Set(["bash", "zsh", "sh", "fish", "dash", "ksh"]);

/**
 * Detect session status by checking tmux pane state.
 *
 * Crashed detection:
 * `ensureSession` creates the pane via `shell -c "exec <agentCommand>"`.
 * The shell replaces itself with the agent (`exec`), so there is _no_
 * fallback shell if the agent exits.  The only reliable crash signal is
 * an empty `pane_current_command` (the foreground process is gone).
 *
 * A shell foreground means either (a) the shell is still sourcing rc
 * files before exec'ing the agent, or (b) someone attached directly.
 * Neither case is "crashed".
 */
export function detectSessionStatus(name: string): SessionStatus {
  if (!name || !hasSession(name)) return "stopped";

  try {
    const escaped = name.replace(/'/g, "'\\''");
    const out = execSync(
      `tmux display-message -t '${escaped}' -p '#{pane_current_command}' 2>/dev/null`,
      { encoding: "utf-8", timeout: 5000 },
    );
    const cmd = out?.trim() || "";

    // No foreground process → pane is dead → agent exited
    if (!cmd) return "crashed";

    // Shell foreground: still sourcing rc files (before exec) or
    // someone attached directly.  Not crashed — treat as starting.
    if (SHELL_NAMES.has(cmd)) return "starting";

    // Non-shell foreground → the agent command is running
    return "running";
  } catch {
    return "starting";
  }
}

// ─── Git Branch Detection ─────────────────────────────────────

/**
 * Detect the current git branch in a working directory.
 * Returns 'main' if not a git repo or command fails.
 */
export function getGitBranch(cwd: string): string {
  try {
    const out = execSync("git rev-parse --abbrev-ref HEAD 2>/dev/null", {
      cwd: resolve(cwd),
      encoding: "utf-8",
      timeout: 5000,
    });
    const branch = out?.trim();
    if (branch && branch !== "HEAD") return branch;
    return "main";
  } catch {
    return "main";
  }
}

// ─── Session Listing ──────────────────────────────────────────

/**
 * List all pi-webterm managed sessions (names starting with pw__).
 */
export function listPwSessions(): SessionInfo[] {
  const allNames = listSessions();
  const pwNames = allNames.filter((n) => n.startsWith(PW_PREFIX));

  return pwNames.map((name) => {
    const parsed = parseTmuxSessionName(name);
    const status = detectSessionStatus(name);
    return {
      name,
      dirname: parsed?.dirname ?? name,
      branch: parsed?.branch ?? "?",
      status,
      attached: false, // caller fills this from activePtySessions
    };
  });
}

// ─── Session Creation ─────────────────────────────────────────

/**
 * Create a new pw__ session with auto-detected or provided dirname/branch.
 *
 * Returns the generated tmux session name.
 */
export function createPwSession(
  dirname: string,
  branch: string,
  cwd: string,
  agentCommand: string,
): string {
  const name = getTmuxSessionName(dirname, branch);
  ensureSession(name, cwd, agentCommand);
  return name;
}

// ─── Session Deletion ─────────────────────────────────────────

/**
 * Kill and remove a pw__ session.
 */
export function deletePwSession(name: string): void {
  if (!killSession(name)) {
    throw new Error(`Failed to delete tmux session: ${name}`);
  }
}
