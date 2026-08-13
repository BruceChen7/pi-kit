/**
 * spaced-repetition — Pi 扩展入口
 *
 * 注册 /recall-notes 命令，编排完整复习流程。
 */

import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { createLogger } from "../shared/logger.ts";
import { loadSettings } from "../shared/settings.ts";
import {
  isTelegramConfigured,
  sendTelegramNotification,
} from "../shared/telegram.ts";

import {
  generateAllCards,
  type ParsedConcept,
  parseConceptContent,
} from "./cards.ts";
import { computeNextReview } from "./sm2.ts";
import {
  loadState,
  type ReviewState,
  saveState,
  selectConcepts,
  syncConcepts,
} from "./state.ts";
import { formatCardsForTelegram } from "./telegram.ts";
import { type CardResult, createCardWidget } from "./widget.ts";

// ── Logger ──────────────────────────────────────────────

const log = createLogger("spaced-repetition", { stderr: null });

// ── Constants ────────────────────────────────────────────

const HOME = homedir();
const DEFAULT_KNOWLEDGE_BASE = path.join(HOME, "work", "notes");
const DEFAULT_CONCEPTS_DIR = "Wiki/Concepts";
const DEFAULT_REVIEW_DIR = "Review";
const DEFAULT_CARDS_PER_SESSION = 5;

// ── Types ──────────────────────────────────────────────

interface SpacedRepetitionSettings {
  spacedRepetition?: {
    knowledgeBase?: string;
    conceptsDir?: string;
    reviewDir?: string;
    cardsPerSession?: number;
    enableTelegram?: boolean;
  };
}

interface ResolvedConfig {
  knowledgeBaseDir: string;
  conceptsDir: string;
  reviewDir: string;
  reviewFilePath: string;
  stateFilePath: string;
  cardsPerSession: number;
  enableTelegram: boolean;
}

// ── Config ──────────────────────────────────────────────

function loadConfig(cwd: string): ResolvedConfig {
  const settings = loadSettings(cwd).merged as SpacedRepetitionSettings;
  const ext = settings.spacedRepetition ?? {};

  const knowledgeBaseDir = path.resolve(
    ext.knowledgeBase ?? DEFAULT_KNOWLEDGE_BASE,
  );
  const conceptsDir = ext.conceptsDir ?? DEFAULT_CONCEPTS_DIR;
  const reviewDir = ext.reviewDir ?? DEFAULT_REVIEW_DIR;
  const cardsPerSession = ext.cardsPerSession ?? DEFAULT_CARDS_PER_SESSION;
  const enableTelegram = ext.enableTelegram ?? isTelegramConfigured(cwd);

  const conceptsAbs = path.join(knowledgeBaseDir, conceptsDir);
  const reviewAbs = path.join(knowledgeBaseDir, reviewDir);

  const now = new Date();
  const monthFile = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}.md`;
  const reviewFilePath = path.join(reviewAbs, monthFile);
  const stateFilePath = path.join(reviewAbs, ".state.json");

  return {
    knowledgeBaseDir,
    conceptsDir: conceptsAbs,
    reviewDir: reviewAbs,
    reviewFilePath,
    stateFilePath,
    cardsPerSession,
    enableTelegram,
  };
}

// ── File operations ─────────────────────────────────────

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * 扫描概念目录，返回所有概念文件（不含目录）。
 */
function scanConceptFiles(conceptsDir: string): string[] {
  try {
    const entries = fs.readdirSync(conceptsDir);
    return entries
      .filter((e) => e.endsWith(".md"))
      .map((e) => e.replace(/\.md$/, ""));
  } catch (err) {
    log.warn("failed to scan concepts dir", {
      dir: conceptsDir,
      error: String(err),
    });
    return [];
  }
}

/**
 * 读取概念文件并解析。
 */
function readConcept(conceptsDir: string, slug: string): ParsedConcept | null {
  const filePath = path.join(conceptsDir, `${slug}.md`);
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return parseConceptContent(content, slug, filePath);
  } catch (err) {
    log.warn("failed to read concept", {
      slug,
      error: String(err),
    });
    return null;
  }
}

/**
 * 通过 qmd search 查找关联概念。
 *
 * 返回第一个非自身的概念名，如无可返回 undefined。
 */
async function findRelatedConcept(
  concept: ParsedConcept,
): Promise<string | undefined> {
  const keywords = [concept.title, ...concept.tags].filter(Boolean).join(" ");
  if (!keywords) return undefined;

  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    const { stdout } = await execFileAsync(
      "qmd",
      ["search", keywords, "--json", "-n", "5"],
      {
        cwd: process.cwd(),
        timeout: 15_000,
      },
    );

    const results = JSON.parse(stdout) as Array<{
      file: string;
      title: string;
      score: number;
    }>;

    if (!Array.isArray(results) || results.length === 0) return undefined;

    // 找到第一个不在 Concepts/ 中或不同名的结果
    const other = results.find(
      (r) => !r.file.includes(`/Concepts/${concept.slug}`),
    );
    return other?.title || results[1]?.title || undefined;
  } catch (err) {
    log.warn("qmd search failed for related concept", {
      concept: concept.slug,
      error: String(err),
    });
    return undefined;
  }
}

/**
 * 追加当日复习记录到月度文件。
 */
function appendToReviewFile(
  filePath: string,
  dateStr: string,
  results: CardResult[],
  cards: { slug: string; concept: string }[],
): void {
  ensureDir(path.dirname(filePath));

  // 当月度文件不存在时，创建并写入标题
  let content = "";
  if (!fs.existsSync(filePath)) {
    content = `# 复习记录\n\n`;
  } else {
    content = fs.readFileSync(filePath, "utf-8");
  }

  // 追加当天的记录
  const daySection = `## ${dateStr}\n\n`;
  const entries = results.map((r) => {
    const card = cards.find((c) => c.slug === r.slug);
    const gradeStr = r.grade === 4 ? "✅ 记得" : "❌ 忘了";
    return `- ${card?.concept ?? r.slug}: ${gradeStr}`;
  });

  content += `${daySection}${entries.join("\n")}\n\n`;
  fs.writeFileSync(filePath, content, "utf-8");
}

// ── 主流程 ──────────────────────────────────────────────

async function runRecallSession(
  ctx: ExtensionCommandContext,
  config: ResolvedConfig,
): Promise<void> {
  const now = Date.now();

  // 1. 扫描概念
  const allSlugs = scanConceptFiles(config.conceptsDir);
  if (allSlugs.length === 0) {
    ctx.ui.notify("未找到概念文件", "warning");
    return;
  }
  log.info("concepts scanned", { count: allSlugs.length });

  // 2. 加载状态并同步新概念
  const state = await loadState(config.stateFilePath);
  const synced = syncConcepts(state, new Set(allSlugs), now);

  // 3. 选择本批概念
  const selectedSlugs = selectConcepts(synced, config.cardsPerSession, now);
  if (selectedSlugs.length === 0) {
    ctx.ui.notify("没有到期的复习卡片 🎉", "info");
    return;
  }
  log.info("selected concepts", {
    slugs: selectedSlugs,
    count: selectedSlugs.length,
  });

  // 4. 读取概念并生成卡片
  const parsedConcepts: ParsedConcept[] = [];
  for (const slug of selectedSlugs) {
    const parsed = readConcept(config.conceptsDir, slug);
    if (parsed?.hasSubstance) {
      parsedConcepts.push(parsed);
    } else {
      log.info("skipping thin concept", { slug });
    }
  }

  if (parsedConcepts.length === 0) {
    ctx.ui.notify("选中的概念都无正文内容", "warning");
    return;
  }

  // 5. 生成卡片（对每个概念尝试发现关联）
  const allCards: Array<{
    card: import("./cards.ts").ReviewCard;
    slug: string;
    concept: string;
  }> = [];
  for (const parsed of parsedConcepts) {
    // 尝试找关联概念（Type C）
    let relatedConcept: string | undefined;
    if (allCards.length < config.cardsPerSession) {
      relatedConcept = await findRelatedConcept(parsed);
    }

    const cards = generateAllCards(parsed, relatedConcept);

    // 取前 N 张确保不超过 cardsPerSession
    for (const card of cards) {
      if (allCards.length >= config.cardsPerSession) break;
      allCards.push({ card, slug: parsed.slug, concept: parsed.title });
    }
    if (allCards.length >= config.cardsPerSession) break;
  }

  const reviewCards = allCards.map((c) => c.card);

  // 6. 打开交互式 widget
  ctx.ui.notify(`打开复习：${reviewCards.length} 张卡片`, "info");

  const widgetResult = await ctx.ui.custom<{
    results: CardResult[];
    cancelled: boolean;
  }>((_tui, theme, _kb, done) => createCardWidget(reviewCards, theme, done));

  if (widgetResult.cancelled) {
    ctx.ui.notify("复习已取消", "info");
    // 已评分的结果仍然保存
    if (widgetResult.results.length === 0) return;
  }

  // 7. 更新 SM-2 状态
  const updatedConcepts = { ...synced.concepts };
  for (const result of widgetResult.results) {
    const entry = updatedConcepts[result.slug];
    if (entry) {
      updatedConcepts[result.slug] = computeNextReview(
        result.grade,
        entry,
        now,
      );
    }
  }

  const updatedState: ReviewState = {
    ...synced,
    concepts: updatedConcepts,
  };

  // 8. 保存状态
  ensureDir(config.reviewDir);
  await saveState(config.stateFilePath, updatedState);

  // 9. 追加到月度文件
  const dateStr = new Date().toISOString().slice(0, 10);
  appendToReviewFile(
    config.reviewFilePath,
    dateStr,
    widgetResult.results,
    allCards.map((c) => ({ slug: c.slug, concept: c.concept })),
  );

  // 10. 发送 Telegram
  if (config.enableTelegram) {
    const correctCount = widgetResult.results.filter(
      (r) => r.grade === 4,
    ).length;
    const totalCount = widgetResult.results.length;

    const msg = formatCardsForTelegram(reviewCards, correctCount, totalCount);

    try {
      await sendTelegramNotification(msg, undefined, true);
    } catch (err) {
      log.warn("telegram notification failed", { error: String(err) });
    }
  }

  // 11. 完成通知
  const correctCount = widgetResult.results.filter((r) => r.grade === 4).length;
  ctx.ui.notify(
    `复习完成：${correctCount}/${widgetResult.results.length} 记住了`,
    "info",
  );
}

// ── Extension entry ─────────────────────────────────────

export default function spacedRepetitionExtension(pi: ExtensionAPI): void {
  pi.registerCommand("recall-notes", {
    description: "从知识库中获取概念，生成复习卡片，交互式回顾知识",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const config = loadConfig(ctx.cwd);

      // 检查概念目录是否存在
      if (!fs.existsSync(config.conceptsDir)) {
        ctx.ui.notify(`概念目录不存在：${config.conceptsDir}`, "error");
        return;
      }

      await runRecallSession(ctx, config);
    },
  });
}
