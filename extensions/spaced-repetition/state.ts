/**
 * state.ts — 状态管理
 *
 * 负责：
 * 1. .state.json 的读写（IO 边界）
 * 2. 新概念检测（纯函数）
 * 3. LRU 选择（纯函数）
 *
 * 设计原则：
 * - 读/写文件用 async 封装
 * - 新概念检测和 LRU 选择为纯函数，可测试
 */

import fs from "node:fs/promises";

// ── Types ──────────────────────────────────────────────────────────────────

import type { ConceptEntry } from "./sm2.ts";
import { createNewEntry } from "./sm2.ts";
import { filterDueEntries } from "./sm2.ts";

export type { ConceptEntry };

export interface ReviewState {
  version: 1;
  concepts: Record<string, ConceptEntry>;
}

// ── Constants ──────────────────────────────────────────────────────────────

const CURRENT_VERSION = 1 as const;

// ── 状态读写（IO 边界） ───────────────────────────────

/**
 * 从文件加载状态。
 *
 * 如果文件不存在或损坏，返回空状态。
 *
 * @param filePath .state.json 的绝对路径
 * @returns ReviewState
 */
export async function loadState(filePath: string): Promise<ReviewState> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(content) as ReviewState;

    // 校验版本
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1) {
      return createEmptyState();
    }

    // 校验 concepts 字段
    if (
      !parsed.concepts ||
      typeof parsed.concepts !== "object" ||
      Array.isArray(parsed.concepts)
    ) {
      return createEmptyState();
    }

    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // 文件不存在，返回空状态
      return createEmptyState();
    }
    // 其他错误（权限、JSON 解析错误等）也返回空状态
    return createEmptyState();
  }
}

/**
 * 保存状态到文件。
 *
 * @param filePath .state.json 的绝对路径
 * @param state 当前状态
 */
export async function saveState(
  filePath: string,
  state: ReviewState,
): Promise<void> {
  await fs.mkdir(new URL("..", filePath).pathname, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * 创建空状态。
 */
export function createEmptyState(): ReviewState {
  return { version: CURRENT_VERSION, concepts: {} };
}

// ── 新概念检测（纯函数） ──────────────────────────────

/**
 * 检测新概念并合并到状态中。
 *
 * 纯函数 — 返回新状态对象，不修改输入。
 *
 * @param state 当前状态
 * @param currentSlugs 当前文件系统中的所有概念 slug 集合
 * @param now 当前时间戳（可注入，默认 Date.now()）
 * @returns 更新后的状态（包含新概念，移除已删除概念）
 */
export function syncConcepts(
  state: ReviewState,
  currentSlugs: Set<string>,
  now: number = Date.now(),
): ReviewState {
  const newConcepts: Record<string, ConceptEntry> = {};

  // 保留已有概念（只保留 currentSlugs 中仍然存在的）
  for (const slug of currentSlugs) {
    const existing = state.concepts[slug];
    if (existing) {
      newConcepts[slug] = existing;
    } else {
      // 新概念
      newConcepts[slug] = createNewEntry(slug, now);
    }
  }

  return {
    ...state,
    concepts: newConcepts,
  };
}

/**
 * 获取所有未 skipped 的概念 slug 列表。
 *
 * @param state 当前状态
 * @returns 未 skipped 的 slug 数组
 */
export function getActiveSlugs(state: ReviewState): string[] {
  return Object.entries(state.concepts)
    .filter(([_, entry]) => !entry.skipped)
    .map(([slug]) => slug);
}

// ── LRU 选择（纯函数） ────────────────────────────────

/**
 * 选择本批复习的概念。
 *
 * 策略（LRU）：
 * 1. 先选到期的（nextReviewAt <= now），按 nextReviewAt 升序
 * 2. 如果到期的不够 count 个，从未到期中选 nextReviewAt 最早的补足
 * 3. 最多返回 count 个
 *
 * 纯函数 — 不修改输入。
 *
 * @param state 当前状态
 * @param count 需要选择的数量
 * @param now 当前时间戳（可注入，默认 Date.now()）
 * @returns 选中的 slug 列表
 */
export function selectConcepts(
  state: ReviewState,
  count: number,
  now: number = Date.now(),
): string[] {
  const entries = Object.values(state.concepts).filter((e) => !e.skipped);
  if (entries.length === 0) return [];

  // 到期（due）的条目
  const due = filterDueEntries(entries, now);

  // 未到期但最接近的
  const notDue = entries
    .filter((e) => e.nextReviewAt > now)
    .sort((a, b) => a.nextReviewAt - b.nextReviewAt);

  // 优先到期，再补未到期
  const selected = [...due, ...notDue].slice(0, count);
  return selected.map((e) => e.slug);
}

/**
 * 统计状态概览。
 *
 * 纯函数。
 *
 * @param state 当前状态
 * @param now 当前时间戳（可注入，默认 Date.now()）
 * @returns 统计信息
 */
export function summarizeState(
  state: ReviewState,
  now: number = Date.now(),
): {
  total: number;
  active: number;
  skipped: number;
  due: number;
  levels: Record<number, number>;
} {
  const entries = Object.values(state.concepts);
  const active = entries.filter((e) => !e.skipped);

  return {
    total: entries.length,
    active: active.length,
    skipped: entries.length - active.length,
    due: filterDueEntries(active, now).length,
    levels: active.reduce<Record<number, number>>((acc, e) => {
      acc[e.level] = (acc[e.level] ?? 0) + 1;
      return acc;
    }, {}),
  };
}
