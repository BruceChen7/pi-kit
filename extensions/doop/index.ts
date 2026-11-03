/**
 * doop, as a pi session's default canvas: `/doop bind|review|status|off`, the
 * live bits (`login`, `watch`, `cards`), and one read tool that turns the
 * canvas's comment log into a worklist.
 *
 * The design tools are not re-implemented here. They live in the doop MCP
 * server; this extension owns what MCP cannot: a bound canvas, a stable shape
 * for "what is open", a socket that tells us when something new lands, and the
 * local-agent slot that lets canvas cards run in this session.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { structuredResult } from "../shared/structured-result.js";
import {
  type AuthLoad,
  clearAuthRecord,
  defaultAuthPath,
  readAuthRecord,
  resolveEmail,
  resolvePassword,
  signIn,
  writeAuthRecord,
} from "./auth.js";
import { type CardJob, finishJob, pollJob, setCardsEnabled } from "./cards.js";
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
  drainPending,
  formatWake,
  type PendingQueue,
  pushPending,
} from "./messages.js";
import {
  connectWatch,
  type Schedule,
  type SocketFactory,
  type Timer,
  type WatchState,
} from "./watch.js";
import {
  formatWorklist,
  summarize,
  toWorklist,
  type Worklist,
} from "./worklist.js";

const STATUS_KEY = "doop";
const TOOL_NAME = "doop_comments";
const DEFAULT_CARD_POLL_MS = 10_000;

export type DoopConfigLoad =
  | { ok: true; config: DoopConfig; source: string }
  | { ok: false; message: string };

export type DoopExtensionOptions = {
  configPath?: () => string;
  authPath?: () => string;
  fetchImpl?: typeof fetch;
  retryDelayMs?: number;
  socketFactory?: SocketFactory;
  schedule?: Schedule;
  every?: (fn: () => void, ms: number) => Timer;
  cardPollMs?: number;
};

export function defaultConfigPath(): string {
  return (
    process.env.DOOP_CONFIG_PATH?.trim() ||
    path.join(os.homedir(), ".pi", "agent", "doop.json")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
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
  } catch (error) {
    /* Only a missing file falls back to the environment. A permission or IO
       error must surface: silently reading a different config hides it. */
    if (!isMissingFile(error)) throw error;
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
    watch: config.watch,
    cards: config.cards,
  };
  fs.writeFileSync(configPath, `${JSON.stringify(body, null, 2)}\n`, {
    mode: 0o600,
  });
  /* `mode` above only applies when the file is created; an existing config
     keeps whatever mode it already had. */
  fs.chmodSync(configPath, 0o600);
}

/** "doop U43rjP-JxT · 3 open · watch live" — everything we know without asking. */
export function statusLine(
  canvasId: string | undefined,
  list?: Worklist,
  extras: { watch?: WatchState; cards?: boolean } = {},
): string | undefined {
  if (!canvasId) return undefined;
  const parts = [`doop ${canvasId}`];
  if (list) parts.push(summarize(list));
  if (extras.watch && extras.watch !== "off")
    parts.push(`watch ${extras.watch}`);
  if (extras.cards) parts.push("cards on");
  return parts.join(" · ");
}

const commentAnchorSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("element"),
    frameId: Type.String(),
    elementId: Type.String(),
    html: Type.String(),
  }),
  Type.Object({
    kind: Type.Literal("frame"),
    frameId: Type.String(),
    x: Type.Number(),
    y: Type.Number(),
  }),
  Type.Object({
    kind: Type.Literal("canvas"),
    pageId: Type.String(),
    x: Type.Number(),
    y: Type.Number(),
  }),
]);

export const doopCommentsOutputSchema = Type.Object({
  /** omitted on failure: there is no canvas to name */
  canvasId: Type.Optional(Type.String()),
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

type DoopCommentsOutput = Static<typeof doopCommentsOutputSchema>;

const NO_CANVAS_MESSAGE =
  "no canvas bound: every call needs one. Run /doop bind <canvasId> (the id in the canvas URL) or pass canvas_id.";

const USAGE =
  "usage: /doop <bind <canvasId> | review | status | off | login | logout | watch <on|off> | cards <on|off>>";

/** Last assistant text, so a finished card can report what it did. */
function assistantText(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  if (message.role !== "assistant") return undefined;
  const content = message.content;
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((block: unknown): string[] => {
    if (!isRecord(block)) return [];
    return block.type === "text" && typeof block.text === "string"
      ? [block.text]
      : [];
  });
  const joined = parts.join("\n").trim();
  return joined === "" ? undefined : joined;
}

function cardMessage(job: CardJob, agentName: string): string {
  const header = `doop canvas card ${job.id} picked up by this session.`;
  return [
    header,
    job.system ? `\n${job.system}` : "",
    `\n${job.prompt}`,
    `\nFinish by editing the frames on the canvas; pass agent_name "${agentName}" on every doop call. The card closes itself when this run settles.`,
  ]
    .filter((part) => part !== "")
    .join("\n");
}

export function createDoopExtension(options: DoopExtensionOptions = {}) {
  const configPath = options.configPath ?? defaultConfigPath;
  const authPath = options.authPath ?? defaultAuthPath;
  const clientOptions: ClientOptions = {
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.retryDelayMs !== undefined
      ? { retryDelayMs: options.retryDelayMs }
      : {}),
  };

  return (pi: ExtensionAPI): void => {
    const load = (): DoopConfigLoad => readConfig(configPath());
    const loadAuth = (): AuthLoad => readAuthRecord(authPath());

    const runtime: {
      watch?: { stop: () => void };
      watchState: WatchState;
      pending: PendingQueue;
      cardsTimer?: Timer;
      /** true while a poll is in flight, so a slow tick cannot claim twice */
      polling: boolean;
      /** the card this session is running, plus the device that claimed it */
      card?: { job: CardJob; deviceId: string };
      lastAssistantText?: string;
    } = { watchState: "off", pending: [], polling: false };

    const saveConfig = (next: DoopConfig): void =>
      writeConfig(configPath(), next);

    const footer = (
      ctx: { ui: { setStatus: (key: string, text?: string) => void } },
      config: DoopConfig | undefined,
      list?: Worklist,
    ): void => {
      ctx.ui.setStatus(
        STATUS_KEY,
        statusLine(config?.canvasId, list, {
          watch: runtime.watchState,
          cards: runtime.cardsTimer !== undefined,
        }),
      );
    };

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

    const stopWatch = (): void => {
      runtime.watch?.stop();
      runtime.watch = undefined;
      runtime.watchState = "off";
    };

    const startWatch = (
      config: DoopConfig,
      ctx: {
        ui: {
          setStatus: (key: string, text?: string) => void;
          notify: (
            message: string,
            level?: "info" | "warning" | "error",
          ) => void;
        };
      },
    ): void => {
      stopWatch();
      if (!config.canvasId) {
        ctx.ui.notify(
          "no canvas bound: run /doop bind <canvasId> first",
          "warning",
        );
        return;
      }
      const auth = loadAuth();
      if (!auth.ok) {
        ctx.ui.notify(auth.error.message, "warning");
        return;
      }
      runtime.watch = connectWatch({
        baseUrl: config.baseUrl,
        canvasId: config.canvasId,
        cookie: auth.record.cookie,
        agentName: config.agentName,
        ...(options.socketFactory
          ? { socketFactory: options.socketFactory }
          : {}),
        ...(options.schedule ? { schedule: options.schedule } : {}),
        onPending: (item) => {
          runtime.pending = pushPending(runtime.pending, item);
          footer(ctx, config);
        },
        onState: (state) => {
          runtime.watchState = state;
          footer(ctx, config);
          if (state === "auth-required") {
            ctx.ui.notify(
              "doop session expired or was revoked — run /doop login",
              "warning",
            );
          }
          if (state === "denied") {
            ctx.ui.notify(
              "no access to that canvas — /doop bind another id",
              "error",
            );
          }
        },
      });
    };

    const stopCards = async (
      config: DoopConfig,
      disableRemote: boolean,
    ): Promise<void> => {
      runtime.cardsTimer?.cancel();
      runtime.cardsTimer = undefined;
      runtime.card = undefined;
      if (!disableRemote) return;
      const auth = loadAuth();
      if (!auth.ok) return;
      await setCardsEnabled(config, auth.record, false, options.fetchImpl);
    };

    const startCards = async (
      config: DoopConfig,
      ctx: {
        ui: {
          setStatus: (key: string, text?: string) => void;
          notify: (
            message: string,
            level?: "info" | "warning" | "error",
          ) => void;
        };
        isIdle?: () => boolean;
      },
    ): Promise<void> => {
      /* idempotent: a second `/doop cards on` must replace the first poll loop,
         not run beside it */
      await stopCards(config, false);
      const auth = loadAuth();
      if (!auth.ok) {
        ctx.ui.notify(auth.error.message, "warning");
        return;
      }
      const turnedOn = await setCardsEnabled(
        config,
        auth.record,
        true,
        options.fetchImpl,
      );
      if (!turnedOn.ok) {
        ctx.ui.notify(turnedOn.error.message, "error");
        return;
      }
      const deviceId = randomUUID();
      const every =
        options.every ??
        ((fn, ms) => {
          const handle = setInterval(fn, ms);
          return { cancel: () => clearInterval(handle) };
        });
      const poll = async (): Promise<void> => {
        if (runtime.card) return;
        /* a poll slower than the tick would otherwise start a second one and
           claim the same job again */
        if (runtime.polling) return;
        runtime.polling = true;
        try {
          const result = await pollJob(
            config,
            auth.record,
            deviceId,
            options.fetchImpl,
          );
          if (!result.ok) {
            ctx.ui.notify(result.error.message, "error");
            await stopCards(config, false);
            return;
          }
          if (!result.value.enabled) {
            ctx.ui.notify(
              "doop turned the local agent off — /doop cards on",
              "warning",
            );
            await stopCards(config, false);
            return;
          }
          const job = result.value.job;
          if (!job) return;
          runtime.card = { job, deviceId };
          runtime.lastAssistantText = undefined;
          const message = cardMessage(job, config.agentName);
          if (typeof ctx.isIdle === "function" && ctx.isIdle()) {
            pi.sendUserMessage(message);
          } else {
            pi.sendUserMessage(message, { deliverAs: "followUp" });
          }
        } finally {
          runtime.polling = false;
        }
      };
      void poll();
      runtime.cardsTimer = every(
        () => void poll(),
        options.cardPollMs ?? DEFAULT_CARD_POLL_MS,
      );
      footer(ctx, config);
    };

    const finishCard = async (
      ctx: {
        ui: {
          setStatus: (key: string, text?: string) => void;
          notify: (
            message: string,
            level?: "info" | "warning" | "error",
          ) => void;
        };
      },
      config: DoopConfig,
      aborted: boolean,
    ): Promise<void> => {
      const card = runtime.card;
      if (!card) return;
      runtime.card = undefined;
      const auth = loadAuth();
      if (!auth.ok) {
        ctx.ui.notify(auth.error.message, "warning");
        return;
      }
      const result = await finishJob(
        config,
        auth.record,
        card.deviceId,
        card.job.id,
        {
          success: !aborted,
          text:
            runtime.lastAssistantText ??
            (aborted ? "Run aborted." : "Finished."),
        },
        options.fetchImpl,
      );
      if (!result.ok) ctx.ui.notify(result.error.message, "error");
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
        const failed = (
          message: string,
          canvasId?: string,
        ): DoopCommentsOutput => {
          ctx.ui.setStatus(STATUS_KEY, statusLine(canvasId));
          return { items: [], skipped: 0, error: message };
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
        ctx.ui.setStatus(
          STATUS_KEY,
          statusLine(canvasId, read.list, {
            watch: runtime.watchState,
            cards: runtime.cardsTimer !== undefined,
          }),
        );
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
        "Bind a doop canvas, review its comments, sign in, or run watch/cards",
      getArgumentCompletions: (prefix: string) =>
        ["bind", "review", "status", "off", "login", "logout", "watch", "cards"]
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

        if (sub === "login") {
          const auth = loadAuth();
          const email =
            resolveEmail(auth.ok ? auth.record : undefined) ??
            (await ctx.ui.input("doop 账号邮箱"));
          if (!email) {
            ctx.ui.notify("login cancelled: no email", "warning");
            return;
          }
          const password =
            resolvePassword(email) ??
            (await ctx.ui.input(
              `doop 密码（会写进会话记录；建议改用 DOOP_PASSWORD 或 security add-generic-password -s pi-kit-doop -a ${email}）`,
            ));
          if (!password) {
            ctx.ui.notify("login cancelled: no password", "warning");
            return;
          }
          const signedIn = await signIn(
            config,
            { email, password },
            {
              ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
            },
          );
          if (!signedIn.ok) {
            ctx.ui.notify(signedIn.error.message, "error");
            return;
          }
          writeAuthRecord(authPath(), signedIn.record);
          ctx.ui.notify(`doop signed in as ${email}`, "info");
          if (config.watch) startWatch(config, ctx);
          footer(ctx, config);
          return;
        }

        if (sub === "logout") {
          clearAuthRecord(authPath());
          stopWatch();
          footer(ctx, config);
          ctx.ui.notify("doop signed out", "info");
          return;
        }

        if (sub === "bind") {
          const canvasId = rest[0]?.trim();
          if (!canvasId) {
            ctx.ui.notify("usage: /doop bind <canvasId>", "warning");
            return;
          }
          const next = withCanvasId(config, canvasId);
          saveConfig(next);
          if (config.watch) startWatch(next, ctx);
          else footer(ctx, next);
          ctx.ui.notify(`doop bound to canvas ${canvasId}`, "info");
          return;
        }

        if (sub === "off") {
          stopWatch();
          const next = withCanvasId(config);
          saveConfig(next);
          ctx.ui.setStatus(STATUS_KEY, undefined);
          ctx.ui.notify("doop canvas unbound", "info");
          return;
        }

        if (sub === "watch" || sub === "cards") {
          const on =
            rest[0] === "on" ? true : rest[0] === "off" ? false : undefined;
          if (on === undefined) {
            ctx.ui.notify(`usage: /doop ${sub} <on|off>`, "warning");
            return;
          }
          const next: DoopConfig =
            sub === "watch"
              ? { ...config, watch: on }
              : { ...config, cards: on };
          saveConfig(next);
          if (sub === "watch") {
            if (on) startWatch(next, ctx);
            else {
              stopWatch();
              footer(ctx, next);
            }
            ctx.ui.notify(`doop watch ${on ? "on" : "off"}`, "info");
          } else {
            if (on) await startCards(next, ctx);
            else {
              await stopCards(next, true);
              footer(ctx, next);
            }
            ctx.ui.notify(`doop cards ${on ? "on" : "off"}`, "info");
          }
          return;
        }

        if (sub === "review" || sub === "status") {
          const auth = loadAuth();
          const authNote = auth.ok ? "signed in" : "no cookie";
          if (!config.canvasId) {
            if (sub === "status") {
              ctx.ui.notify(
                `doop ${config.baseUrl} · canvas unbound · key ok · ${authNote} · watch ${runtime.watchState} · cards ${runtime.cardsTimer ? "on" : "off"}`,
                "info",
              );
              return;
            }
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
          footer(ctx, config, read.list);
          if (sub === "status") {
            ctx.ui.notify(
              `doop ${config.baseUrl} · canvas ${config.canvasId} · ${summarize(read.list)} · key ok · ${authNote} · watch ${runtime.watchState} · cards ${runtime.cardsTimer ? "on" : "off"}`,
              "info",
            );
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

        ctx.ui.notify(USAGE, "warning");
      },
    });

    pi.on("message_end", (event) => {
      const text = assistantText(event.message);
      if (text) runtime.lastAssistantText = text;
    });

    pi.on("agent_settled", (event, ctx) => {
      const loaded = load();
      if (!loaded.ok) return;
      const config = loaded.config;
      if (runtime.card) void finishCard(ctx, config, event.aborted);
      if (runtime.pending.length === 0) return;
      const { items } = drainPending(runtime.pending);
      runtime.pending = [];
      footer(ctx, config);
      pi.sendUserMessage(formatWake(items, config.canvasId ?? "unknown"));
    });

    pi.on("session_start", (_event, ctx) => {
      const loaded = load();
      if (!loaded.ok) return;
      footer(ctx, loaded.config);
      if (loaded.config.canvasId && loaded.config.watch) {
        startWatch(loaded.config, ctx);
      }
      /* `cards` is persisted, so a restart has to honour it: otherwise the
         footer claims cards on while nothing polls */
      if (loaded.config.cards) void startCards(loaded.config, ctx);
    });

    pi.on("session_shutdown", async () => {
      /* cancel before reading the config: a corrupt or missing doop.json must
         not leave the interval running into a dead session */
      const wasPolling = runtime.cardsTimer !== undefined;
      runtime.cardsTimer?.cancel();
      runtime.cardsTimer = undefined;
      runtime.card = undefined;
      stopWatch();
      const loaded = load();
      if (!loaded.ok || !wasPolling) return;
      await stopCards(loaded.config, true);
    });
  };
}

export default createDoopExtension();
