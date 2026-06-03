import { execSync } from "node:child_process";
import type { IPty } from "node-pty";

// ─── Session Management (sync via execSync) ─────────────────────

/** Check if a tmux session exists. */
export function hasSession(name: string): boolean {
  if (!name) return false;
  try {
    execSync(`tmux has-session -t ${name} 2>/dev/null`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** List all tmux session names. */
export function listSessions(): string[] {
  try {
    const out = execSync(
      'tmux list-sessions -F "#{session_name}" 2>/dev/null',
      { stdio: "pipe", encoding: "utf-8" },
    );
    if (!out) return [];
    return out
      .trim()
      .split("\n")
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

/** Ensure a tmux session exists, creating it if necessary. */
export function ensureSession(
  name: string,
  cwd: string,
  agentCommand: string,
): void {
  if (hasSession(name)) return;

  if (!name || !cwd) {
    throw new Error(`Invalid session params: name=${name}, cwd=${cwd}`);
  }

  // Use a login (+interactive) shell so the user's profile/rc files are sourced.
  // Without this, env vars set in ~/.zshrc / ~/.bash_profile (e.g., OPENCODE_API_KEY)
  // are invisible to the agent process because `tmux new-session` runs the command
  // directly without sourcing shell rc files.
  const shell = process.env.SHELL || "/bin/bash";
  execSync(
    `tmux new-session -d -s ${name} -c ${cwd} '${shell} -l -i -c "exec ${agentCommand}"'`,
    { stdio: "pipe", timeout: 10_000 },
  );

  // Clean output: disable status bar
  execSync(`tmux set -t ${name} status off`, {
    stdio: "pipe",
    timeout: 5_000,
  });
  execSync(`tmux set -t ${name} history-limit 10000`, {
    stdio: "pipe",
    timeout: 5_000,
  });
}

/** Kill a tmux session. */
export function killSession(name: string): void {
  try {
    execSync(`tmux kill-session -t ${name} 2>/dev/null`, { stdio: "pipe" });
  } catch {
    // ignore
  }
}

/** Capture recent pane output (for history sync on reconnect). */
export function capturePane(name: string, lines: number = 200): string {
  try {
    const out = execSync(
      `tmux capture-pane -t ${name} -p -J -S -${lines} 2>/dev/null`,
      { stdio: "pipe", encoding: "utf-8", timeout: 5_000 },
    );
    return out || "";
  } catch {
    return "";
  }
}

// ─── PTY Attach (async via node-pty) ────────────────────────────

export interface PtySession {
  pty: IPty;
  sessionName: string;
  cols: number;
  rows: number;
}

/**
 * Attach to a tmux session via node-pty.
 * Spawns `tmux attach-session -t <name>` in a pseudo-terminal.
 */
export async function attachToSession(
  name: string,
  cols: number,
  rows: number,
): Promise<PtySession> {
  if (!name) {
    throw new Error("Session name is required");
  }

  const { spawn } = await import("node-pty");

  const pty = spawn("tmux", ["attach-session", "-t", name], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: process.cwd(),
    env: Object.assign({}, process.env) as Record<string, string>,
  });

  return { pty, sessionName: name, cols, rows };
}

/** Resize the PTY. */
export function resizePty(pty: IPty, cols: number, rows: number): void {
  pty.resize(cols, rows);
}

/** Kill/detach the PTY from the tmux session. */
export function detachPty(pty: IPty): void {
  try {
    pty.kill();
  } catch {
    // Already detached
  }
}
