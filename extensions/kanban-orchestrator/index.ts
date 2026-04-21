import fs from "node:fs";
import path from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

import {
  createKanbanDaemon,
  type KanbanDaemon,
} from "../../kanban-daemon/daemon.js";
import { RequirementService } from "../../kanban-daemon/requirement-service.js";
import { getRepoRoot } from "../shared/git.js";
import { applyBoardTextPatch } from "./board-patch.js";
import {
  resolveKanbanCardContext,
  resolveKanbanCardContextByWorktreePath,
} from "./context.js";
import { createKanbanActionExecutors } from "./executors.js";
import {
  getFeatureBoardPath,
  readFeatureBoard,
} from "./feature-workflow-local.js";
import { importFeatureWorkflowModule } from "./feature-workflow-runtime.js";
import { createPiRuntimeAdapterWithDeps } from "./pi-runtime-adapter.js";
import { createPiRuntimeEventBridge } from "./pi-runtime-event-bridge.js";
import { KanbanOrchestratorService } from "./service.js";

const KANBAN_WORKFLOW_DIR = path.join("workitems", ".feature-workflow");
const GLOBAL_ACTIONS = new Set(["reconcile", "validate", "prune-merged"]);

type FeatureSwitchModule =
  typeof import("../feature-workflow/commands/feature-switch.js");

const daemonsByRepo = new Map<string, KanbanDaemon>();
const piRuntimeEventBridge = createPiRuntimeEventBridge();

export function getKanbanSessionRegistryPath(repoRoot: string): string {
  return path.join(repoRoot, KANBAN_WORKFLOW_DIR, "session-registry.json");
}

export function getKanbanAuditLogPath(repoRoot: string): string {
  return path.join(repoRoot, KANBAN_WORKFLOW_DIR, "execution.log.jsonl");
}

export function getKanbanLocalStatePath(repoRoot: string): string {
  return path.join(repoRoot, KANBAN_WORKFLOW_DIR, "kanban-state.sqlite");
}

function trimToNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseCommandArgs(rawArgs: string): string[] {
  const trimmed = rawArgs.trim();
  if (!trimmed) return [];

  const tokens = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return tokens.map((token) => token.replace(/^["']|["']$/g, ""));
}

function popOptionValue(tokens: string[], option: string): string | null {
  const index = tokens.findIndex(
    (token) => token === option || token.startsWith(`${option}=`),
  );
  if (index < 0) return null;

  const token = tokens[index] ?? "";
  if (token.startsWith(`${option}=`)) {
    tokens.splice(index, 1);
    return trimToNull(token.slice(option.length + 1));
  }

  const value = tokens[index + 1] ?? "";
  tokens.splice(index, 2);
  return trimToNull(value);
}

function parsePort(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
    return null;
  }
  return parsed;
}

function resolveRepoRootFromContext(
  ctx: ExtensionCommandContext,
): string | null {
  return getRepoRoot(ctx.cwd);
}

function createService(input: {
  pi: ExtensionAPI;
  ctx: ExtensionCommandContext;
  repoRoot: string;
}): KanbanOrchestratorService {
  const sessionRegistryPath = getKanbanSessionRegistryPath(input.repoRoot);

  return new KanbanOrchestratorService({
    actionExecutors: createKanbanActionExecutors({
      pi: input.pi,
      ctx: input.ctx,
      repoRoot: input.repoRoot,
      sessionRegistryPath,
      eventBridge: piRuntimeEventBridge,
    }),
    auditLogPath: getKanbanAuditLogPath(input.repoRoot),
    sessionRegistryPath,
    localStatePath: getKanbanLocalStatePath(input.repoRoot),
    repoRoot: input.repoRoot,
    boardPath: path.join("workitems", "features.kanban.md"),
    defaultAdapter: "pi",
  });
}

function createDaemonAdapters(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Record<string, ReturnType<typeof createPiRuntimeAdapterWithDeps>> {
  const sendUserMessage =
    typeof pi.sendUserMessage === "function"
      ? pi.sendUserMessage.bind(pi)
      : null;
  if (!sendUserMessage) {
    throw new Error("sendUserMessage is not available on ExtensionAPI");
  }

  const loadSwitchModule = async (): Promise<FeatureSwitchModule> =>
    importFeatureWorkflowModule<FeatureSwitchModule>(
      "commands/feature-switch.js",
    );

  return {
    pi: createPiRuntimeAdapterWithDeps({
      runFeatureSwitch: async (branch: string) =>
        (await loadSwitchModule()).runFeatureSwitchCommand(pi, ctx, [branch]),
      sendUserMessage: (text, options) => {
        sendUserMessage(text, options);
      },
      eventBridge: piRuntimeEventBridge,
    }),
  };
}

function notifyApiResponse(
  ctx: ExtensionCommandContext,
  response: {
    status: number;
    body: Record<string, unknown>;
  },
): void {
  const level =
    response.status >= 500
      ? "error"
      : response.status >= 400
        ? "warning"
        : "info";
  ctx.ui.notify(
    JSON.stringify({ status: response.status, ...response.body }),
    level,
  );
}

function resolveCardContext(
  repoRoot: string,
  cardQuery: string,
): ReturnType<typeof resolveKanbanCardContext> {
  return resolveKanbanCardContext({
    repoRoot,
    cardQuery,
    sessionRegistryPath: getKanbanSessionRegistryPath(repoRoot),
  });
}

function resolveCardContextByWorktreePath(
  repoRoot: string,
  worktreePath: string,
): ReturnType<typeof resolveKanbanCardContextByWorktreePath> {
  return resolveKanbanCardContextByWorktreePath({
    repoRoot,
    worktreePath,
    sessionRegistryPath: getKanbanSessionRegistryPath(repoRoot),
  });
}

function readBoardSnapshot(
  repoRoot: string,
): ReturnType<typeof readFeatureBoard> {
  return readFeatureBoard(repoRoot);
}

async function getOrCreateDaemon(input: {
  pi: ExtensionAPI;
  ctx: ExtensionCommandContext;
  repoRoot: string;
  host?: string;
  port?: number;
  token?: string;
  notifyStarted?: boolean;
}): Promise<KanbanDaemon> {
  const existing = daemonsByRepo.get(input.repoRoot);
  if (existing) {
    return existing;
  }

  const service = createService({
    pi: input.pi,
    ctx: input.ctx,
    repoRoot: input.repoRoot,
  });

  const host = input.host ?? "127.0.0.1";
  const token = input.token ?? "";
  const daemon = createKanbanDaemon({
    host,
    port: input.port ?? 0,
    token,
    workspaceId: path.basename(input.repoRoot),
    service,
    adapters: createDaemonAdapters(input.pi, input.ctx),
    boardPath: getFeatureBoardPath(input.repoRoot),
    resolveContext: (cardQuery) =>
      resolveCardContext(input.repoRoot, cardQuery),
    resolveContextByWorktreePath: (worktreePath) =>
      resolveCardContextByWorktreePath(input.repoRoot, worktreePath),
    applyBoardPatch: (nextBoardText) =>
      applyBoardTextPatch({
        repoRoot: input.repoRoot,
        nextBoardText,
      }),
    readBoard: () => readBoardSnapshot(input.repoRoot),
    requirementService: new RequirementService({
      repoRoot: input.repoRoot,
      workspaceId: path.basename(input.repoRoot),
    }),
  });

  await daemon.start();
  daemonsByRepo.set(input.repoRoot, daemon);

  if (input.notifyStarted) {
    input.ctx.ui.notify(
      JSON.stringify({
        running: true,
        baseUrl: daemon.baseUrl,
        token,
        host,
      }),
      "info",
    );
  }

  return daemon;
}

async function runKanbanActionExecuteCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string[],
): Promise<void> {
  const repoRoot = resolveRepoRootFromContext(ctx);
  if (!repoRoot) {
    ctx.ui.notify("Not a git repository", "error");
    return;
  }

  const daemon = await getOrCreateDaemon({
    pi,
    ctx,
    repoRoot,
  });

  const action = trimToNull(args[0]);
  if (!action) {
    ctx.ui.notify(
      "Usage: /kanban-action-execute <action> <card-id|title> [--prompt <text>]",
      "warning",
    );
    return;
  }

  const rest = args.slice(1);
  const prompt = popOptionValue(rest, "--prompt");
  const cardQuery = trimToNull(rest.join(" "));

  let cardId = "__global__";
  let worktreeKey = "__global__";

  if (!GLOBAL_ACTIONS.has(action)) {
    if (!cardQuery) {
      ctx.ui.notify("card-id|title is required for this action", "warning");
      return;
    }

    const contextResponse = daemon.getCardContext(cardQuery);
    if (contextResponse.status !== 200) {
      notifyApiResponse(ctx, contextResponse);
      return;
    }

    cardId = String(contextResponse.body.cardId ?? cardQuery);
    worktreeKey =
      String(contextResponse.body.worktreePath ?? "") ||
      String(contextResponse.body.branch ?? "") ||
      cardId;
  }

  let finalPrompt = prompt;
  if (action === "custom-prompt" && !finalPrompt && ctx.hasUI) {
    finalPrompt = trimToNull(await ctx.ui.input("Custom prompt:", ""));
  }

  const response = daemon.executeAction({
    action,
    cardId,
    worktreeKey,
    payload:
      action === "custom-prompt" && finalPrompt
        ? {
            prompt: finalPrompt,
          }
        : undefined,
  });

  notifyApiResponse(ctx, response);
}

async function runKanbanActionStatusCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string[],
): Promise<void> {
  const repoRoot = resolveRepoRootFromContext(ctx);
  if (!repoRoot) {
    ctx.ui.notify("Not a git repository", "error");
    return;
  }

  const daemon = await getOrCreateDaemon({
    pi,
    ctx,
    repoRoot,
  });

  const requestId = trimToNull(args[0]);
  if (!requestId) {
    ctx.ui.notify("Usage: /kanban-action-status <request-id>", "warning");
    return;
  }

  const response = daemon.getActionStatus(requestId);
  notifyApiResponse(ctx, response);
}

async function runKanbanCardContextCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string[],
): Promise<void> {
  const repoRoot = resolveRepoRootFromContext(ctx);
  if (!repoRoot) {
    ctx.ui.notify("Not a git repository", "error");
    return;
  }

  const cardQuery = trimToNull(args.join(" "));
  if (!cardQuery) {
    ctx.ui.notify("Usage: /kanban-card-context <card-id|title>", "warning");
    return;
  }

  const daemon = await getOrCreateDaemon({
    pi,
    ctx,
    repoRoot,
  });
  const response = daemon.getCardContext(cardQuery);
  notifyApiResponse(ctx, response);
}

async function runKanbanBoardPatchCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string[],
): Promise<void> {
  const repoRoot = resolveRepoRootFromContext(ctx);
  if (!repoRoot) {
    ctx.ui.notify("Not a git repository", "error");
    return;
  }

  const tokens = [...args];
  const filePathArg = popOptionValue(tokens, "--file");

  const boardText = filePathArg
    ? trimToNull(fs.readFileSync(path.resolve(ctx.cwd, filePathArg), "utf-8"))
    : trimToNull(tokens.join(" "));

  if (!boardText) {
    ctx.ui.notify(
      "Usage: /kanban-board-patch --file <markdown-file> (or pass board markdown directly)",
      "warning",
    );
    return;
  }

  const daemon = await getOrCreateDaemon({
    pi,
    ctx,
    repoRoot,
  });
  const response = daemon.patchBoard(boardText);
  notifyApiResponse(ctx, response);
}

async function runKanbanRuntimeStartCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string[],
): Promise<void> {
  const repoRoot = resolveRepoRootFromContext(ctx);
  if (!repoRoot) {
    ctx.ui.notify("Not a git repository", "error");
    return;
  }

  const existing = daemonsByRepo.get(repoRoot);
  if (existing) {
    ctx.ui.notify(
      JSON.stringify({
        running: true,
        baseUrl: existing.baseUrl,
        token: existing.token,
      }),
      "info",
    );
    return;
  }

  const tokens = [...args];
  const host = popOptionValue(tokens, "--host") ?? "127.0.0.1";
  const portArg = popOptionValue(tokens, "--port");
  const token = popOptionValue(tokens, "--token") ?? "";

  const port = parsePort(portArg);
  if (portArg && port === null) {
    ctx.ui.notify("Invalid --port value", "error");
    return;
  }

  await getOrCreateDaemon({
    pi,
    ctx,
    repoRoot,
    host,
    port: port ?? 0,
    token,
    notifyStarted: true,
  });
}

async function runKanbanRuntimeStatusCommand(
  ctx: ExtensionCommandContext,
): Promise<void> {
  const repoRoot = resolveRepoRootFromContext(ctx);
  if (!repoRoot) {
    ctx.ui.notify("Not a git repository", "error");
    return;
  }

  const entry = daemonsByRepo.get(repoRoot);
  if (!entry) {
    ctx.ui.notify(
      JSON.stringify({
        running: false,
      }),
      "info",
    );
    return;
  }

  ctx.ui.notify(
    JSON.stringify({
      running: true,
      baseUrl: entry.baseUrl,
      token: entry.token,
      host: entry.host,
    }),
    "info",
  );
}

function extractLastAssistantText(
  messages: Array<{ role?: string; content?: unknown }>,
): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "assistant") {
      continue;
    }

    const content = message.content;
    if (typeof content === "string" && content.trim().length > 0) {
      return content.trim();
    }

    if (Array.isArray(content)) {
      const parts = content
        .map((part) => {
          if (!part || typeof part !== "object") {
            return null;
          }

          const candidate =
            (part as { type?: unknown; text?: unknown }).type === "text"
              ? (part as { text?: unknown }).text
              : null;
          return typeof candidate === "string" ? candidate : null;
        })
        .filter((part): part is string => Boolean(part))
        .join("");
      if (parts.trim().length > 0) {
        return parts.trim();
      }
    }
  }

  return null;
}

function hasRuntimeTargetForSessionCwd(cwd: string): boolean {
  for (const daemon of daemonsByRepo.values()) {
    if (daemon.acceptsRuntimeWorktree(cwd)) {
      return true;
    }
  }

  return false;
}

async function runKanbanRuntimeStopCommand(
  ctx: ExtensionCommandContext,
): Promise<void> {
  const repoRoot = resolveRepoRootFromContext(ctx);
  if (!repoRoot) {
    ctx.ui.notify("Not a git repository", "error");
    return;
  }

  const entry = daemonsByRepo.get(repoRoot);
  if (!entry) {
    ctx.ui.notify(JSON.stringify({ running: false }), "info");
    return;
  }

  await entry.stop();
  daemonsByRepo.delete(repoRoot);
  ctx.ui.notify(JSON.stringify({ running: false }), "info");
}

export default function kanbanOrchestratorExtension(pi: ExtensionAPI): void {
  pi.registerCommand("kanban-action-execute", {
    description: "Execute orchestrated kanban action",
    handler: async (rawArgs, ctx) =>
      runKanbanActionExecuteCommand(pi, ctx, parseCommandArgs(rawArgs)),
  });

  pi.registerCommand("kanban-action-status", {
    description: "Read orchestrated action status by request id",
    handler: async (rawArgs, ctx) =>
      runKanbanActionStatusCommand(pi, ctx, parseCommandArgs(rawArgs)),
  });

  pi.registerCommand("kanban-card-context", {
    description: "Inspect merged board/sidecar/session context for a card",
    handler: async (rawArgs, ctx) =>
      runKanbanCardContextCommand(pi, ctx, parseCommandArgs(rawArgs)),
  });

  pi.registerCommand("kanban-board-patch", {
    description:
      "Apply explicit board markdown patch (no implicit action execution)",
    handler: async (rawArgs, ctx) =>
      runKanbanBoardPatchCommand(pi, ctx, parseCommandArgs(rawArgs)),
  });

  pi.registerCommand("kanban-runtime-start", {
    description: "Start embedded localhost kanban runtime HTTP server",
    handler: async (rawArgs, ctx) =>
      runKanbanRuntimeStartCommand(pi, ctx, parseCommandArgs(rawArgs)),
  });

  pi.registerCommand("kanban-runtime-status", {
    description: "Show embedded kanban runtime server status",
    handler: async (_rawArgs, ctx) => runKanbanRuntimeStatusCommand(ctx),
  });

  pi.registerCommand("kanban-runtime-stop", {
    description: "Stop embedded kanban runtime HTTP server",
    handler: async (_rawArgs, ctx) => runKanbanRuntimeStopCommand(ctx),
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!hasRuntimeTargetForSessionCwd(ctx.cwd)) {
      return;
    }

    piRuntimeEventBridge.emitForWorktreePath(ctx.cwd, {
      type: "agent-started",
    });
  });

  pi.on("message_update", async (event, ctx) => {
    if (event.assistantMessageEvent.type !== "text_delta") {
      return;
    }

    if (!hasRuntimeTargetForSessionCwd(ctx.cwd)) {
      return;
    }

    piRuntimeEventBridge.emitForWorktreePath(ctx.cwd, {
      type: "output-delta",
      chunk: event.assistantMessageEvent.delta,
    });
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!hasRuntimeTargetForSessionCwd(ctx.cwd)) {
      return;
    }

    piRuntimeEventBridge.emitForWorktreePath(ctx.cwd, {
      type: "agent-completed",
      summary: extractLastAssistantText(event.messages) ?? "agent completed",
    });
  });

  pi.on("session_shutdown", async () => {
    const entries = [...daemonsByRepo.values()];
    daemonsByRepo.clear();
    for (const entry of entries) {
      try {
        await entry.stop();
      } catch {
        // best effort shutdown
      }
    }
    piRuntimeEventBridge.clear();
  });
}
