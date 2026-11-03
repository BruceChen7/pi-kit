/**
 * doop, as a pi session's default canvas: `/doop bind|review|status|off` plus
 * one read tool that turns the canvas's comment log into a worklist.
 *
 * The design tools are not re-implemented here. They live in the doop MCP
 * server; this extension only owns what MCP cannot: a bound canvas, a stable
 * shape for "what is open", and a footer line that says which canvas that is.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { structuredResult } from "../shared/structured-result.js";
import { type ClientOptions, getComments } from "./client.js";
import {
  applyEnvOverrides,
  configErrorText,
  configFromEnv,
  type DoopConfig,
  isConfigError,
  parseDoopConfig,
  withCanvasId,
} from "./config.js";
import {
  formatWorklist,
  summarize,
  toWorklist,
  type Worklist,
} from "./worklist.js";

const STATUS_KEY = "doop";
const TOOL_NAME = "doop_comments";

export type DoopConfigLoad =
  | { ok: true; config: DoopConfig; source: string }
  | { ok: false; message: string };

export type DoopExtensionOptions = {
  configPath?: () => string;
  fetchImpl?: typeof fetch;
  retryDelayMs?: number;
};

export function defaultConfigPath(): string {
  return (
    process.env.DOOP_CONFIG_PATH?.trim() ||
    path.join(os.homedir(), ".pi", "agent", "doop.json")
  );
}

/**
 * File first, environment second. A missing file is not an error: a one-off
 * `DOOP_AGENT_KEY=... pi` run should work without writing anything.
 */
export function readConfig(
  configPath: string,
  env: Record<string, string | undefined> = process.env,
): DoopConfigLoad {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch {
    const fromEnv = configFromEnv(env);
    return isConfigError(fromEnv)
      ? { ok: false, message: configErrorText(fromEnv) }
      : { ok: true, config: fromEnv, source: "environment" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      message: `doop config ${configPath}: not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  const config = parseDoopConfig(parsed, configPath);
  if (isConfigError(config)) {
    return { ok: false, message: configErrorText(config) };
  }
  return {
    ok: true,
    config: applyEnvOverrides(config, env),
    source: configPath,
  };
}

/** 0600: the file holds a bearer credential. */
export function writeConfig(configPath: string, config: DoopConfig): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const body = {
    baseUrl: config.baseUrl,
    agentKey: config.agentKey,
    ...(config.canvasId ? { canvasId: config.canvasId } : {}),
    agentName: config.agentName,
  };
  fs.writeFileSync(configPath, `${JSON.stringify(body, null, 2)}\n`, {
    mode: 0o600,
  });
}

/** "doop U43rjP-JxT · 3 open" — the canvas always, the count only when we just paid for it. */
export function statusLine(
  canvasId: string | undefined,
  list?: Worklist,
): string | undefined {
  if (!canvasId) return undefined;
  return list ? `doop ${canvasId} · ${summarize(list)}` : `doop ${canvasId}`;
}

const commentAnchorSchema = Type.Object({
  kind: Type.Union([
    Type.Literal("element"),
    Type.Literal("frame"),
    Type.Literal("canvas"),
  ]),
  frameId: Type.Optional(Type.String()),
  elementId: Type.Optional(Type.String()),
  html: Type.Optional(Type.String()),
  pageId: Type.Optional(Type.String()),
  x: Type.Optional(Type.Number()),
  y: Type.Optional(Type.Number()),
});

export const doopCommentsOutputSchema = Type.Object({
  canvasId: Type.String(),
  items: Type.Array(
    Type.Object({
      id: Type.String(),
      anchor: commentAnchorSchema,
      author: Type.String(),
      at: Type.Number(),
      text: Type.String(),
      replies: Type.Number(),
      forAgent: Type.Boolean(),
      targetAgent: Type.Optional(Type.String()),
    }),
  ),
  skipped: Type.Number(),
  /** set when the call failed; `items` is then empty */
  error: Type.Optional(Type.String()),
});

type DoopCommentsOutput = {
  canvasId: string;
  items: Worklist["items"];
  skipped: number;
  error?: string;
};

const NO_CANVAS_MESSAGE =
  "no canvas bound: every call needs one. Run /doop bind <canvasId> (the id in the canvas URL) or pass canvas_id.";

export function createDoopExtension(options: DoopExtensionOptions = {}) {
  const configPath = options.configPath ?? defaultConfigPath;
  const clientOptions: ClientOptions = {
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.retryDelayMs !== undefined
      ? { retryDelayMs: options.retryDelayMs }
      : {}),
  };

  return (pi: ExtensionAPI): void => {
    const load = (): DoopConfigLoad => readConfig(configPath());
    const readList = async (
      config: DoopConfig & { canvasId: string },
    ): Promise<
      { ok: true; list: Worklist } | { ok: false; message: string }
    > => {
      const comments = await getComments(
        config,
        config.canvasId,
        clientOptions,
      );
      if (!comments.ok) return { ok: false, message: comments.error.message };
      return {
        ok: true,
        list: toWorklist({
          canvasId: config.canvasId,
          comments: comments.value,
          agentName: config.agentName,
        }),
      };
    };

    pi.registerTool({
      name: TOOL_NAME,
      label: "Doop comments",
      description:
        "Read a doop canvas's open comments as a worklist: resolved threads, replies and this agent's own comments are already folded out. Read-only.",
      promptSnippet:
        "doop_comments: read the open comments on the bound doop canvas as an ordered worklist.",
      parameters: Type.Object({
        canvas_id: Type.Optional(
          Type.String({
            description: "Canvas id; defaults to the one bound with /doop bind",
          }),
        ),
      }),
      outputSchema: doopCommentsOutputSchema,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const failed = (message: string, canvasId = ""): DoopCommentsOutput => {
          ctx.ui.setStatus(STATUS_KEY, statusLine(canvasId || undefined));
          return { canvasId, items: [], skipped: 0, error: message };
        };
        const loaded = load();
        if (!loaded.ok) {
          return structuredResult<DoopCommentsOutput>(
            `${loaded.message}. Nothing was read.`,
            failed(loaded.message),
          );
        }
        const config = loaded.config;
        const canvasId = params.canvas_id?.trim() || config.canvasId;
        if (!canvasId) {
          return structuredResult<DoopCommentsOutput>(
            NO_CANVAS_MESSAGE,
            failed(NO_CANVAS_MESSAGE),
          );
        }
        const read = await readList({ ...config, canvasId });
        if (!read.ok) {
          return structuredResult<DoopCommentsOutput>(
            read.message,
            failed(read.message, canvasId),
          );
        }
        ctx.ui.setStatus(STATUS_KEY, statusLine(canvasId, read.list));
        return structuredResult<DoopCommentsOutput>(
          formatWorklist(read.list, config.agentName),
          {
            canvasId: read.list.canvasId,
            items: read.list.items,
            skipped: read.list.skipped,
          },
        );
      },
    });

    pi.registerCommand("doop", {
      description:
        "Bind a doop canvas, review its open comments, or show what is bound",
      getArgumentCompletions: (prefix: string) =>
        ["bind", "review", "status", "off"]
          .filter((value) => value.startsWith(prefix.trim()))
          .map((value) => ({ value, label: value })),
      handler: async (args, ctx) => {
        const [sub = "status", ...rest] = args.trim().split(/\s+/);
        const loaded = load();
        if (!loaded.ok) {
          ctx.ui.notify(loaded.message, "error");
          return;
        }
        const config = loaded.config;
        if (sub === "bind") {
          const canvasId = rest[0]?.trim();
          if (!canvasId) {
            ctx.ui.notify("usage: /doop bind <canvasId>", "warning");
            return;
          }
          writeConfig(configPath(), withCanvasId(config, canvasId));
          ctx.ui.setStatus(STATUS_KEY, statusLine(canvasId));
          ctx.ui.notify(`doop bound to canvas ${canvasId}`, "info");
          return;
        }
        if (sub === "off") {
          writeConfig(configPath(), withCanvasId(config));
          ctx.ui.setStatus(STATUS_KEY, undefined);
          ctx.ui.notify("doop canvas unbound", "info");
          return;
        }
        if (sub === "review" || sub === "status") {
          if (!config.canvasId) {
            ctx.ui.notify(
              "no canvas bound: run /doop bind <canvasId> first",
              "warning",
            );
            return;
          }
          const read = await readList({ ...config, canvasId: config.canvasId });
          if (!read.ok) {
            ctx.ui.notify(read.message, "error");
            return;
          }
          ctx.ui.setStatus(STATUS_KEY, statusLine(config.canvasId, read.list));
          if (sub === "status") {
            ctx.ui.notify(
              `doop ${config.baseUrl} · canvas ${config.canvasId} · agent ${config.agentName}`,
              "info",
            );
            ctx.ui.notify(
              `canvas ${config.canvasId}: ${summarize(read.list)}`,
              "info",
            );
            return;
          }
          if (typeof pi.sendUserMessage !== "function") {
            ctx.ui.notify(formatWorklist(read.list, config.agentName), "info");
            return;
          }
          const message = formatWorklist(read.list, config.agentName);
          if (typeof ctx.isIdle === "function" && ctx.isIdle()) {
            pi.sendUserMessage(message);
          } else {
            pi.sendUserMessage(message, { deliverAs: "followUp" });
          }
          return;
        }
        ctx.ui.notify(
          "usage: /doop <bind <canvasId> | review | status | off>",
          "warning",
        );
      },
    });

    pi.on("session_start", (_event, ctx) => {
      const loaded = load();
      if (!loaded.ok) return;
      ctx.ui.setStatus(STATUS_KEY, statusLine(loaded.config.canvasId));
    });
  };
}

export default createDoopExtension();
