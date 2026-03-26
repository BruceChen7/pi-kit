import type {
  AgentToolUpdateCallback,
  BashToolDetails,
  BashToolInput,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  createBashToolDefinition,
  createLocalBashOperations,
} from "@mariozechner/pi-coding-agent";
import { loadSettings } from "./settings.ts";

export type BashHookSource = "tool" | "user_bash";

export type BashHookInput = {
  command: string;
  cwd: string;
  ctx: ExtensionContext;
  source: BashHookSource;
};

export type BashHookResponse = {
  command: string;
};

export type BashHook = (
  input: BashHookInput,
) => BashHookResponse | undefined | Promise<BashHookResponse | undefined>;

export type RegisteredBashHook = {
  id: string;
  hook: BashHook;
};

type BashHookEntry = RegisteredBashHook & {
  index: number;
};

type HookOrderResult = {
  hasValue: boolean;
  order: string[];
};

type BashHookState = {
  hooks: BashHookEntry[];
  hookIndex: number;
  lastRun: BashHookRun | null;
};

type BashHookRun = {
  command: string;
  resolved: string;
  applied: string[];
  source: BashHookSource;
  cwd: string;
  timestamp: number;
};

const GLOBAL_HOOK_STATE_KEY = "__pi_bash_hook_state__";

const ensureHookState = (): BashHookState => {
  const container = globalThis as Record<string, unknown>;
  const existing = container[GLOBAL_HOOK_STATE_KEY];

  if (existing && typeof existing === "object") {
    const state = existing as BashHookState;
    if (Array.isArray(state.hooks) && typeof state.hookIndex === "number") {
      return state;
    }
  }

  const state: BashHookState = { hooks: [], hookIndex: 0, lastRun: null };
  container[GLOBAL_HOOK_STATE_KEY] = state;
  return state;
};

const hookState = ensureHookState();
const hooks = hookState.hooks;

const nextHookIndex = (): number => {
  const index = hookState.hookIndex;
  hookState.hookIndex += 1;
  return index;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeHookOrder = (value: unknown): string[] => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  return [];
};

const extractHookOrder = (
  settings: Record<string, unknown>,
): HookOrderResult => {
  if (!isRecord(settings.bashHooks)) {
    return { hasValue: false, order: [] };
  }

  const bashHooks = settings.bashHooks as Record<string, unknown>;
  if (!Object.hasOwn(bashHooks, "order")) {
    return { hasValue: false, order: [] };
  }

  return {
    hasValue: true,
    order: normalizeHookOrder(bashHooks.order),
  };
};

const resolveHookOrder = (cwd: string): string[] => {
  const { project, global } = loadSettings(cwd);
  const projectOrder = extractHookOrder(project);
  if (projectOrder.hasValue) {
    return projectOrder.order;
  }

  const globalOrder = extractHookOrder(global);
  if (globalOrder.hasValue) {
    return globalOrder.order;
  }

  return [];
};

const resolveOrderedHooks = (cwd: string): BashHookEntry[] => {
  const order = resolveHookOrder(cwd);
  if (order.length === 0) {
    return [...hooks].sort((a, b) => a.index - b.index);
  }

  const orderIndex = new Map(order.map((id, idx) => [id, idx]));
  return [...hooks].sort((a, b) => {
    const aOrder = orderIndex.has(a.id)
      ? (orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER)
      : Number.MAX_SAFE_INTEGER;
    const bOrder = orderIndex.has(b.id)
      ? (orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER)
      : Number.MAX_SAFE_INTEGER;

    if (aOrder !== bOrder) {
      return aOrder - bOrder;
    }

    return a.index - b.index;
  });
};

export const registerBashHook = ({ id, hook }: RegisteredBashHook): void => {
  const existing = hooks.find((entry) => entry.id === id);
  if (existing) {
    existing.hook = hook;
    return;
  }

  hooks.push({ id, hook, index: nextHookIndex() });
};

export const clearBashHooks = (): void => {
  hooks.length = 0;
  hookState.hookIndex = 0;
};

export const runBashHooks = async (
  input: BashHookInput,
): Promise<{ command: string; applied: string[] }> => {
  const orderedHooks = resolveOrderedHooks(input.cwd);
  let command = input.command;
  const applied: string[] = [];

  for (const entry of orderedHooks) {
    const result = await entry.hook({ ...input, command });
    if (!result) {
      continue;
    }

    if (result.command && result.command !== command) {
      command = result.command;
      applied.push(entry.id);
    }
  }

  hookState.lastRun = {
    command: input.command,
    resolved: command,
    applied: [...applied],
    source: input.source,
    cwd: input.cwd,
    timestamp: Date.now(),
  };

  return { command, applied };
};

export const createBashHookTool = (cwd: string) => {
  const baseTool = createBashToolDefinition(cwd);

  return {
    ...baseTool,
    async execute(
      toolCallId: string,
      params: BashToolInput,
      signal: AbortSignal | undefined,
      onUpdate:
        | AgentToolUpdateCallback<BashToolDetails | undefined>
        | undefined,
      ctx: ExtensionContext,
    ) {
      const resolved = await runBashHooks({
        command: params.command,
        ctx,
        cwd: ctx.cwd,
        source: "tool",
      });
      const bashTool = createBashToolDefinition(ctx.cwd);
      return bashTool.execute(
        toolCallId,
        { ...params, command: resolved.command },
        signal,
        onUpdate,
        ctx,
      );
    },
  };
};

export const createBashHookOperations = (ctx: ExtensionContext) => {
  const local = createLocalBashOperations();

  return {
    exec: async (
      command: string,
      cwd: string,
      options: Parameters<typeof local.exec>[2],
    ) => {
      const resolved = await runBashHooks({
        command,
        ctx,
        cwd,
        source: "user_bash",
      });
      return local.exec(resolved.command, cwd, options);
    },
  };
};

export const getBashHookStatus = (cwd: string) => {
  const orderSetting = resolveHookOrder(cwd);
  const orderedHooks = resolveOrderedHooks(cwd);
  return {
    orderSetting,
    registered: hooks.map((entry) => entry.id),
    ordered: orderedHooks.map((entry) => entry.id),
    lastRun: hookState.lastRun,
  };
};
