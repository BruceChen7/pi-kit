/* biome-ignore-all lint/suspicious/noExplicitAny: pi JSON event payloads are intentionally dynamic. */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import {
  formatDuration,
  type LibrarianProgressState,
  sanitizeDisplayText,
  truncateInline,
} from "./shared.js";

const PROGRESS_HEARTBEAT_MS = 1500;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_SUBAGENT_STDOUT_BUFFER = 2 * 1024 * 1024;
const MAX_SUBAGENT_STDERR_BUFFER = 512 * 1024;
const MAX_QUERY_CHARS = 6000;

export type LibrarianEvent =
  | {
      kind: "tool_start";
      toolName: string;
      toolCallId: string;
      summary: string;
    }
  | {
      kind: "tool_end";
      toolName: string;
      toolCallId: string;
      summary: string;
      isError: boolean;
    }
  | { kind: "writing_phase" }
  | {
      kind: "assistant_message";
      text: string;
      details?: Record<string, unknown>;
    }
  | { kind: "result"; text: string };

export function parseLibrarianEvent(
  line: string,
  summarize?: (toolName: string, args: any) => string,
): LibrarianEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let event: any;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (event.type === "tool_execution_start") {
    const summary = summarize
      ? sanitizeDisplayText(
          summarize(String(event.toolName ?? "tool"), event.args),
          512,
        )
      : "";
    return {
      kind: "tool_start",
      toolName: String(event.toolName ?? "tool"),
      toolCallId: String(event.toolCallId ?? `tool-unknown`),
      summary,
    };
  }

  if (event.type === "tool_execution_end") {
    const summary = summarize
      ? sanitizeDisplayText(
          summarize(String(event.toolName ?? "tool"), event.args),
          512,
        )
      : "";
    return {
      kind: "tool_end",
      toolName: String(event.toolName ?? "tool"),
      toolCallId: String(event.toolCallId ?? ""),
      summary,
      isError: Boolean(event.isError),
    };
  }

  if (
    event.type === "message_update" &&
    (event.assistantMessageEvent?.type === "text_start" ||
      event.assistantMessageEvent?.type === "text_delta")
  ) {
    return { kind: "writing_phase" };
  }

  if (event.type === "message_end" && event.message?.role === "assistant") {
    const text = sanitizeDisplayText(
      (event.message.content ?? [])
        .filter((p: any) => p?.type === "text")
        .map((p: any) => p.text)
        .join("\n")
        .trim(),
    );

    if (text) {
      return {
        kind: "assistant_message",
        text,
        details: {
          phase: "assistant",
          stopReason: event.message.stopReason,
        },
      };
    }
  }

  if (event.type === "result" && typeof event.result === "string") {
    return { kind: "result", text: sanitizeDisplayText(event.result) };
  }

  return null;
}

export function renderProgress(state: LibrarianProgressState): string {
  const elapsed = Date.now() - state.startedAt;
  const frame =
    SPINNER_FRAMES[Math.floor(elapsed / 120) % SPINNER_FRAMES.length];

  const header =
    state.phase === "writing"
      ? `${frame} Librarian is drafting the final answer (${formatDuration(elapsed)})`
      : state.phase === "booting"
        ? `${frame} Librarian is starting up (${formatDuration(elapsed)})`
        : `${frame} Librarian is exploring repositories (${formatDuration(elapsed)})`;

  const counts =
    state.failedTools > 0
      ? `Tools: ${state.completedTools}/${state.startedTools} completed (${state.failedTools} failed)`
      : `Tools: ${state.completedTools}/${state.startedTools} completed`;

  const lines = [header, counts];
  if (state.currentAction)
    lines.push(`Current: ${truncateInline(state.currentAction)}`);
  if (state.recentActions.length > 0) {
    lines.push(
      `Recent: ${state.recentActions.map((a) => truncateInline(a, 42)).join(" • ")}`,
    );
  }

  return lines.join("\n");
}

export async function runLibrarianSubagent(
  cwd: string,
  prompt: string,
  options: {
    signal?: AbortSignal;
    onUpdate?: AgentToolUpdateCallback<Record<string, unknown>>;
    systemPrompt: string;
    summarizeToolCall: (toolName: string, args: any) => string;
    subagentTools: string[];
    extensionPath: string;
  },
): Promise<{ finalText: string; stderr: string }> {
  const query = prompt.trim();
  if (!query) {
    throw new Error("Query is required");
  }
  if (query.length > MAX_QUERY_CHARS) {
    throw new Error(`query exceeds ${MAX_QUERY_CHARS} characters`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-librarian-"));
  const promptPath = path.join(tmpDir, "system-prompt.md");
  fs.writeFileSync(promptPath, options.systemPrompt, {
    encoding: "utf8",
    mode: 0o600,
  });

  let lastAssistantText = "";
  let resultText = "";
  let stderr = "";

  const progress: LibrarianProgressState = {
    startedAt: Date.now(),
    phase: "booting",
    startedTools: 0,
    completedTools: 0,
    failedTools: 0,
    recentActions: [],
  };

  let lastProgressText = "";
  const emitProgress = (force = false) => {
    if (!options.onUpdate) return;

    const text = sanitizeDisplayText(renderProgress(progress), 6000);
    if (!force && text === lastProgressText) return;

    lastProgressText = text;
    options.onUpdate({
      content: [{ type: "text", text }],
      details: {
        phase: progress.phase,
        startedTools: progress.startedTools,
        completedTools: progress.completedTools,
        failedTools: progress.failedTools,
        currentAction: progress.currentAction,
      },
    });
  };

  try {
    const args = [
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "-e",
      options.extensionPath,
      "--append-system-prompt",
      promptPath,
      query,
    ];

    const exitCode = await new Promise<number>((resolve) => {
      const proc = spawn("pi", args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      let stdoutBuffer = "";
      let aborted = false;
      const heartbeat = setInterval(
        () => emitProgress(false),
        PROGRESS_HEARTBEAT_MS,
      );
      (heartbeat as any).unref?.();

      const activeActions = new Map<string, string>();

      const processLine = (line: string) => {
        const event = parseLibrarianEvent(line, options.summarizeToolCall);
        if (!event) return;

        switch (event.kind) {
          case "tool_start": {
            progress.phase = "exploring";
            progress.startedTools += 1;
            const toolCallId = event.toolCallId;
            activeActions.set(toolCallId, event.summary);
            progress.currentAction = event.summary;
            emitProgress(true);
            return;
          }
          case "tool_end": {
            progress.phase = "exploring";
            progress.completedTools += 1;
            if (event.isError) progress.failedTools += 1;

            const toolCallId = event.toolCallId;
            const action = activeActions.get(toolCallId) ?? event.summary;
            if (toolCallId) activeActions.delete(toolCallId);

            const recentItem = `${event.isError ? "✗" : "✓"} ${action}`;
            const first = progress.recentActions[0];
            if (first === recentItem) {
              progress.recentActions[0] = `${recentItem} ×2`;
            } else {
              const aggregated = first?.match(/^(.*) ×(\d+)$/);
              if (aggregated && aggregated[1] === recentItem) {
                const count = Number.parseInt(aggregated[2], 10);
                progress.recentActions[0] = `${recentItem} ×${Number.isFinite(count) ? count + 1 : 2}`;
              } else {
                progress.recentActions.unshift(recentItem);
                if (progress.recentActions.length > 4)
                  progress.recentActions.length = 4;
              }
            }

            progress.currentAction = undefined;
            emitProgress(true);
            return;
          }
          case "writing_phase": {
            if (progress.phase !== "writing") {
              progress.phase = "writing";
              progress.currentAction = "Synthesizing findings";
              emitProgress(true);
            }
            return;
          }
          case "assistant_message": {
            lastAssistantText = event.text;
            progress.phase = "writing";
            progress.currentAction = undefined;
            options.onUpdate?.({
              content: [{ type: "text", text: event.text }],
              details: {
                phase: "assistant",
                stopReason: event.details?.stopReason,
                startedTools: progress.startedTools,
                completedTools: progress.completedTools,
                failedTools: progress.failedTools,
              },
            });
            return;
          }
          case "result": {
            resultText = event.text;
            return;
          }
        }
      };

      emitProgress(true);

      proc.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk.toString();

        if (stdoutBuffer.length > MAX_SUBAGENT_STDOUT_BUFFER) {
          stderr += `\nsubagent output exceeded ${MAX_SUBAGENT_STDOUT_BUFFER} bytes`;
          proc.kill("SIGTERM");
          return;
        }

        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (chunk) => {
        const next = stderr + chunk.toString();
        if (next.length > MAX_SUBAGENT_STDERR_BUFFER) {
          stderr = `${next.slice(0, MAX_SUBAGENT_STDERR_BUFFER)}\n… [stderr truncated]`;
          proc.kill("SIGTERM");
          return;
        }

        stderr = next;
      });

      proc.on("close", (code) => {
        clearInterval(heartbeat);
        if (stdoutBuffer.trim()) processLine(stdoutBuffer);
        resolve(code ?? 0);
      });

      proc.on("error", () => {
        clearInterval(heartbeat);
        resolve(1);
      });

      if (options.signal) {
        const abort = () => {
          aborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5_000);
        };

        if (options.signal.aborted) abort();
        else options.signal.addEventListener("abort", abort, { once: true });
      }

      if (aborted) resolve(1);
    });

    if (exitCode !== 0) {
      throw new Error(stderr.trim() || `subagent exited with code ${exitCode}`);
    }

    const finalText = sanitizeDisplayText(
      resultText.trim() || lastAssistantText.trim(),
      120000,
    );
    if (!finalText) {
      throw new Error("librarian returned no output");
    }

    return { finalText, stderr };
  } finally {
    try {
      fs.unlinkSync(promptPath);
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
