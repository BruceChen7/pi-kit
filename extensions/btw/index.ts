// # btw — Side Conversations for pi（pi-btw 思路重构版）
//
// `/btw` 在 pi 的 TUI 里开一个 top-center overlay，问一个「旁边」的问题，
// 不打断主 agent。侧 agent 是一个真实 in-memory、只读（read/grep/find/ls）
// 的 AgentSession 子会话，seed 了主会话的消息，可从当前 repo 查证后回答。
//
// 架构（Functional Core, Imperative Shell）：
//   core.ts     纯逻辑：线程选中/裁剪/格式化（无 IO、无 TUI）
//   session.ts  壳：子会话 boot/seed/dispose（唯一的会话副作用出口）
//   overlay.ts  展示：top-center overlay 组件（移植自 L2ncE/pi-btw）
//   index.ts    壳：命令/快捷键注册、编排、reset 生命周期
//
// 命令：
//   /btw <q>          发起侧问（无参则仅打开 overlay）
//   /btw:new [q]      开新线程（dispose 子会话 + 清空历史），可选直接问
//   /btw:clear        关闭 overlay + 清空线程
//   /btw:inject [指令] 把整个 btw 线程作为 followUp 注入主 agent，然后重置
//   /btw:summarize [指令] 用 fast 模型摘要后注入主 agent，然后重置
//
// 交互（overlay）：Enter 追问 · Esc 中止/关闭 · c 复制 · ←→ 历史 · ↑↓ 滚动 ·
//                 alt+/（或 ctrl+alt+w）切回主编辑。
//
// 持久化：无（纯内存）。重启 / reload 即清——因侧对话是旁支，不值得落盘。

import type {
  Api,
  Model,
  ProviderHeaders,
  ThinkingLevel,
} from "@earendil-works/pi-ai";
import { contentText } from "@earendil-works/pi-ai";
import {
  completeSimple,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import {
  type AgentSession,
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type BtwActive,
  type BtwExchange,
  capHistory,
  currentSelection,
  extractTextContent,
  formatInjectedPayload,
  formatThread,
  getErrorMessage,
} from "./core.ts";
import { type BtwOverlayCallbacks, BtwOverlayComponent } from "./overlay.ts";
import {
  type AgentSessionEvent,
  bootBtwSession,
  disposeBtwSession,
  reSyncBtwSession,
} from "./session.ts";

// ── 摘要模型（fast profile，仅 summarize 使用）─────────────────────

const FAST_PROFILE = {
  provider: "google",
  id: "gemini-flash-lite-latest",
  reasoning: "low" as ThinkingLevel,
};

type ModelAuth = {
  apiKey: string;
  headers?: ProviderHeaders;
};

type SummaryModel = {
  model: Model<Api>;
  label: string;
  options: SimpleStreamOptions;
};

async function getModelAuth(
  ctx: ExtensionContext,
  model: Model<Api>,
): Promise<ModelAuth | undefined> {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return undefined;
  return { apiKey: auth.apiKey, headers: auth.headers };
}

async function resolveSummaryModel(
  ctx: ExtensionContext,
): Promise<SummaryModel | undefined> {
  const fast = ctx.modelRegistry.find(FAST_PROFILE.provider, FAST_PROFILE.id);
  if (fast) {
    const auth = await getModelAuth(ctx, fast);
    if (auth) {
      return {
        model: fast,
        label: `fast: ${fast.provider}/${fast.id}`,
        options: { ...auth, reasoning: FAST_PROFILE.reasoning },
      };
    }
  }
  if (!ctx.model) return undefined;
  return { model: ctx.model, label: "active", options: {} };
}

// ── Overlay 运行时 ────────────────────────────────────────────────

interface OverlayRuntime {
  handle?: OverlayHandleLike;
  refresh?: () => void;
  setStatus?: (status: string) => void;
  finish?: () => void;
  closed?: boolean;
  close: () => void;
}

interface OverlayHandleLike {
  focus(): void;
  unfocus(): void;
  hide(): void;
}

export default function btw(pi: ExtensionAPI) {
  // ── 状态（纯内存）───────────────────────────────────────────────
  let subSession: AgentSession | null = null;
  let subscribed = false;
  let active: BtwActive | null = null;
  let exchanges: BtwExchange[] = [];
  let viewIndex = 0;
  let overlayRuntime: OverlayRuntime | null = null;

  // ── overlay 控制 ─────────────────────────────────────────────────
  function setStatus(status: string): void {
    if (overlayRuntime?.setStatus) overlayRuntime.setStatus(status);
  }

  function refreshOverlay(): void {
    overlayRuntime?.refresh?.();
  }

  function closeOverlay(): void {
    overlayRuntime?.close();
  }

  function notify(
    ctx: ExtensionCommandContext,
    message: string,
    level: "info" | "warning" | "error",
  ): void {
    try {
      ctx.ui.notify(message, level);
    } catch {
      // Context may be replaced while an async ask is in flight.
    }
  }

  function ensureOverlay(ctx: ExtensionCommandContext): void {
    if (overlayRuntime?.handle) {
      overlayRuntime.handle.focus();
      refreshOverlay();
      return;
    }
    const runtime: OverlayRuntime = {
      close: () => {
        if (runtime.closed) return;
        runtime.closed = true;
        runtime.handle?.hide();
        if (overlayRuntime === runtime) overlayRuntime = null;
        runtime.finish?.();
      },
    };
    overlayRuntime = runtime;

    void ctx.ui
      .custom<void>(
        (tui, theme, _keybindings, done) => {
          runtime.finish = () => done();

          const callbacks: BtwOverlayCallbacks = {
            readExchanges: () => exchanges,
            readActive: () => active,
            readViewIndex: () => viewIndex,
            readCurrent: () => currentSelection(active, exchanges, viewIndex),
            setViewIndex: (index: number) => {
              viewIndex = index;
            },
            onSubmit: (value: string) => {
              void ask(ctx, value.trim());
            },
            onDismiss: () => {
              if (active) {
                void abortActive();
                return;
              }
              closeOverlay();
            },
            onCopy: () => {
              void copyCurrentAnswer(ctx);
            },
            onUnfocus: () => {
              overlayRuntime?.handle?.unfocus();
              refreshOverlay();
            },
          };

          const overlay = new BtwOverlayComponent(tui, theme, callbacks);

          runtime.refresh = () => overlay.refresh();
          runtime.setStatus = (status: string) => overlay.setStatus(status);

          return overlay;
        },
        {
          overlay: true,
          overlayOptions: {
            width: "78%",
            minWidth: 64,
            maxHeight: "78%",
            anchor: "top-center",
            margin: { top: 1, left: 2, right: 2 },
            nonCapturing: true,
          },
          onHandle: (handle) => {
            runtime.handle = handle;
            handle.focus();
            if (runtime.closed) runtime.close();
          },
        },
      )
      .catch((error: unknown) => {
        if (overlayRuntime === runtime) overlayRuntime = null;
        notify(ctx, getErrorMessage(error), "error");
      });
  }

  // ── 子会话 ──────────────────────────────────────────────────────
  async function ensureBtwSession(
    ctx: ExtensionCommandContext,
  ): Promise<AgentSession | null> {
    if (subSession) return subSession;
    const session = await bootBtwSession(ctx, pi);
    subSession = session;
    return session;
  }

  function handleSessionEvent(event: AgentSessionEvent): void {
    if (!active) return;
    if (event.type === "message_update" && event.message.role === "assistant") {
      active.answer = contentText(event.message.content).trim();
      refreshOverlay();
    } else if (event.type === "tool_execution_start") {
      active.toolName = event.toolName;
      refreshOverlay();
    } else if (event.type === "tool_execution_end") {
      active.toolName = null;
      refreshOverlay();
    }
  }

  function finishExchange(exchange: BtwExchange, status: string): void {
    exchanges.push(exchange);
    active = null;
    viewIndex = exchanges.length - 1;
    const capped = capHistory(exchanges, viewIndex);
    exchanges = capped.exchanges;
    viewIndex = capped.viewIndex;
    setStatus(status);
    refreshOverlay();
  }

  async function ask(
    ctx: ExtensionCommandContext,
    question: string,
  ): Promise<void> {
    if (active) {
      setStatus("Still answering — press Esc to abort first.");
      return;
    }
    if (!question) return;
    const session = await ensureBtwSession(ctx);
    if (!session) {
      notify(ctx, "No active model for /btw", "error");
      return;
    }

    if (!subscribed) {
      session.subscribe(handleSessionEvent);
      subscribed = true;
    }

    // Follow the main session's current model and thinking level.
    await reSyncBtwSession(session, ctx, pi);

    active = { question, answer: "", toolName: null };
    refreshOverlay();
    setStatus("streaming…");

    try {
      await session.prompt(question, { source: "extension" });
    } catch (error) {
      finishExchange(
        {
          question,
          answer: active.answer,
          error: getErrorMessage(error),
        },
        "error",
      );
      return;
    }

    const response = [...session.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    if (response?.stopReason === "aborted") {
      finishExchange(
        {
          question,
          answer: contentText(response.content).trim(),
          aborted: true,
        },
        "aborted",
      );
    } else if (response && response.stopReason !== "error") {
      finishExchange(
        {
          question,
          answer: contentText(response.content).trim() || "(no answer)",
        },
        "",
      );
    } else {
      finishExchange(
        {
          question,
          answer: active.answer,
          error: response?.errorMessage ?? "The side agent returned an error.",
        },
        "error",
      );
    }
  }

  async function abortActive(): Promise<void> {
    if (!active || !subSession) return;
    try {
      await subSession.abort();
    } catch {
      // Abort races are fine; the prompt() call resolves with stopReason "aborted".
    }
  }

  /** reset：Abort → dispose 子会话 → 清空三态 → 关闭 overlay。下次 ask 懒重建。 */
  async function resetThread(): Promise<void> {
    if (active && subSession) await abortActive();
    if (subSession) {
      disposeBtwSession(subSession);
      subSession = null;
      subscribed = false;
    }
    active = null;
    exchanges = [];
    viewIndex = 0;
    closeOverlay();
  }

  async function copyCurrentAnswer(
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const selection = currentSelection(active, exchanges, viewIndex);
    const answer = selection?.answer;
    if (!answer) {
      setStatus("Nothing to copy yet.");
      return;
    }
    try {
      await copyToClipboard(answer);
      setStatus("Copied markdown answer to clipboard.");
    } catch (error) {
      notify(ctx, `Copy failed: ${getErrorMessage(error)}`, "error");
    }
  }

  // ── 快捷键 ──────────────────────────────────────────────────────
  // 焦点在主编辑与 overlay 之间切换（overlay 保持可见）。
  for (const shortcut of ["alt+/", "ctrl+alt+w"]) {
    pi.registerShortcut(shortcut as never, {
      description: "Focus the /btw overlay",
      handler: () => {
        if (!overlayRuntime?.handle) return;
        overlayRuntime.handle.focus();
        refreshOverlay();
      },
    });
  }

  // ── 命令 ────────────────────────────────────────────────────────
  pi.registerCommand("btw", {
    description:
      "Ask a quick side question in a top-center overlay without interrupting the main conversation",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/btw requires interactive TUI mode", "error");
        return;
      }
      const question = args.trim();
      if (!question) {
        // No question: just open the overlay on the latest history entry.
        ensureOverlay(ctx);
        refreshOverlay();
        return;
      }
      ensureOverlay(ctx);
      await ask(ctx, question);
    },
  });

  pi.registerCommand("btw:new", {
    description:
      "Start a fresh btw thread (disposes the side session), optionally with a new question",
    handler: async (args, ctx) => {
      await resetThread();
      const question = args.trim();
      if (question) {
        ensureOverlay(ctx);
        await ask(ctx, question);
      } else {
        ctx.ui.notify("💭 btw: started fresh thread", "info");
      }
    },
  });

  pi.registerCommand("btw:clear", {
    description: "Dismiss the btw overlay and clear the thread",
    handler: async () => {
      await resetThread();
    },
  });

  pi.registerCommand("btw:inject", {
    description:
      "Inject the btw thread into the main agent context [optional instructions]",
    handler: async (args, ctx) => {
      if (exchanges.length === 0) {
        ctx.ui.notify("No active btw thread to inject", "warning");
        return;
      }
      const count = exchanges.length;
      const instructions = args.trim();
      const content = formatInjectedPayload(
        "thread",
        formatThread(exchanges),
        instructions,
      );
      pi.sendUserMessage(content, { deliverAs: "followUp" });
      await resetThread();
      ctx.ui.notify(`💭 btw → main: injected ${count} exchange(s)`, "info");
    },
  });

  pi.registerCommand("btw:summarize", {
    description:
      "Summarize the btw thread (fast model) and inject into the main agent context [optional instructions]",
    handler: async (args, ctx) => {
      if (exchanges.length === 0) {
        ctx.ui.notify("No active btw thread to summarize", "warning");
        return;
      }
      const count = exchanges.length;
      const summaryModel = await resolveSummaryModel(ctx);
      if (!summaryModel) {
        ctx.ui.notify("No model available for btw summary", "error");
        return;
      }

      setStatus(`⏳ summarizing (${summaryModel.label})…`);

      try {
        const threadText = formatThread(exchanges);
        const response = await completeSimple(
          summaryModel.model,
          {
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: [
                      "Summarize this side conversation concisely. Preserve key decisions, plans, insights, and action items.",
                      "Output only the summary, no preamble.",
                      "",
                      "<btw-thread>",
                      threadText,
                      "</btw-thread>",
                    ].join("\n"),
                  },
                ],
                timestamp: Date.now(),
              },
            ],
          },
          summaryModel.options,
        );

        const summary = extractTextContent(response.content);
        const instructions = args.trim();
        const content = formatInjectedPayload("summary", summary, instructions);

        pi.sendUserMessage(content, { deliverAs: "followUp" });
        await resetThread();
        ctx.ui.notify(
          `💭 btw → main: injected summary of ${count} exchange(s)`,
          "info",
        );
      } catch (err: unknown) {
        setStatus("");
        refreshOverlay();
        ctx.ui.notify(`btw:summarize error — ${getErrorMessage(err)}`, "error");
      }
    },
  });
}
