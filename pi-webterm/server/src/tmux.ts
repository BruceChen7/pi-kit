import { execSync } from "node:child_process";
import type { IPty } from "node-pty";

// ─── Session Management (sync via execSync) ─────────────────────

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function tmuxTarget(name: string): string {
  return shellQuote(`=${name}`);
}

/** Check if a tmux session exists. */
export function hasSession(name: string): boolean {
  if (!name) return false;
  try {
    execSync(`tmux has-session -t ${tmuxTarget(name)} 2>/dev/null`, {
      stdio: "pipe",
    });
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

  const shell = process.env.SHELL || "/bin/bash";
  const commands = buildSessionCommands({ name, cwd, shell, agentCommand });
  for (const cmd of commands) {
    execSync(cmd.command, { stdio: "pipe", timeout: cmd.timeout });
  }
}

/** Kill a tmux session. Returns true only when the session is gone. */
export function killSession(name: string): boolean {
  if (!name) return false;

  try {
    execSync(`tmux kill-session -t ${tmuxTarget(name)} 2>/dev/null`, {
      stdio: "pipe",
    });
    return !hasSession(name);
  } catch {
    return false;
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

// ─── Command Construction (pure, no IO) ─────────────────────────

export interface SessionConfig {
  name: string;
  cwd: string;
  shell: string;
  agentCommand: string;
}

export interface TmuxCliCommand {
  command: string;
  timeout: number;
}

/**
 * Build the list of tmux CLI commands needed to create and configure a session.
 *
 * Pure function — no IO, no side effects. Returns a list of commands the shell
 * should execute in sequence.
 */
export function buildSessionCommands(config: SessionConfig): TmuxCliCommand[] {
  if (!config.name || !config.cwd) {
    throw new Error(
      `Invalid session params: name=${config.name}, cwd=${config.cwd}`,
    );
  }

  return [
    {
      command:
        `tmux new-session -d -s ${config.name} -c ${config.cwd} ` +
        `'${config.shell} -l -i -c "exec ${config.agentCommand}"'`,
      timeout: 10_000,
    },
    {
      command: `tmux set -t ${config.name} window-size largest 2>/dev/null`,
      timeout: 5_000,
    },
    {
      command: `tmux set -t ${config.name} status off`,
      timeout: 5_000,
    },
    {
      command: `tmux set -t ${config.name} history-limit 10000`,
      timeout: 5_000,
    },
  ];
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
