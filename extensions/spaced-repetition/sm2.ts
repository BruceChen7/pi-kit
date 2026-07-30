/**
 * sm2.ts — SM-2 简化版间距重复算法
 *
 * 纯函数，无 IO，无副作用。
 *
 * 评分映射：
 *   grade=4（记住了）→ 推进间隔
 *   grade=0（忘了）  → 重置到 level 0
 *
 * 间隔表（天）：
 *   Level 0: 1 天
 *   Level 1: 2 天
 *   Level 2: 4 天
 *   Level 3: 7 天
 *   Level 4: 15 天
 *   Level 5: 30 天
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface ConceptEntry {
  /** 概念文件名（唯一标识） */
  slug: string;
  /** 上次复习时间戳（epoch ms） */
  lastReviewedAt: number;
  /** 下次应该复习的时间戳（epoch ms） */
  nextReviewAt: number;
  /** SM-2 等级 0-5 */
  level: number;
  /** 总共复习次数 */
  reviewCount: number;
  /** 连续正确次数 */
  consecutiveCorrect: number;
  /** 手动标记跳过 */
  skipped: boolean;
  /** 首次加入时间（epoch ms） */
  createdAt: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

/** 每个等级对应的间隔（毫秒） */
export const LEVEL_INTERVALS_MS: readonly number[] = [
  1 * 24 * 60 * 60 * 1000,   // 0: 1 天
  2 * 24 * 60 * 60 * 1000,   // 1: 2 天
  4 * 24 * 60 * 60 * 1000,   // 2: 4 天
  7 * 24 * 60 * 60 * 1000,   // 3: 7 天
  15 * 24 * 60 * 60 * 1000,  // 4: 15 天
  30 * 24 * 60 * 60 * 1000,  // 5: 30 天
];

/** 最大等级 */
export const MAX_LEVEL = LEVEL_INTERVALS_MS.length - 1;

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * 创建一个新的概念条目。
 *
 * 纯函数 — 返回新对象，不修改输入。
 *
 * @param slug 概念文件名
 * @param now 当前时间戳（可注入，默认 Date.now()）
 */
export function createNewEntry(
  slug: string,
  now: number = Date.now(),
): ConceptEntry {
  return {
    slug,
    lastReviewedAt: 0,
    nextReviewAt: now, // 立即 due
    level: 0,
    reviewCount: 0,
    consecutiveCorrect: 0,
    skipped: false,
    createdAt: now,
  };
}

/**
 * SM-2 间隔计算。
 *
 * grade=4（记住了）→ 等级 +1，间隔按 LEVEL_INTERVALS_MS 增长
 * grade=0（忘了）  → 重置等级到 0，间隔回到 1 天
 *
 * 纯函数 — 返回新对象，不修改输入。
 *
 * @param grade 0（忘了）或 4（记住了）
 * @param entry 当前概念条目
 * @param now 当前时间戳（可注入，默认 Date.now()）
 * @returns 更新后的概念条目
 */
export function computeNextReview(
  grade: 0 | 4,
  entry: ConceptEntry,
  now: number = Date.now(),
): ConceptEntry {
  const level = entry.level;
  const reviewCount = entry.reviewCount + 1;

  if (grade === 4) {
    // 记住了：推进间隔
    const nextLevel = Math.min(level + 1, MAX_LEVEL);
    const consecutiveCorrect = entry.consecutiveCorrect + 1;
    const interval = LEVEL_INTERVALS_MS[nextLevel];

    return {
      ...entry,
      lastReviewedAt: now,
      nextReviewAt: now + interval,
      level: nextLevel,
      reviewCount,
      consecutiveCorrect,
    };
  }

  // grade === 0：忘了，重置
  return {
    ...entry,
    lastReviewedAt: now,
    nextReviewAt: now + LEVEL_INTERVALS_MS[0],
    level: 0,
    reviewCount,
    consecutiveCorrect: 0,
  };
}

/**
 * 筛选出到期的概念（nextReviewAt <= now），按到期顺序排序（最早的在前）。
 *
 * 纯函数 — 不修改输入数组或条目。
 *
 * @param entries 所有概念条目
 * @param now 当前时间戳（可注入，默认 Date.now()）
 * @returns 到期且未 skipped 的条目，按 nextReviewAt 升序
 */
export function filterDueEntries(
  entries: ConceptEntry[],
  now: number = Date.now(),
): ConceptEntry[] {
  return entries
    .filter((e) => !e.skipped && e.nextReviewAt <= now)
    .sort((a, b) => a.nextReviewAt - b.nextReviewAt);
}

/**
 * 计算一个条目的下次复习间隔的可读描述。
 *
 * @param entry 概念条目
 * @returns 如 "1 天后"、"3 天后"、"已到期"
 */
export function describeNextReview(entry: ConceptEntry): string {
  const diff = entry.nextReviewAt - Date.now();
  if (diff <= 0) return "已到期";
  const days = Math.round(diff / (24 * 60 * 60 * 1000));
  if (days === 0) return "今天内";
  if (days === 1) return "明天";
  return `${days} 天后`;
}
