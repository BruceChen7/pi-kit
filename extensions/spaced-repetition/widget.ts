/**
 * widget.ts — TUI 交互式卡片翻转组件
 *
 * 使用 ctx.ui.custom() 构建，支持：
 * - Enter 翻牌（问题面 → 答案面）
 * - 1 = 记住了（grade=4）
 * - 2 = 忘了（grade=0）
 * - ↑↓ / jk 切换卡片
 * - q / Esc 退出
 */

import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { ReviewCard } from "./cards.ts";

// ── Types ──────────────────────────────────────────────────────────────────

export interface CardResult {
  slug: string;
  grade: 0 | 4;
}

export interface CardWidgetResult {
  results: CardResult[];
  cancelled: boolean;
}

// ── Widget component ───────────────────────────────────────────────────────

/**
 * 创建卡片翻转 TUI 组件。
 *
 * 在 ctx.ui.custom() 中调用：
 *
 * ```ts
 * const widgetResult = await ctx.ui.custom<CardWidgetResult>(
 *   (tui, theme, _kb, done) => createCardWidget(cards, theme, done),
 * );
 * ```
 */
export function createCardWidget(
  cards: ReviewCard[],
  theme: {
    fg: (color: string, text: string) => string;
    bold: (text: string) => string;
  },
  done: (result: CardWidgetResult) => void,
): {
  render: (width: number) => string[];
  handleInput: (data: string) => void;
  invalidate: () => void;
} {
  let currentIndex = 0;
  let flipped = false;
  const results: CardResult[] = [];
  let cachedWidth: number | undefined;
  let cachedLines: string[] | undefined;

  function invalidate(): void {
    cachedWidth = undefined;
    cachedLines = undefined;
  }

  function currentCard(): ReviewCard | null {
    return cards[currentIndex] ?? null;
  }

  function finish(cancelled: boolean): void {
    done({ results, cancelled });
  }

  function rateCard(grade: 0 | 4): void {
    const card = currentCard();
    if (!card) return;
    results.push({ slug: card.slug, grade });
    invalidate();

    // 移到下一张
    if (currentIndex < cards.length - 1) {
      currentIndex++;
      flipped = false;
    } else {
      // 全部完成
      finish(false);
    }
  }

  function handleInput(data: string): void {
    const card = currentCard();
    if (!card) return;

    if (!flipped) {
      // 问题面：Enter 翻牌
      if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
        flipped = true;
        invalidate();
        return;
      }
    } else {
      // 答案面：评分
      if (data === "1") {
        rateCard(4);
        return;
      }
      if (data === "2") {
        rateCard(0);
        return;
      }
    }

    // 通用：导航和退出
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      if (currentIndex > 0) {
        currentIndex--;
        flipped = false;
        invalidate();
      }
      return;
    }

    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      if (currentIndex < cards.length - 1) {
        currentIndex++;
        flipped = false;
        invalidate();
      }
      return;
    }

    if (matchesKey(data, Key.escape) || data === "q") {
      finish(true);
    }
  }

  function render(width: number): string[] {
    if (cachedLines && cachedWidth === width) return cachedLines;

    const lines: string[] = [];
    const sep = theme.fg("muted", "─".repeat(width - 2));
    const card = currentCard();

    // ── 标题行 ──
    const totalStr = `${results.length + (flipped && !results.some((r) => r.slug === card?.slug) ? 0 : 0)}/${cards.length}`;
    const correctCount = results.filter((r) => r.grade === 4).length;
    const title = card
      ? ` 📇 ${truncateToWidth(card.concept, Math.floor(width * 0.5))}`
      : " 📇 复习完成";
    const progress = card
      ? ` 已完成 ${results.length}/${cards.length}`
      : ` 结果：${correctCount}/${results.length} 正确`;
    lines.push(truncateToWidth(`${title}${progress}`, width));

    // ── 分隔线 ──
    lines.push(`╭${sep}╮`);

    if (!card) {
      // 全部完成
      lines.push(...renderCompletion(width, correctCount, results.length));
    } else if (!flipped) {
      // 问题面
      lines.push(...renderQuestion(card, width, theme));
    } else {
      // 答案面
      lines.push(...renderAnswer(card, width, theme));
    }

    // ── 底部分隔线 ──
    lines.push(`╰${sep}╯`);

    // ── 操作提示 ──
    if (!card) {
      lines.push("");
      lines.push(theme.fg("muted", "  Enter 关闭"));
    } else if (!flipped) {
      lines.push("");
      lines.push(
        theme.fg("muted", "  ↩ Enter 翻看答案    ↑↓ 切换卡片    q 退出"),
      );
    } else {
      lines.push("");
      lines.push(
        theme.fg("muted", "  1=✅ 记住了  2=❌ 忘了  ↑↓ 切换卡片  q 退出"),
      );
    }

    // ── 进度条 ──
    lines.push(...renderProgressBar(cards.length, results.length, width));

    cachedWidth = width;
    cachedLines = lines;
    return lines;
  }

  return { render, handleInput, invalidate };
}

// ── 渲染子函数 ─────────────────────────────────────────

/**
 * 渲染问题面。
 */
function renderQuestion(
  card: ReviewCard,
  width: number,
  theme: {
    fg: (kind: string, text: string) => string;
    bold: (text: string) => string;
  },
): string[] {
  const lines: string[] = [];
  const innerW = width - 4; // padding

  const typeLabel = {
    qa: "💡 概念问答",
    summary: "📝 要点回顾",
    connection: "🔗 关联连线",
  }[card.cardType];

  lines.push(`  ${theme.fg("accent", typeLabel)}`);
  lines.push(`  ${theme.bold(theme.fg("accent", card.question))}`);
  lines.push("");

  // 标签
  if (card.tags.length > 0) {
    const tagStr = card.tags.map((t) => theme.fg("accent", `#${t}`)).join(" ");
    lines.push(`  🏷 ${truncateToWidth(tagStr, innerW)}`);
  }

  if (card.relatedConcept) {
    lines.push(`  🔗 ${truncateToWidth(card.relatedConcept, innerW)}`);
  }

  return lines;
}

/**
 * 渲染答案面（结构化分段）。
 */
function renderAnswer(
  card: ReviewCard,
  width: number,
  theme: {
    fg: (kind: string, text: string) => string;
    bold: (text: string) => string;
  },
): string[] {
  const lines: string[] = [];
  const innerW = width - 4;

  for (let i = 0; i < card.answer.length; i++) {
    const section = card.answer[i];
    if (i > 0) lines.push("");
    lines.push(`  ${theme.bold(section.heading)}`);
    const contentLines = wrapText(section.content, innerW);
    for (const cl of contentLines) {
      lines.push(`  ${cl}`);
    }
  }

  // 标签
  if (card.tags.length > 0) {
    lines.push("");
    const tagStr = card.tags.map((t) => theme.fg("accent", `#${t}`)).join(" ");
    lines.push(`  🏷 ${truncateToWidth(tagStr, innerW)}`);
  }

  if (card.relatedConcept) {
    lines.push(
      `  🔗 ${card.relatedConcept} — ${card.relationDescription ?? ""}`,
    );
  }

  return lines;
}

/**
 * 渲染完成总结界面。
 */
function renderCompletion(
  width: number,
  correctCount: number,
  totalCount: number,
): string[] {
  const lines: string[] = [];
  lines.push(`  ✅ 复习完成！`);
  lines.push("");
  lines.push(`  记住了：${correctCount}/${totalCount}`);
  lines.push(`  忘了：${totalCount - correctCount}/${totalCount}`);
  return lines;
}

/**
 * 渲染进度条。
 */
function renderProgressBar(
  total: number,
  done: number,
  width: number,
): string[] {
  if (total === 0) return [""];
  const barWidth = Math.max(width - 4, 10);
  const filled = Math.round((done / total) * barWidth);
  const empty = barWidth - filled;
  const bar = "▓".repeat(filled) + "░".repeat(empty);
  return [`  ${bar}`];
}

// ── 工具函数 ───────────────────────────────────────────

/**
 * 简单文本换行。
 */
function wrapText(text: string, maxWidth: number): string[] {
  if (!text) return [""];
  const lines: string[] = [];

  for (const paragraph of text.split("\n")) {
    if (paragraph.length <= maxWidth) {
      lines.push(paragraph);
      continue;
    }

    let remaining = paragraph;
    while (remaining.length > 0) {
      if (remaining.length <= maxWidth) {
        lines.push(remaining);
        break;
      }

      // 找空格处断开
      let breakPoint = remaining.lastIndexOf(" ", maxWidth);
      if (breakPoint <= 0) breakPoint = maxWidth;

      lines.push(remaining.slice(0, breakPoint));
      remaining = remaining.slice(breakPoint).trimStart();
    }
  }

  return lines;
}
