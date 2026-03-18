import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  createBashTool,
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

const hooks: BashHookEntry[] = [];
let hookIndex = 0;

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

  hooks.push({ id, hook, index: hookIndex++ });
};

export const clearBashHooks = (): void => {
  hooks.length = 0;
  hookIndex = 0;
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

  return { command, applied };
};

export const createBashHookTool = (cwd: string) => {
  const baseTool = createBashTool(cwd);

  return {
    ...baseTool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const resolved = await runBashHooks({
        command: params.command,
        ctx,
        cwd: ctx.cwd,
        source: "tool",
      });
      const bashTool = createBashTool(ctx.cwd);
      return bashTool.execute(
        toolCallId,
        { ...params, command: resolved.command },
        signal,
        onUpdate,
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
