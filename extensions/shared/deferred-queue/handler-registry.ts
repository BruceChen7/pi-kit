import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { log } from "./logger.ts";
import { extractAssistantSummary } from "./summary-extractor.ts";
import type {
  ExecContext,
  ExecResult,
  SubagentOptions,
  SubagentResult,
} from "./types.ts";

/**
 * Execute a CLI command via spawn with a Promise wrapper.
 * Lightweight — no Pi process overhead.
 */
function createExecHandler(): ExecContext["exec"] {
  return (command: string, args?: string[]): Promise<ExecResult> =>
    new Promise((resolve) => {
      log.debug("exec: spawning", { command, args });
      const proc = spawn(command, args ?? [], {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      proc.on("error", (err) => {
        log.warn("exec: spawn error", {
          command,
          error: err.message,
          stdoutLength: stdout.length,
        });
        resolve({ code: 1, stdout, stderr });
      });
      proc.on("close", (code) => {
        log.debug("exec: completed", {
          command,
          exitCode: code,
          stdoutLength: stdout.length,
          stderrLength: stderr.length,
        });
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
}

/**
 * Execute a task in an isolated Pi subagent.
 * Spawns `pi` as a subprocess with minimal config (--no-session, --no-extensions, etc.)
 * and pipes the prompt via stdin.
 *
 * Reference: extensions/librarian/index.ts
 */
function createSubagentHandler(): ExecContext["subagent"] {
  const _SUBAGENT_EXTENSION_PATH = fileURLToPath(import.meta.url);

  return (options: SubagentOptions): Promise<SubagentResult> => {
    const {
      prompt,
      extensionPaths,
      timeoutMs = 30_000,
      spawnOptions,
    } = options;

    const args = [
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--no-extensions",
      "--no-themes",
    ];

    if (extensionPaths && extensionPaths.length > 0) {
      for (const ext of extensionPaths) {
        args.push("-e", ext);
      }
    }

    log.info("subagent: spawning pi process", {
      promptPreview: prompt.slice(0, 100),
      timeoutMs,
      argsCount: args.length,
    });

    return new Promise((resolve, reject) => {
      const proc = spawn("pi", args, {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        ...spawnOptions,
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill("SIGTERM");
        log.warn("subagent: timed out", { timeoutMs });
        reject(new Error(`subagent timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      proc.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        log.warn("subagent: process error", { error: err.message });
        reject(err);
      });

      proc.on("close", (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        log.info("subagent: completed", {
          exitCode,
          stdoutLength: stdout.length,
          stderrLength: stderr.length,
          summaryLength: extractAssistantSummary(stdout)?.length ?? 0,
        });
        resolve({
          stdout,
          stderr,
          exitCode: exitCode ?? -1,
          summary: extractAssistantSummary(stdout),
        });
      });

      // Write the prompt to stdin
      proc.stdin?.write(prompt);
      proc.stdin?.end();
    });
  };
}

/**
 * Notification handler placeholder.
 */
function createNotifyHandler(): ExecContext["notify"] {
  return (_title: string, _body: string) => {
    // Injected by the extension at runtime.
  };
}

/**
 * Create a full ExecContext with all handler implementations.
 */
export function createExecContext(overrides?: {
  exec?: ExecContext["exec"];
  subagent?: ExecContext["subagent"];
  notify?: ExecContext["notify"];
}): ExecContext {
  return {
    exec: overrides?.exec ?? createExecHandler(),
    subagent: overrides?.subagent ?? createSubagentHandler(),
    notify: overrides?.notify ?? createNotifyHandler(),
  };
}
