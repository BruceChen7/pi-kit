/**
 * telegram.ts — Telegram 消息格式化
 *
 * 将复习卡片格式化为 Telegram HTML 消息。
 * 使用 shared/telegram.ts 的 sendTelegramNotification 发送。
 *
 * 纯函数 — 只负责格式化，不负责发送。
 * 发送逻辑在 index.ts 中编排。
 */

import type { ReviewCard } from "./cards.ts";

// ── Types ──────────────────────────────────────────────────────────────────

export interface TelegramFormatOptions {
  /** 卡片数量上限（默认 5） */
  maxCards?: number;
}

// ── 格式化 ─────────────────────────────────────────────

/**
 * 将一组卡片格式化为 Telegram HTML 消息。
 *
 * @param cards 复习卡片列表
 * @param correctCount 记住的数量
 * @param totalCount 总数量
 * @param options 格式化选项
 * @returns Telegram HTML 字符串
 */
export function formatCardsForTelegram(
  cards: ReviewCard[],
  correctCount: number,
  totalCount: number,
  options: TelegramFormatOptions = {},
): string {
  const { maxCards = 5 } = options;
  const displayCards = cards.slice(0, maxCards);
  const lines: string[] = [];

  // 标题
  lines.push("<b>📇 今日复习卡片</b>");
  lines.push("");

  // 统计
  lines.push(
    `<b>完成：</b> ${correctCount}/${totalCount} 记住了`,
  );
  lines.push("");

  // 每张卡片
  const emoji: Record<string, string> = {
    qa: "💡",
    summary: "📝",
    connection: "🔗",
  };

  for (let i = 0; i < displayCards.length; i++) {
    const card = displayCards[i];
    const e = emoji[card.cardType] ?? "📌";

    lines.push(`<b>${i + 1}. ${e} ${card.concept}</b>`);

    // 问题
    const questionLine = `   <i>${escapeHtml(card.question)}</i>`;
    lines.push(questionLine);

    // 答案（精简版）
    if (card.answer.length > 0) {
      // 取第一个分段的第一句作为摘要
      const firstSection = card.answer[0];
      const summary = summarySentence(firstSection.content);
      if (summary) {
        lines.push(`   <code>${escapeHtml(summary)}</code>`);
      }
    }

    // 标签
    if (card.tags.length > 0) {
      lines.push(`   #${card.tags.join(" #")}`);
    }

    // Type C 关联
    if (card.relatedConcept) {
      lines.push(`   ↔ ${card.relatedConcept}`);
    }

    lines.push("");
  }

  // 底部引导
  lines.push("<i>在 Pi 中输入 /recall-notes 交互式复习</i>");

  return lines.join("\n");
}

/**
 * 格式化完成通知（无卡片列表，只有统计）。
 */
export function formatCompletionForTelegram(
  correctCount: number,
  totalCount: number,
  nextDueCount: number,
): string {
  const lines: string[] = [];

  lines.push("<b>✅ 复习完成</b>");
  lines.push("");
  lines.push(`记住了：<b>${correctCount}</b>/${totalCount}`);
  lines.push(`忘了：<b>${totalCount - correctCount}</b>/${totalCount}`);
  lines.push("");
  if (nextDueCount > 0) {
    lines.push(`下次复习：<b>${nextDueCount}</b> 张卡片到期`);
  } else {
    lines.push("下次复习：暂无到期卡片");
  }

  return lines.join("\n");
}

// ── 工具函数 ───────────────────────────────────────────

/**
 * HTML 转义。
 */
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * 提取内容的第一句。
 */
function summarySentence(content: string): string {
  if (!content) return "";
  const match = content.match(/^[^。？！.!?\n]+[。？！.!?\n]?/);
  if (!match) {
    return content.length > 100 ? content.slice(0, 100) + "…" : content;
  }
  const sentence = match[0].trim();
  return sentence.length > 100 ? sentence.slice(0, 100) + "…" : sentence;
}
