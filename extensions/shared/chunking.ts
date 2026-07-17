/**
 * chunking.ts — 通用 Telegram HTML 分块工具
 *
 * 将 Markdown 内容按条目边界分块，确保每个 chunk 的 HTML 长度不超过
 * Telegram 的 sendMessage 限制（4096 字符）。
 *
 * 纯函数集合：无 IO，无副作用，完全可测试。
 *
 * 使用方式：
 * ```ts
 * import { prepareChunks } from "../../shared/chunking.ts";
 * const chunks = prepareChunks({
 *   sections: ["## Rust\n1. ...", "## Go\n2. ..."],
 *   prefix: "📑 Lobsters 今日推荐\n\n",
 *   maxHtmlLength: 4096,
 * });
 * ```
 */

import { convertMarkdownToTelegramHtml } from "./telegram.ts";

/**
 * 分块输入参数。
 */
export interface ChunkInput {
  /**
   * 预先分割好的内容段列表（通常是按 tag/section 分割的 Markdown 块）。
   * 每个 section 在分块时保持完整，不会被跨块分割。
   */
  sections: string[];

  /**
   * 前置消息，只附加在第一个 chunk 的开头。
   */
  prefix: string;

  /**
   * 每个 chunk 的最大 HTML 长度（Telegram sendMessage 上限为 4096）。
   */
  maxHtmlLength: number;
}

/**
 * 单个 HTML chunk，准备发送到 Telegram。
 */
export interface HtmlChunk {
  /** 可直接用于 Telegram parse_mode=HTML 的字符串。 */
  html: string;
}

/**
 * 将 Markdown sections 按边界分割成 Telegram-safe 的 HTML chunks。
 *
 * - 在 section 边界（`## TagName` 标题）处分割，确保每个 chunk 包含完整的 section 组。
 * - 按 **HTML 长度**（而非原始文本长度）累计，确保转换后的 HTML 不超过限制。
 * - 前缀只附加在第一个 chunk。
 * - 单个 section 的 HTML 超过 maxHtmlLength 时仍然作为一个 chunk 发送
 *   （Telegram 会拒绝，但极罕见——需要一篇几千字符的 section）。
 *
 * 纯函数：无 IO，无副作用。
 */
export function prepareChunks(input: ChunkInput): HtmlChunk[] {
  const { sections, prefix, maxHtmlLength } = input;
  const result: HtmlChunk[] = [];

  let buffer: string[] = [];

  const flushBuffer = () => {
    if (buffer.length === 0) return;
    const raw = buffer.join("\n");
    const text = result.length === 0 ? prefix + raw : raw;
    result.push({ html: convertMarkdownToTelegramHtml(text) });
    buffer = [];
  };

  for (const section of sections) {
    const candidateBuffer = [...buffer, section];
    const raw = candidateBuffer.join("\n");
    const text =
      result.length === 0 && buffer.length === 0 ? prefix + raw : raw;

    if (
      convertMarkdownToTelegramHtml(text).length > maxHtmlLength &&
      buffer.length > 0
    ) {
      flushBuffer();
    }

    buffer.push(section);
  }

  flushBuffer();

  return result;
}

/**
 * 将原始 Markdown 文本按条目边界分割。
 *
 * 条目由 `## N.` 标题行分隔（如 `## 1.`、`## 2.`）。
 */
export function splitEntries(text: string): string[] {
  const entries: string[] = [];
  let buffer = "";

  for (const line of text.split("\n")) {
    if (/^## \d+\.(?:\s|$)/.test(line) && buffer) {
      entries.push(buffer.trim());
      buffer = line;
    } else {
      buffer += (buffer ? "\n" : "") + line;
    }
  }

  if (buffer.trim()) {
    entries.push(buffer.trim());
  }

  return entries;
}
