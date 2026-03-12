/**
 * Desktop Notification Extension
 *
 * Sends a native desktop notification when the agent finishes and is waiting for input.
 * Uses OSC 777 escape sequence - no external dependencies.
 *
 * Supported terminals: Ghostty, iTerm2, WezTerm, rxvt-unicode
 * Not supported: Kitty (uses OSC 99), Terminal.app, Windows Terminal, Alacritty
 */

import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Markdown, type MarkdownTheme } from "@mariozechner/pi-tui";
import { createLogger, loadLogConfig } from "../shared/logger.ts";

export interface NotifyConfig {
  /** Enable/disable the notification extension (default: true) */
  enabled?: boolean;
}

export const DEFAULT_CONFIG: NotifyConfig = {
  enabled: true,
};

/**
 * Send a desktop notification via OSC 777 escape sequence.
 */
let log: ReturnType<typeof createLogger> | null = null;

async function initLogger(cwd: string): Promise<void> {
  const logConfig = await loadLogConfig(cwd);
  log = createLogger("notify", {
    logFilePath: logConfig.logFilePath,
    stderr: null,
    minLevel: logConfig.logLevel,
  });
}

const wrapForTmuxPassthrough = (payload: string): string => {
  const escaped = payload.split("\x1b").join("\x1b\x1b");
  // tmux DCS passthrough: ESC P tmux; <payload-with-doubled-ESC> ESC \
  return `\x1bPtmux;${escaped}\x1b\\`;
};

const notify = (title: string, body: string): void => {
  // OSC 777 format: ESC ] 777 ; notify ; title ; body BEL
  const osc777 = `\x1b]777;notify;${title};${body}\x07`;
  const inTmux = Boolean(process.env.TMUX);
  const payload = inTmux ? wrapForTmuxPassthrough(osc777) : osc777;

  log?.debug("writing notification payload", {
    protocol: "OSC777",
    inTmux,
    titleLength: title.length,
    bodyLength: body.length,
    payloadPreview: payload
      .split("\x1b")
      .join("<ESC>")
      .split("\x07")
      .join("<BEL>"),
    term: process.env.TERM,
    termProgram: process.env.TERM_PROGRAM,
    tty: Boolean(process.stdout.isTTY),
  });

  process.stdout.write(payload);
};

const execFileAsync = (
  file: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(file, args, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }

      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
      });
    });
  });

export const getTmuxWindowName = async (): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync("tmux", [
      "display-message",
      "-p",
      "#W",
    ]);
    const name = stdout.trim();
    const windowName = name ? name : null;
    log?.debug("tmux window name resolved", { windowName });
    return windowName;
  } catch (error) {
    log?.debug("tmux window name lookup failed", {
      error: String(error),
    });
    return null;
  }
};

export const resolveNotificationTitle = async (
  baseTitle: string,
  inTmux: boolean,
): Promise<string> => {
  if (!inTmux) {
    return baseTitle;
  }

  const windowName = await getTmuxWindowName();
  return windowName ? `${windowName} - ${baseTitle}` : baseTitle;
};

const isTextPart = (part: unknown): part is { type: "text"; text: string } =>
  Boolean(
    part &&
      typeof part === "object" &&
      "type" in part &&
      part.type === "text" &&
      "text" in part,
  );

const extractLastAssistantText = (
  messages: Array<{ role?: string; content?: unknown }>,
): string | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") {
      continue;
    }

    const content = message.content;
    if (typeof content === "string") {
      return content.trim() || null;
    }

    if (Array.isArray(content)) {
      const text = content
        .filter(isTextPart)
        .map((part) => part.text)
        .join("\n")
        .trim();
      return text || null;
    }

    return null;
  }

  return null;
};

const plainMarkdownTheme: MarkdownTheme = {
  heading: (text) => text,
  link: (text) => text,
  linkUrl: () => "",
  code: (text) => text,
  codeBlock: (text) => text,
  codeBlockBorder: () => "",
  quote: (text) => text,
  quoteBorder: () => "",
  hr: () => "",
  listBullet: () => "",
  bold: (text) => text,
  italic: (text) => text,
  strikethrough: (text) => text,
  underline: (text) => text,
};

const simpleMarkdown = (text: string, width = 80): string => {
  const markdown = new Markdown(text, 0, 0, plainMarkdownTheme);
  return markdown.render(width).join("\n");
};

const formatNotification = (
  text: string | null,
): { title: string; body: string } => {
  const simplified = text ? simpleMarkdown(text) : "";
  const normalized = simplified.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return { title: "Ready for input", body: "" };
  }

  const maxBody = 200;
  const body =
    normalized.length > maxBody
      ? `${normalized.slice(0, maxBody - 1)}…`
      : normalized;
  return { title: "π", body };
};

export default async function (pi: ExtensionAPI) {
  await initLogger(process.cwd());

  log?.debug("extension initialized", {
    pid: process.pid,
    term: process.env.TERM,
    termProgram: process.env.TERM_PROGRAM,
    tty: Boolean(process.stdout.isTTY),
  });

  pi.on("agent_end", async (event) => {
    const messages = event.messages ?? [];
    const last = messages.at(-1);
    const lastContentType =
      last && "content" in last
        ? Array.isArray(last.content)
          ? "array"
          : typeof last.content
        : null;
    log?.debug("agent_end received", {
      messageCount: messages.length,
      lastRole: last?.role ?? null,
      lastContentType,
    });

    const lastText = extractLastAssistantText(messages);
    log?.debug("assistant text extracted", {
      hasText: Boolean(lastText),
      preview: lastText ? lastText.slice(0, 120) : null,
    });

    const { title, body } = formatNotification(lastText);
    const inTmux = Boolean(process.env.TMUX);
    const resolvedTitle = await resolveNotificationTitle(title, inTmux);
    log?.debug("notification formatted", {
      title: resolvedTitle,
      bodyPreview: body.slice(0, 120),
      bodyLength: body.length,
      inTmux,
    });

    notify(resolvedTitle, body);
  });
}
