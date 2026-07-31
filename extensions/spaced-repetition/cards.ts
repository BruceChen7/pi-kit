/**
 * cards.ts — 概念解析、卡片生成、格式化
 *
 * 纯函数，无 IO，无副作用。
 *
 * 概念文件格式（frontmatter + body + ## Sources）：
 * ```markdown
 * ---
 * type: Concept
 * tags: [go, http]
 * ---
 *
 * # Title
 *
 * Body text...
 *
 * ## Section Heading
 *
 * More body...
 *
 * ## Sources
 *
 * - [[Wiki/...]]
 * ```
 */

// ── Types ──────────────────────────────────────────────────────────────────

/** 答案的一个结构化分段 */
export interface AnswerSection {
  heading: string; // 中文标题
  content: string; // 该分段的内容
}

/** 卡片类型 */
export type CardType = "qa" | "summary" | "connection";

/** 复习卡片 */
export interface ReviewCard {
  concept: string; // 概念名（英文）
  slug: string; // 文件名
  question: string; // 中文问题
  answer: AnswerSection[]; // 结构化分段答案
  tags: string[]; // 标签
  source: string; // 源文件路径
  cardType: CardType;

  // Type C 专用
  relatedConcept?: string;
  relationDescription?: string;
}

/** 解析后的概念 */
export interface ParsedConcept {
  slug: string; // 文件名
  title: string; // 标题（# Title）
  tags: string[]; // frontmatter tags
  bodySections: BodySection[]; // 正文分段
  hasSubstance: boolean; // 是否有正文内容
  source: string; // 源文件路径
}

/** 正文分段 */
export interface BodySection {
  heading: string; // 段落标题（英文原文）
  content: string; // 段落内容
}

// ── 常量 ───────────────────────────────────────────────────────────────────

/** 判断一个概念是否「有正文」的最小字符数（不含 frontmatter 和 sources） */
export const MIN_SUBSTANCE_CHARS = 50;

/** Type C 关联描述的文案模板 */
const RELATION_TEMPLATES: Record<string, string> = {
  default: "关联概念",
};

// ── 概念解析 ──────────────────────────────────────────

/**
 * 从概念文件内容中解析出结构化数据。
 *
 * 纯函数 — 只解析输入字符串，不访问文件系统。
 *
 * @param content 概念文件的完整文本内容
 * @param slug 概念文件名（不含路径和扩展名）
 * @param source 源文件路径
 * @returns 解析后的概念
 */
export function parseConceptContent(
  content: string,
  slug: string,
  source: string,
): ParsedConcept {
  const tags = extractTags(content);
  const title = extractTitle(content);
  const bodySections = extractBodySections(content);
  const hasSubstance = evaluateSubstance(bodySections, content);

  return { slug, title, tags, bodySections, hasSubstance, source };
}

/**
 * 从 frontmatter 提取 tags。
 *
 * @param content 完整文件内容
 * @returns 标签数组
 */
export function extractTags(content: string): string[] {
  const match = content.match(/^---\n[\s\S]*?\n---/);
  if (!match) return [];

  const frontmatter = match[0];
  const tagsMatch = frontmatter.match(/tags:\s*\[([^\]]*)\]/);
  if (!tagsMatch) return [];

  return tagsMatch[1]
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * 从 # Title 行提取标题。
 *
 * @param content 完整文件内容
 * @returns 标题文本，如找不到返回 slug
 */
export function extractTitle(content: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : slugToTitle(content);
}

/**
 * 从 slug 推断标题（当没有 # Title 时的回退）。
 */
function slugToTitle(slug: string): string {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * 从正文提取结构化分段。
 *
 * 策略：
 * 1. 移除 frontmatter（--- ... ---）
 * 2. 移除 # 标题行
 * 3. 移除 ## Sources 及其之后的内容
 * 4. 按 ## 标题分段，每段包括标题及其后的段落
 * 5. 无 ## 标题的内容归为「概述」
 *
 * @param content 完整文件内容
 * @returns 正文分段数组
 */
export function extractBodySections(content: string): BodySection[] {
  // 移除 frontmatter
  let body = content.replace(/^---[\s\S]*?\n---\n/, "").trim();

  // 移除 # 标题行
  body = body.replace(/^#\s+.*$/m, "").trim();

  // 移除 ## Sources 及之后的内容
  const sourcesIndex = body.search(/^##\s+Sources/m);
  if (sourcesIndex !== -1) {
    body = body.slice(0, sourcesIndex).trim();
  }

  if (!body) return [];

  // 按 ## 标题分段
  const sections: BodySection[] = [];
  const headingPattern = /^##\s+(.+)$/gm;
  let lastIndex = 0;
  let lastHeading = "";

  // 查找第一个 ## 标题
  const firstMatch = headingPattern.exec(body);

  if (!firstMatch) {
    // 没有 ## 标题，整个正文作为「概述」
    return [{ heading: "概述", content: body.trim() }];
  }

  // 第一个 ## 标题之前的内容作为「概述」
  const beforeFirstHeading = body.slice(0, firstMatch.index).trim();
  if (beforeFirstHeading) {
    sections.push({ heading: "概述", content: beforeFirstHeading });
  }

  lastIndex = firstMatch.index;
  lastHeading = firstMatch[1].trim();
  let lastMatch = firstMatch;

  // 遍历后续 ## 标题
  let match = headingPattern.exec(body);
  while (match !== null) {
    // 从上个标题到这个标题之间的内容
    const sectionContent = body
      .slice(lastMatch.index + lastMatch[0].length, match.index)
      .trim();
    if (sectionContent) {
      sections.push({ heading: lastHeading, content: sectionContent });
    }
    lastIndex = match.index;
    lastHeading = match[1].trim();
    lastMatch = match;
    match = headingPattern.exec(body);
  }

  // 最后一个 ## 标题后的内容
  const afterLast = body.slice(lastMatch.index + lastMatch[0].length).trim();
  if (afterLast) {
    sections.push({ heading: lastHeading, content: afterLast });
  }

  return sections;
}

/**
 * 判断概念是否有充分的正文内容。
 *
 * 策略：bodySections 的总字符数 >= MIN_SUBSTANCE_CHARS
 *
 * @param bodySections 正文分段
 * @param content 原始内容（备用）
 * @returns 是否有正文
 */
export function evaluateSubstance(
  bodySections: BodySection[],
  content: string,
): boolean {
  if (bodySections.length === 0) return false;

  const totalChars = bodySections.reduce(
    (sum, s) => sum + s.heading.length + s.content.length,
    0,
  );
  if (totalChars >= MIN_SUBSTANCE_CHARS) return true;

  // 备用：检查原始内容中 # 标题之后、## Sources 之前的字符数
  const bodyMatch = content.match(/^#\s+.*$/m);
  if (!bodyMatch) return false;

  const afterTitle = content.slice(bodyMatch.index! + bodyMatch[0].length);
  const sourcesIdx = afterTitle.search(/^##\s+Sources/m);
  const bodyText =
    sourcesIdx !== -1 ? afterTitle.slice(0, sourcesIdx) : afterTitle;

  return bodyText.trim().length >= MIN_SUBSTANCE_CHARS;
}

// ── 卡片生成 ──────────────────────────────────────────

/**
 * 生成 Type A（概念问答）卡片。
 *
 * @param concept 解析后的概念
 * @returns 复习卡片
 */
export function generateQaCard(concept: ParsedConcept): ReviewCard {
  return {
    concept: concept.title,
    slug: concept.slug,
    question: `什么是 ${concept.title}？`,
    answer: concept.bodySections.map(sectionToAnswerSection),
    tags: concept.tags,
    source: concept.source,
    cardType: "qa",
  };
}

/**
 * 生成 Type B（要点回顾）卡片。
 *
 * 从 body sections 中提取关键信息，精简为要点列表。
 *
 * @param concept 解析后的概念
 * @returns 复习卡片
 */
export function generateSummaryCard(concept: ParsedConcept): ReviewCard {
  // 精简每个段落为要点
  const answer = concept.bodySections.map((s) => ({
    heading: s.heading,
    content: summarizeSection(s.content),
  }));

  return {
    concept: concept.title,
    slug: concept.slug,
    question: `回顾 ${concept.title} 的核心要点`,
    answer,
    tags: concept.tags,
    source: concept.source,
    cardType: "summary",
  };
}

/**
 * 生成 Type C（关联连线）卡片。
 *
 * @param concept 解析后的概念
 * @param relatedConcept 关联的概念名
 * @param relationDescription 关系描述
 * @returns 复习卡片
 */
export function generateConnectionCard(
  concept: ParsedConcept,
  relatedConcept: string,
  relationDescription?: string,
): ReviewCard {
  return {
    concept: concept.title,
    slug: concept.slug,
    question: `${concept.title} 和 ${relatedConcept} 有什么关系？`,
    answer: [
      {
        heading: concept.title,
        content: concept.bodySections.map((s) => s.content).join("\n\n"),
      },
      {
        heading: relationDescription ?? RELATION_TEMPLATES.default,
        content: relatedConcept,
      },
    ],
    tags: concept.tags,
    source: concept.source,
    cardType: "connection",
    relatedConcept,
    relationDescription,
  };
}

/**
 * 为某个概念生成所有可能的卡片。
 *
 * @param concept 解析后的概念
 * @param relatedConcept 可选：关联概念名（用于 Type C）
 * @param relationDescription 可选：关系描述（用于 Type C）
 * @returns 卡片数组
 */
export function generateAllCards(
  concept: ParsedConcept,
  relatedConcept?: string,
  relationDescription?: string,
): ReviewCard[] {
  const cards: ReviewCard[] = [];

  cards.push(generateQaCard(concept));
  cards.push(generateSummaryCard(concept));

  if (relatedConcept) {
    cards.push(
      generateConnectionCard(concept, relatedConcept, relationDescription),
    );
  }

  return cards;
}

// ── 格式化 ────────────────────────────────────────────

/**
 * BodySection → AnswerSection（标题翻译）
 *
 * 将英文标题映射为中文标题。
 */
function sectionToAnswerSection(section: BodySection): AnswerSection {
  const heading = translateHeading(section.heading);
  return { heading, content: section.content };
}

/**
 * 英文标题 → 中文标题映射。
 */
function translateHeading(heading: string): string {
  const map: Record<string, string> = {
    概述: "概述",
    "Common Causes": "常见原因",
    "Detection and Prevention": "检测与预防",
    Detection: "检测方法",
    Prevention: "预防措施",
    Examples: "示例",
    Usage: "用法",
    Implementation: "实现",
    Performance: "性能",
    Comparison: "对比",
    Design: "设计",
    Architecture: "架构",
    Background: "背景",
    Motivation: "动机",
    "Key Concepts": "核心概念",
    "How it works": "工作原理",
    "How It Works": "工作原理",
  };

  return map[heading] ?? heading;
}

/**
 * 精简段落内容为要点。
 *
 * 策略：取前 3 句，或前 200 字符（取其短者）。
 */
export function summarizeSection(content: string): string {
  // 按句号、问号、感叹号分割
  const sentences = content
    .split(/(?<=[。？！.!?])\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

  // 取前 3 句
  const selected = sentences.slice(0, 3);
  let result = selected.join("\n");

  // 限制长度 200 字符
  if (result.length > 200) {
    result = result.slice(0, 200) + "…";
  }

  return result;
}
