// Session management — tmux session name encoding + lifecycle
// All metadata is encoded in the tmux session name itself (no external storage).
// Naming convention: pw__<dirname>__<branchname>[__<hash>]
//
// Format history:
//   v1 (old): pw__<dirname>__<branch>
//   v2 (current): pw__<dirname>__<branch>__<hash(cwd,4)>
//     - hash is the first 4 hex chars of SHA256(cwd)
//     - added to disambiguate same dirname+branch from different filesystem paths
//     - parsing handles both v1 and v2 for backward compatibility

import { execSync } from "node:child_process";
import { resolve } from "node:path";
import {
  ensureSession,
  hasSession,
  killSession,
  listSessions,
} from "./tmux.js";
import { shortHash } from "./workspace.js";

// ─── Types ─────────────────────────────────────────────────────

export type SessionStatus = "running" | "stopped" | "crashed" | "starting";

export interface SessionInfo {
  name: string; // full tmux session name: pw__<dirname>__<branch> or pw__<dirname>__<branch>__<hash>
  dirname: string;
  branch: string;
  hash?: string; // short cwd hash (v2 only); undefined for v1 sessions
  status: SessionStatus;
  attached: boolean; // whether a PTY bridge exists (filled by caller)
}

// ─── Naming ────────────────────────────────────────────────────

const PW_PREFIX = "pw__";

/**
 * Sanitize a name component for safe tmux session names.
 * tmux allows: [a-zA-Z0-9_.-] on all platforms.
 * We replace everything else with '_', then collapse consecutive '_'.
 *
 * Collapsing consecutive underscores ensures `__` only ever appears
 * as a separator between components in the session name, never inside
 * a component.
 */
function sanitizeComponent(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * Build a tmux session name from dirname, branch, and optional cwd.
 *
 * Format: pw__<dirname>__<branch>[__<hash>]
 *   - hash is the first 4 hex chars of SHA256(cwd)
 *   - only appended when cwd is provided
 *
 * Examples:
 *   getTmuxSessionName("my-app", "main")           → pw__my-app__main
 *   getTmuxSessionName("my-app", "main", "/a/b")   → pw__my-app__main__a3f2
 *   getTmuxSessionName("pi-kit", "feat/auth", "/x") → pw__pi-kit__feat_auth__b1c2
 */
export function getTmuxSessionName(
  dirname: string,
  branch: string,
  cwd?: string,
): string {
  const d = sanitizeComponent(dirname) || "root";
  const b = sanitizeComponent(branch) || "main";
  const h = cwd ? `__${shortHash(cwd)}` : "";
  return `${PW_PREFIX}${d}__${b}${h}`;
}

/**
 * Parse a tmux session name back into dirname, branch, and optionally hash.
 *
 * Handles both v1 (pw__<d>__<b>) and v2 (pw__<d>__<b>__<h>) formats.
 * Since sanitizeComponent collapses __ to _, the __ separator is unambiguous
 * and we can safely split on "__" to extract components.
 *
 * Returns null if the name doesn't match the pw__*__(*) pattern.
 */
export function parseTmuxSessionName(
  name: string,
): { dirname: string; branch: string; hash?: string } | null {
  if (!name.startsWith(PW_PREFIX)) return null;

  const rest = name.slice(PW_PREFIX.length); // after "pw__"
  // Split on __ — components never contain __ due to sanitizeComponent
  const parts = rest.split("__");

  // v1: pw__<d>__<b> → rest = "<d>__<b>" → parts: ["<d>", "<b>"]
  // v2: pw__<d>__<b>__<h> → rest = "<d>__<b>__<h>" → parts: ["<d>", "<b>", "<h>"]
  if (parts.length < 2 || parts.length > 3) return null;

  const [dirname, branch, hash] = parts;
  if (!dirname || !branch) return null;

  return hash ? { dirname, branch, hash } : { dirname, branch };
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
      hash: parsed?.hash,
      status,
      attached: false, // caller fills this from activePtySessions
    };
  });
}

// ─── Session Creation ─────────────────────────────────────────

/**
 * Create a new pw__ session with auto-detected or provided dirname/branch.
 *
 * Generates a session name including a short hash of cwd for disambiguation
 * when the same dirname+branch points to different filesystem paths.
 *
 * Returns the generated tmux session name.
 */
export function createPwSession(
  dirname: string,
  branch: string,
  cwd: string,
  agentCommand: string,
): string {
  const name = getTmuxSessionName(dirname, branch, cwd);
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
