// # btw core — 纯逻辑层（Functional Core）
//
// 无 IO、无 TUI、无会话依赖的纯函数：btw 线程的选中/裁剪/格式化逻辑。
// 测试见 core.test.ts —— 不需要任何 mock。

export const MAX_HISTORY_EXCHANGES = 20;

/** 已完成的一次侧对话交换（展示 + inject 的来源）。 */
export interface BtwExchange {
  question: string;
  answer: string;
  aborted?: boolean;
  error?: string;
}

/** 正在流式回答中的一次交换。 */
export interface BtwActive {
  question: string;
  answer: string;
  toolName: string | null;
}

/** 当前屏幕上要展示的那一次交换（活动中的，或历史里 viewIndex 指向的）。 */
export interface BtwSelection {
  question: string;
  answer: string;
  label: string;
  error?: string;
}

/** 当前应展示哪一次交换：活动中优先，否则历史中 viewIndex 指向的那次。 */
export function currentSelection(
  active: BtwActive | null,
  exchanges: BtwExchange[],
  viewIndex: number,
): BtwSelection | null {
  if (active) {
    return {
      question: active.question,
      answer: active.answer,
      label: "answering…",
    };
  }
  const exchange = exchanges[viewIndex];
  if (!exchange) return null;
  const suffix = exchange.aborted
    ? " (aborted)"
    : exchange.error
      ? " (error)"
      : "";
  return {
    question: exchange.question,
    answer: exchange.answer,
    error: exchange.error,
    label: `${viewIndex + 1}/${exchanges.length}${suffix}`,
  };
}

/** 从历史裁剪到 MAX_HISTORY_EXCHANGES 轮，并同步 viewIndex。返回新状态（不可变）。 */
export function capHistory(
  exchanges: BtwExchange[],
  viewIndex: number,
): { exchanges: BtwExchange[]; viewIndex: number } {
  if (exchanges.length <= MAX_HISTORY_EXCHANGES) {
    return { exchanges, viewIndex };
  }
  const prunedCount = exchanges.length - MAX_HISTORY_EXCHANGES;
  const pruned = exchanges.slice(prunedCount);
  return { exchanges: pruned, viewIndex: Math.max(0, viewIndex - prunedCount) };
}

/** 把整条 btw 线程格式化成可注入主会话的纯文本。 */
export function formatThread(exchanges: BtwExchange[]): string {
  return exchanges
    .map((d) => `User: ${d.question.trim()}\nAssistant: ${d.answer.trim()}`)
    .join("\n\n---\n\n");
}

/** 组装注入主会话的 payload（带 <btw-thread>/<btw-summary> 标签）。 */
export function formatInjectedPayload(
  kind: "thread" | "summary",
  body: string,
  instructions: string,
): string {
  const tag = kind === "thread" ? "btw-thread" : "btw-summary";
  const intro = getInjectedPayloadIntro(kind, instructions);
  return `${intro}\n\n<${tag}>\n${body}\n</${tag}>`;
}

function getInjectedPayloadIntro(
  kind: "thread" | "summary",
  instructions: string,
): string {
  if (kind === "thread") {
    return instructions
      ? `Here's a side conversation I had. ${instructions}`
      : "Here's a side conversation I had for additional context:";
  }
  return instructions
    ? `Here's a summary of a side conversation I had. ${instructions}`
    : "Here's a summary of a side conversation I had:";
}

type TextContent = { type: "text"; text: string };

export function isTextContent(content: unknown): content is TextContent {
  if (!content || typeof content !== "object") return false;
  const textContent = content as TextContent;
  return textContent.type === "text" && typeof textContent.text === "string";
}

/** 从 message.content（string 或 TextContent[]）里抽取纯文本。 */
export function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isTextContent)
    .map((c) => c.text)
    .join("\n");
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
