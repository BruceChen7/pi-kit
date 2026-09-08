/**
 * query-notes-log — Imperative Shell：事件/命令接线 + LLM 调用
 *
 * input 事件暂存 /query-notes 查询 → agent_end 逐条去重落盘；
 * /query-recent-notes-log 命令渲染最近查询。判定逻辑在 core.ts（纯函数），文件 IO 在 store.ts。
 */

import { complete, type UserMessage } from "@earendil-works/pi-ai/compat";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createLogger } from "../shared/logger.ts";
import {
  type AskLlm,
  buildDedupPrompt,
  decideDuplicate,
  formatEntry,
  makeEntry,
  parseDisplayCount,
  parseLlmVerdict,
  parseQueryNotesInput,
} from "./core.ts";
import {
  appendEntry,
  incrementRepeat,
  loadRecentEntries,
  resolveLogDir,
} from "./store.ts";

const log = createLogger("query-notes-log", { stderr: null });

export const DEFAULT_WINDOW = 50;

type ApiKeyAuth = Awaited<
  ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>
>;
type CompleteResponse = Awaited<ReturnType<typeof complete>>;

/** session 级查询暂存：input 暂存 → agent_end drain 落盘 */
export type QuerySessionStore = {
  add: (q: string) => void;
  drain: () => string[];
  reset: () => void;
};

export function createSessionStore(): QuerySessionStore {
  let pending: string[] = [];
  return {
    add: (q) => {
      pending.push(q);
    },
    drain: () => {
      const batch = pending;
      pending = [];
      return batch;
    },
    reset: () => {
      pending = [];
    },
  };
}

/** LLM 语义确认适配器：无模型/鉴权失败/调用失败/无法解析 → null（降级） */
function createAskLlm(ctx: ExtensionContext): AskLlm {
  return async (q, candidate) => {
    const model = ctx.model;
    if (model === undefined) return null;

    let auth: ApiKeyAuth | undefined;
    try {
      auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    } catch {
      return null;
    }
    if (auth === undefined || !auth.ok || !auth.apiKey) return null;

    const { systemPrompt, user } = buildDedupPrompt(q, candidate);
    const userMessage: UserMessage = {
      role: "user",
      content: [{ type: "text", text: user }],
      timestamp: Date.now(),
    };

    let response: CompleteResponse;
    try {
      response = await complete(
        model,
        { systemPrompt, messages: [userMessage] },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          env: auth.env,
          cacheRetention: "none",
        },
      );
    } catch {
      return null;
    }
    if (response.stopReason === "aborted") return null;

    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
    if (text.length === 0) return null;
    return parseLlmVerdict(text);
  };
}

/** 单条查询落盘：加载最近 N 条 → 去重判定 → 追加或计数+1；失败不抛 */
async function recordQuery(q: string, ctx: ExtensionContext): Promise<void> {
  try {
    const dir = resolveLogDir();
    const recent = await loadRecentEntries(dir, DEFAULT_WINDOW);
    const dup = await decideDuplicate(q, recent, createAskLlm(ctx));
    if (dup !== null) {
      await incrementRepeat(dir, dup);
    } else {
      await appendEntry(dir, makeEntry(q));
    }
  } catch (error) {
    log.warn("record failed", { error: String(error) });
  }
}

export default function (
  pi: ExtensionAPI,
  store: QuerySessionStore = createSessionStore(),
) {
  pi.on("session_start", () => {
    store.reset();
  });

  pi.on("input", (event, _ctx) => {
    if (event.source === "extension") return { action: "continue" };
    const q = parseQueryNotesInput(event.text);
    if (q === null) return { action: "continue" };
    store.add(q);
    return { action: "continue" }; // 不拦截模板展开，agent 照常执行
  });

  pi.on("agent_end", async (_event, ctx) => {
    for (const q of store.drain()) {
      await recordQuery(q, ctx);
    }
  });

  pi.registerCommand("query-recent-notes-log", {
    description:
      "Show recent /query-notes queries (semantic duplicates counted as [xN])",
    handler: async (args, ctx) => {
      const n = parseDisplayCount(args);
      const entries = await loadRecentEntries(resolveLogDir(), n);
      const lines = entries.map(formatEntry);
      const output =
        lines.length > 0 ? lines.join("\n") : "(no queries logged yet)";
      if (ctx.hasUI) {
        ctx.ui.notify(output, "info");
      } else {
        log.info(output);
      }
    },
  });
}
