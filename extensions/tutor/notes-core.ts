/**
 * notes-core — 笔记落盘的纯函数核（Functional Core）。
 *
 * 负责：设置解析、主题校验与路径拼装、以及写进笔记的每一段文本格式
 * （Obsidian callout）。所有 IO 都在 notes-store；这里 value in / value out。
 */

import type { PickerOption } from "../shared/picker-core.ts";
import type { AskDetails } from "./ask-core.ts";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  BIND_NOTES_TOOL_NAME,
  QUIZ_TOOL_NAME,
} from "./names.ts";
import type { QuizDetails } from "./quiz-core.ts";

export const TUTOR_SETTINGS_KEY = "tutor";
export const TUTOR_DEFAULT_VAULT_ROOT = "~/work/notes";
export const TUTOR_DEFAULT_TOP_DIR = "Learn";

export type TopicRejection =
  | "empty"
  | "separator"
  | "parent"
  | "nul"
  | "space"
  | "too-long";

export const TOPIC_REJECTION_REASONS: TopicRejection[] = [
  "empty",
  "separator",
  "parent",
  "nul",
  "space",
  "too-long",
];

/** 章节名长度上限：够长到能表达主题，又不至于变成一句话。 */
export const CHAPTER_MAX_LENGTH = 60;

export type TopicCheck =
  | { ok: true; topic: string }
  | { ok: false; reason: TopicRejection };

/** 主题名必须能安全地变成一个目录名与文件名。 */
export const isValidTopic = (topic: string): TopicCheck => {
  const trimmed = topic.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  if (trimmed.includes("\0")) return { ok: false, reason: "nul" };
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return { ok: false, reason: "separator" };
  }
  if (trimmed.includes("..")) return { ok: false, reason: "parent" };
  // 文件名/目录名一律不许带空白：`/md-topic <主题> <章节>` 靠空格分隔参数，
  // 带空格的名字会让参数解析产生歧义，也让 shell 里到处要加引号。
  if (/\s/.test(trimmed)) return { ok: false, reason: "space" };
  return { ok: true, topic: trimmed };
};

/** `~` 展开在 shell 侧传入 home，保证 core 不碰 env。 */
export const expandHome = (input: string, home: string): string => {
  if (input === "~") return home;
  if (input.startsWith("~/")) return `${home}${input.slice(1)}`;
  return input;
};

export type TutorSettings = {
  vaultRoot: string;
  topDir: string;
  warnings: string[];
};

const asNonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/** 坏配置一律回落默认值并给出 warning，绝不因为设置写错就中断教学。 */
export const resolveTutorSettings = (
  merged: Record<string, unknown> | undefined,
): TutorSettings => {
  const warnings: string[] = [];
  const raw = merged?.[TUTOR_SETTINGS_KEY];
  if (raw !== undefined && (typeof raw !== "object" || raw === null)) {
    warnings.push(
      `settings.${TUTOR_SETTINGS_KEY} must be an object — using defaults`,
    );
  }
  const section = (raw ?? {}) as Record<string, unknown>;

  let vaultRoot = asNonEmptyString(section.vaultRoot);
  if (vaultRoot === undefined) {
    if (section.vaultRoot !== undefined) {
      warnings.push(
        `settings.${TUTOR_SETTINGS_KEY}.vaultRoot must be a non-empty string — using ${TUTOR_DEFAULT_VAULT_ROOT}`,
      );
    }
    vaultRoot = TUTOR_DEFAULT_VAULT_ROOT;
  }

  let topDir = asNonEmptyString(section.topDir);
  if (topDir === undefined) {
    if (section.topDir !== undefined) {
      warnings.push(
        `settings.${TUTOR_SETTINGS_KEY}.topDir must be a non-empty string — using ${TUTOR_DEFAULT_TOP_DIR}`,
      );
    }
    topDir = TUTOR_DEFAULT_TOP_DIR;
  }
  if (topDir.includes("/") || topDir.includes("\\")) {
    warnings.push(
      `settings.${TUTOR_SETTINGS_KEY}.topDir must be a single directory name — using ${TUTOR_DEFAULT_TOP_DIR}`,
    );
    topDir = TUTOR_DEFAULT_TOP_DIR;
  }

  return { vaultRoot, topDir, warnings };
};

const joinPath = (...parts: string[]): string =>
  parts
    .map((part, index) =>
      index === 0 ? part.replace(/\/+$/, "") : part.replace(/^\/+|\/+$/g, ""),
    )
    .filter((part) => part.length > 0)
    .join("/");

/** `<vaultRoot>/<topDir>/<主题>/<主题>.md`（vaultRoot 需已展开 `~`）。 */
export const topicNotePath = (input: {
  vaultRoot: string;
  topDir: string;
  topic: string;
}): string =>
  joinPath(input.vaultRoot, input.topDir, input.topic, `${input.topic}.md`);

export const topicDirOf = (notePath: string): string =>
  notePath.slice(0, Math.max(0, notePath.lastIndexOf("/")));

/** 新笔记的开头：说明这份文件是谁维护的、怎么追加。 */
export const formatTopicHeader = (topic: string): string =>
  `# ${topic}\n\n> 由 tutor 维持：每次教学按时间顺序追加，只增不改。\n`;

/** `<vaultRoot>/<topDir>/<主题>`（vaultRoot 需已展开 `~`；主题名去空白）。 */
export const topicDirPath = (input: {
  vaultRoot: string;
  topDir: string;
  topic: string;
}): string => joinPath(input.vaultRoot, input.topDir, input.topic.trim());

/** 章节与主题共用同一套安全校验，外加长度上限。 */
/** 把名字里的空白去掉，作为给调用方的"建议名"（错误提示里附上，省一轮往返）。 */
export const sanitizeName = (name: string): string =>
  name.trim().replace(/\s+/g, "");

export const isValidChapter = (chapter: string): TopicCheck => {
  const check = isValidTopic(chapter);
  if (check.ok === false) return check;
  if (check.topic.length > CHAPTER_MAX_LENGTH) {
    return { ok: false, reason: "too-long" };
  }
  return check;
};

// ── 章节序号 ────────────────────────────────────────────────────────────
//
// 编号的**唯一权威是文件名**（`03-调度与唤醒.md`），H1、索引行、`## 章节` 块都是它的视图：
// 同一次改动里由 Core 从文件名重算，不可能各自为政。编号只增不改：不重排、不复用，
// 没讲的章留空洞（第5章没开讲，第6章就仍是 06）。

export type ChapterFile = {
  /** 文件名前缀里的编号；旧格式（`名字.md`）没有。 */
  number?: number;
  name: string;
  /** 索引行里的日期（有就沿用，不重算）。 */
  date?: string;
};

/** `第3章 · 调度与唤醒`；没编号时退回裸名字。 */
export const chapterLabel = (
  number: number | undefined,
  name: string,
): string => (number === undefined ? name : `第${number}章 · ${name}`);

/** `03-调度与唤醒`；没编号时退回裸名字。`01`…`99`，三位数自然变三位。 */
export const chapterFileName = (
  number: number | undefined,
  name: string,
): string =>
  number === undefined ? name : `${String(number).padStart(2, "0")}-${name}`;

// 只认 1–3 位的纯数字前缀：`1号进程与生命周期`、`2026-09-18-xxx` 都不算编号。
const CHAPTER_FILE_PREFIX_RE = /^(\d{1,3})-(.+)$/;

/** 文件名（不含 `.md`）→ 编号 + 名字；没有前缀就是旧格式章节。 */
export const parseChapterFileName = (
  base: string,
): { number?: number; name: string } => {
  const match = CHAPTER_FILE_PREFIX_RE.exec(base);
  if (!match) return { name: base };
  return { number: Number(match[1]), name: match[2] };
};

const CHINESE_DIGITS: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** `十` / `十二` / `二十` / `二十三`：够用到教学场景，不做百位以上。 */
const chineseNumber = (text: string): number | undefined => {
  if (text === "十") return 10;
  const tens = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/.exec(text);
  if (tens) {
    const high = tens[1] ? CHINESE_DIGITS[tens[1]] : 1;
    const low = tens[2] ? CHINESE_DIGITS[tens[2]] : 0;
    return high * 10 + low;
  }
  return CHINESE_DIGITS[text];
};

const NUMERAL = "([0-9]{1,3}|[一二两三四五六七八九十]{1,3})";
const CHAPTER_REF_RE = new RegExp(
  `^第\\s*${NUMERAL}\\s*章\\s*[·:：\\-—]?\\s*(.*)$`,
);
const FILE_REF_RE = /^(\d{1,3})-(.+)$/;
const BARE_NUMBER_RE = /^\d{1,3}$/;

const numberFrom = (text: string): number | undefined =>
  /^\d+$/.test(text) ? Number(text) : chineseNumber(text);

/**
 * 人/agent 随手写的章节引用：`第3章`、`第三章`、`第3章 · 调度与唤醒`、`03-调度与唤醒`、`调度与唤醒`。
 * 解析不出来就把整串当名字（名字校验在调用侧，保持这个函数不做拒绝）。
 */
export const parseChapterRef = (
  text: string,
): { number?: number; name?: string } => {
  const trimmed = text.trim();
  const chapter = CHAPTER_REF_RE.exec(trimmed);
  if (chapter) {
    const rest = chapter[2].trim();
    return rest.length > 0
      ? { number: numberFrom(chapter[1]), name: rest }
      : { number: numberFrom(chapter[1]) };
  }
  const file = FILE_REF_RE.exec(trimmed);
  if (file) return { number: Number(file[1]), name: file[2] };
  if (BARE_NUMBER_RE.test(trimmed)) return { number: Number(trimmed) };
  return { name: trimmed };
};

/** 省略编号的章节页：`<topic>/<topic>.md`；给出时：`<topic>/<NN-名字>.md`。 */
export const chapterNotePath = (input: {
  vaultRoot: string;
  topDir: string;
  topic: string;
  chapter?: string;
  number?: number;
}): string => {
  const chapter = input.chapter?.trim();
  return joinPath(
    input.vaultRoot,
    input.topDir,
    input.topic,
    chapter
      ? `${chapterFileName(input.number, chapter)}.md`
      : `${input.topic}.md`,
  );
};

/** 新章节文件的开头：标明它属于哪个主题、是第几章。 */
export const formatSectionHeader = (
  topic: string,
  chapter: string,
  number?: number,
): string =>
  `# ${chapterLabel(number, chapter)}\n\n> 《${topic}》${
    number === undefined ? "的一章" : `第 ${number} 章`
  } · 由 tutor 维持：按时间顺序追加，只增不改。\n`;

/** 迁移旧章节时改首行：只有它整行就是章节名（允许空白差异）才改，用户自己改过就不碰。 */
export const rewriteChapterHeading = (
  markdown: string,
  name: string,
  number: number,
): string => {
  const lines = markdown.split("\n");
  const current = /^#\s+(.*)$/.exec((lines[0] ?? "").trim())?.[1]?.trim();
  if (current === undefined) return markdown;
  // 旧笔记里标题带空格（`# chroot 与挂载时机`），名字后来去了空格：同名字才认。
  if (current.replace(/\s+/g, "") !== name.replace(/\s+/g, "")) return markdown;
  lines[0] = `# ${chapterLabel(number, name)}`;
  return lines.join("\n");
};

export const nextChapterNumber = (taken: number[]): number =>
  taken.length === 0 ? 1 : Math.max(...taken) + 1;

export type NumberingConflict = {
  /** 被顶掉的编号。 */
  requested: number;
  /** 占用者的标签：`第3章 · 调度与唤醒`。 */
  occupant: string;
  /** 已用编号（升序）。 */
  taken: number[];
  /** 已用编号之间的空洞（升序）：可以显式指定这些号来补讲漏掉的章。 */
  gaps: number[];
  /** 省略 `chapterNumber` 会自动取到的号。 */
  auto: number;
};

/** 冲突文案：把"下一步怎么改"一次给全，agent 一轮就能自纠。 */
export const formatNumberingConflict = (conflict: NumberingConflict): string =>
  [
    `chapterNumber ${conflict.requested} 已被「${conflict.occupant}」占用`,
    `已用编号 ${conflict.taken.join(",")}`,
    `空闲 ${conflict.gaps.length > 0 ? conflict.gaps.join(",") : "(无)"}`,
    `省略 chapterNumber 会自动取 ${conflict.auto}`,
  ].join("；");

export type NumberingDecision =
  | { ok: true; number: number }
  | { ok: false; hint: string; conflict: NumberingConflict | null };

const positiveInt = (value: number | undefined): boolean =>
  value === undefined || (Number.isInteger(value) && value >= 1);

const conflictOf = (input: {
  requested: number;
  chapters: ChapterFile[];
}): NumberingConflict => {
  const numbers = input.chapters
    .flatMap((chapter) =>
      chapter.number === undefined ? [] : [chapter.number],
    )
    .sort((a, b) => a - b);
  const taken = [...new Set(numbers)];
  const occupant = input.chapters.find(
    (chapter) => chapter.number === input.requested,
  );
  const gaps: number[] = [];
  const max = taken.length > 0 ? taken[taken.length - 1] : 0;
  for (let n = 1; n <= max; n++) if (!taken.includes(n)) gaps.push(n);
  return {
    requested: input.requested,
    occupant: occupant ? chapterLabel(occupant.number, occupant.name) : "?",
    taken,
    gaps,
    auto: nextChapterNumber(taken),
  };
};

/**
 * 定号：该章已有编号就沿用它（显式要求不同则冲突）；否则显式值空闲则采用，
 * 未指定则取"未占用的下一个号"——空洞不会被自动填。
 */
export const resolveChapterNumber = (input: {
  existing?: number;
  requested?: number;
  chapters: ChapterFile[];
}): NumberingDecision => {
  if (!positiveInt(input.requested)) {
    return {
      ok: false,
      hint: `chapterNumber must be a positive integer, got ${input.requested}`,
      conflict: null,
    };
  }
  const taken = input.chapters.flatMap((chapter) =>
    chapter.number === undefined || chapter.number === input.existing
      ? []
      : [chapter.number],
  );
  if (input.existing !== undefined) {
    if (input.requested !== undefined && input.requested !== input.existing) {
      return {
        ok: false,
        hint: `这一章已经编号为 第${input.existing}章；本工具不重排已编号章节，要改编号请手工处理`,
        conflict: null,
      };
    }
    return { ok: true, number: input.existing };
  }
  if (input.requested === undefined) {
    return { ok: true, number: nextChapterNumber(taken) };
  }
  if (taken.includes(input.requested)) {
    const conflict = conflictOf({
      requested: input.requested,
      chapters: input.chapters,
    });
    return { ok: false, hint: formatNumberingConflict(conflict), conflict };
  }
  return { ok: true, number: input.requested };
};

/** 索引页里的章节行（只在首次绑定该章时追加）。编号缺省时保留旧格式。 */
export const indexEntryLine = (input: {
  name: string;
  date: string;
  number?: number;
}): string =>
  input.number === undefined
    ? `- [[${input.name}]] · ${input.date}`
    : `- 第${input.number}章 · [[${chapterFileName(input.number, input.name)}|${input.name}]] · ${input.date}`;

export type IndexEntry = {
  number?: number;
  /** 章节名（别名优先，否则取 wikilink 目标去掉编号前缀）。 */
  name: string;
  /** wikilink 目标（文件名，不含 `.md`）。 */
  fileName: string;
  date?: string;
  line: string;
};

const INDEX_LINE_RE =
  /^>?\s*-\s*第(\d+)章\s*·\s*\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/;
const LEGACY_INDEX_LINE_RE = /^>?\s*-\s*\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/;
const INDEX_DATE_RE = /·\s*(\d{4}-\d{2}-\d{2})\s*$/;

/** 解析索引页里的章节行（含旧格式 `- [[名字]] · 日期` 与 provenance 的 `> - ` 形式）。 */
export const parseIndexEntries = (index: string): IndexEntry[] => {
  const entries: IndexEntry[] = [];
  for (const line of index.split("\n")) {
    const trimmed = line.trim();
    const numbered = INDEX_LINE_RE.exec(trimmed);
    // 两个正则的分组编号不同：带编号的 1=编号 2=目标 3=别名；旧的 1=目标 2=别名。
    const legacy = numbered ? null : LEGACY_INDEX_LINE_RE.exec(trimmed);
    const target = numbered ? numbered[2] : legacy?.[1];
    if (target === undefined) continue;
    const alias = numbered ? numbered[3] : legacy?.[2];
    const parsed = parseChapterFileName(target);
    entries.push({
      number: numbered ? Number(numbered[1]) : parsed.number,
      name: alias ?? parsed.name,
      fileName: target,
      date: INDEX_DATE_RE.exec(trimmed)?.[1],
      line,
    });
  }
  return entries;
};

/** 用解析后的条目按名字匹配，避免 `[[X2]]` 被误判成含 `[[X]]`。 */
export const hasIndexEntry = (index: string, name: string): boolean =>
  parseIndexEntries(index).some((entry) => entry.name === name);

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 列表行补上「第N章 ·」前缀：只改带本章链接的列表行（正文引用不动）。 */
const addChapterNumberToLine = (
  line: string,
  number: number,
  fileName: string,
): string => {
  if (/^\s*>?\s*-\s+第\d+章\s*·/.test(line)) return line;
  if (!/^\s*>?\s*-\s+\[\[/.test(line)) return line;
  if (!line.includes(`[[${fileName}`)) return line;
  return line.replace(/^(\s*>?\s*-\s+)/, `$1第${number}章 · `);
};

/**
 * 把索引里指向该章的 wikilink 全部改写成带编号的形式（列表行、provenance 行、行内提及都算），
 * 列表行同时补上 `第N章 ·` 前缀；已带正确编号的不重复改写，正文里的裸文字引用不动。
 */
export const relinkIndex = (
  index: string,
  input: { name: string; number?: number; fileName: string },
): string => {
  if (input.number === undefined) return index;
  const targets = new Set([input.name, input.fileName]);
  let result = index;
  for (const target of targets) {
    const pattern = new RegExp(
      `\\[\\[${escapeRegExp(target)}(\\|[^\\]]*)?\\]\\]`,
      "g",
    );
    result = result.replace(
      pattern,
      (_match, alias: string | undefined) =>
        `[[${input.fileName}${alias ?? `|${input.name}`}]]`,
    );
  }
  return result
    .split("\n")
    .map((line) =>
      addChapterNumberToLine(line, input.number as number, input.fileName),
    )
    .join("\n");
};

/** `## 章节` 机器块的定界符：块内章节行由工具重写，块外一字不动。 */
export const CHAPTERS_BEGIN =
  "<!-- tutor:chapters 由工具维护：本行与结束行为定界符，块内章节行由 bind_notes / number_chapters 重写 -->";
export const CHAPTERS_END = "<!-- /tutor:chapters -->";

/** 章节行：编号标签里嵌 wikilink（`第3章 · [[03-调度与唤醒|调度与唤醒]]`）。 */
export const chapterTocLine = (chapter: ChapterFile): string => {
  const link = `[[${chapterFileName(chapter.number, chapter.name)}|${chapter.name}]]`;
  const label = chapterLabel(chapter.number, chapter.name).replace(
    chapter.name,
    () => link,
  );
  return chapter.date ? `- ${label} · ${chapter.date}` : `- ${label}`;
};

export const chapterTocBlock = (chapters: ChapterFile[]): string =>
  [
    "## 章节",
    "",
    CHAPTERS_BEGIN,
    ...chapters.map(chapterTocLine),
    CHAPTERS_END,
  ].join("\n");

/**
 * 标题区（`# 主题` + 紧随的引用说明行）之后的位置：新块插在这里。
 * 遇到 callout（`> [!…]`）就停——那是正文的第一块，不是标题的一部分。
 */
const headerEnd = (lines: string[]): number => {
  let i = 0;
  const skipBlank = (): void => {
    while (i < lines.length && lines[i].trim().length === 0) i++;
  };
  skipBlank();
  if (i < lines.length && lines[i].startsWith("# ")) {
    i++;
    skipBlank();
    while (
      i < lines.length &&
      lines[i].startsWith(">") &&
      !/^>\s*\[!/.test(lines[i])
    ) {
      i++;
      skipBlank();
    }
  }
  return i;
};

/**
 * 重建 `## 章节` 块：有定界符就原地重写，没有就插到标题区之后；空列表不改动索引
 * （新主题第一次绑定章节时才长出来）。用户删掉定界符后，工具不再碰该块。
 */
export const upsertChapterToc = (
  index: string,
  chapters: ChapterFile[],
): string => {
  if (chapters.length === 0) return index;
  const block = chapterTocBlock(chapters);
  const begin = index.indexOf(CHAPTERS_BEGIN);
  const end = index.indexOf(CHAPTERS_END);
  if (begin >= 0 && end > begin) {
    // 定界符之间的旧章节行（含 `## 章节` 标题本身所在的那一段）整段换成新块。
    const before = index.slice(0, begin);
    const head = before.replace(/##\s*章节\s*\n+\s*$/, "");
    const after = index.slice(end + CHAPTERS_END.length).replace(/^\n+/, "");
    return joinParts([head, block, after]);
  }
  const lines = index.split("\n");
  const at = headerEnd(lines);
  return joinParts([
    lines.slice(0, at).join("\n"),
    block,
    lines.slice(at).join("\n"),
  ]);
};

const joinParts = (parts: string[]): string =>
  parts
    .map((part) => part.replace(/^\n+/, "").replace(/\n+$/, ""))
    .filter((part) => part.length > 0)
    .join("\n\n")
    .concat("\n");

// ── 会话镜像的块格式（Obsidian callout） ──────────────────────────────────

/** callout 头（`> [!type] title`）：写与读共用同一份契约。 */
const CALLOUT_RE = /^>\s*\[!(\w+)\]\s*(.*)$/;

const callout = (type: string, title: string, bodyLines: string[]): string => {
  const lines = [`> [!${type}] ${title}`];
  for (const line of bodyLines) {
    lines.push(line.length === 0 ? ">" : `> ${line}`);
  }
  return lines.join("\n");
};

/** skill 注入的大段 SKILL.md 不是用户的话，压缩成一行提示。 */
export const stripSkillBlocks = (text: string): string =>
  text.replace(
    /<skill\b([^>]*)>[\s\S]*?<\/skill>/g,
    (_match, attrs: string) => {
      const name = /name="([^"]+)"/.exec(attrs)?.[1];
      return `> [!note] SKILL loaded: ${name ?? "(unknown)"}`;
    },
  );

export const formatUserBlock = (text: string): string =>
  `> [!quote] YOU\n\n${text}`;

export const formatAssistantBlock = (text: string): string =>
  `> [!abstract] PI\n\n${text}`;

const toLines = (text: string): string[] => text.split("\n");

export type QuestionBlockInput = {
  kind: "Quiz" | "Question";
  question: string;
  context?: string;
  options: Array<{ index: number; label: string }>;
};

/** 问题块：永远不含正确答案与解释（笔记是用户会读的）。 */
export const formatQuestionBlock = (input: QuestionBlockInput): string => {
  const body: string[] = [...toLines(input.question)];
  if (input.context) {
    body.push("", ...toLines(input.context));
  }
  if (input.options.length > 0) {
    body.push(
      "",
      ...input.options.map((option) => `${option.index}. ${option.label}`),
    );
  }
  return callout("question", input.kind, body);
};

/**
 * 从一条 assistant 消息的内容里抽出 `quiz` / `ask_user_question` 已经问过的题面。
 * 用来判断"这条消息的题面由工具负责写"。
 */
export const toolCallQuestions = (content: unknown): string[] => {
  if (!Array.isArray(content)) return [];
  const questions: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const block = part as {
      type?: unknown;
      name?: unknown;
      arguments?: unknown;
    };
    if (block.type !== "toolCall") continue;
    if (
      block.name !== QUIZ_TOOL_NAME &&
      block.name !== ASK_USER_QUESTION_TOOL_NAME
    ) {
      continue;
    }
    const args = block.arguments as { question?: unknown } | undefined;
    const question = args?.question;
    if (typeof question === "string" && question.trim())
      questions.push(question);
  }
  return questions;
};

/** 丢掉正文里手写的题面块（它们跟工具写的题面重复）。代码围栏里的样例不动。 */
export const stripQuestionCallouts = (text: string): string => {
  const lines = text.split("\n");
  const kept: string[] = [];
  let removed = false;
  let inFence = false;
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)/.test(line);
    if (inFence || fence) {
      // 围栏里的 `> [!question]` 是字面内容（模型有时贴笔记格式的样例）。
      if (fence) inFence = !inFence;
      kept.push(line);
      i += 1;
      continue;
    }
    const header = CALLOUT_RE.exec(line);
    if (header?.[1].toLowerCase() !== "question") {
      kept.push(line);
      i += 1;
      continue;
    }
    // 题面块 = 头 + 其后的连续 `>` 行。
    i += 1;
    while (i < lines.length && lines[i].startsWith(">")) i += 1;
    removed = true;
    while (kept.length > 0 && kept[kept.length - 1].trim().length === 0) {
      kept.pop();
    }
  }
  const stripped = kept.join("\n");
  return (removed ? stripped.replace(/\n{3,}/g, "\n\n") : stripped)
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");
};

/**
 * 会话镜像用：一条 assistant 消息最终写进笔记的正文。
 *
 * 笔记里的题面只有一个权威写者：`quiz` / `ask_user_question` 的 pending 块——
 * 顺序是学习者实际看到的，判定块的序号也按它算。模型常照笔记格式在正文里再写
 * 一遍，那份是作者顺序的旧副本：同一道题出现两次，序号还跟判定块对不上。
 *
 * 判重不能靠文本相似度——模型会改写措辞（"下面这段" vs 把 SQL 抄进题面）、调换
 * 选项顺序、加减行内代码，比对认不出来。所以规则取在更上游：**只要这条消息里有
 * 工具在提问，正文里的 `> [!question]` 块就一律不写进笔记**。没有工具提问的正文
 * （纯对话里问的问题）原样保留——那是它唯一的一份。
 */
export const mirrorAssistantText = (content: unknown): string => {
  const text = messageText(content as MessageContent);
  return toolCallQuestions(content).length > 0
    ? stripQuestionCallouts(text)
    : text;
};

// ── 镜像闸门：同轮 bind 的块归属（纯） ────────────────────────────────────
//
// pi 的事件顺序是「消息定稿（message_end）→ 工具执行」，所以一条消息里同时有
// 「本章正文 + `bind_notes` 调用」时，正文会在 bind 生效**之前**被镜像出去 ——
// 也就是写进上一章的文件（实录：本主题连错三章）。
//
// 闸门把这条消息产出的块先扣住，等 bind 的 tool_result 回来（此刻镜像目标已经
// 切到新章节）再按原顺序放行。代价：模型在同一轮里先收尾上一章、再写新章开场
// 时，那句收尾也会跟着进新章文件；但「整章开场落进上一章文件」不会再发生。

/** 一条 assistant 消息里会切换镜像目标的 tool call id（顺序即消息顺序）。 */
export const bindToolCallIds = (content: unknown): string[] => {
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const block = part as { type?: unknown; name?: unknown; id?: unknown };
    if (block.type !== "toolCall") continue;
    if (block.name !== BIND_NOTES_TOOL_NAME) continue;
    if (typeof block.id === "string" && block.id.length > 0) ids.push(block.id);
  }
  return ids;
};

export type MirrorPending = {
  /** 还没回结果的 bind 调用 id：全部回来才开闸。 */
  binds: string[];
  /** 关闸期间排队的块，按产出顺序。 */
  blocks: string[];
};

export type MirrorEvent =
  | { kind: "assistant"; block: string; binds: string[] }
  | { kind: "block"; block: string }
  | { kind: "bindResult"; toolCallId: string }
  | { kind: "flush" };

export type MirrorStep = { pending: MirrorPending | null; append: string[] };

/** 空块一律丢掉：既不占位，也不进 pending（笔记里不该出现空块）。 */
const nonEmpty = (...blocks: string[]): string[] =>
  blocks.filter((block) => block.length > 0);

/**
 * 闸门状态机（value in / value out）：给一个事件，返回「新的 pending + 现在该落盘的块」。
 *
 * - `assistant` 带 bind：关闸持有；旧 pending 若还扣着东西（上一个 bind 没回结果），先放行再持有。
 * - `assistant` 不带 bind：开闸放行（pending 里扣着的先出，保持顺序）。
 * - `block`：关闸期间排队，否则立即放行。
 * - `bindResult`：认领自己那批 id；全部回来才放行。
 * - `flush`：兜底放行 —— 工具失败/中断时宁可落在旧文件，绝不丢字。
 */
export const mirrorStep = (
  pending: MirrorPending | null,
  event: MirrorEvent,
): MirrorStep => {
  const held = pending ? nonEmpty(...pending.blocks) : [];
  switch (event.kind) {
    case "assistant":
      return event.binds.length > 0
        ? {
            pending: { binds: [...event.binds], blocks: nonEmpty(event.block) },
            append: held,
          }
        : { pending: null, append: nonEmpty(...held, event.block) };
    case "block":
      if (event.block.length === 0) return { pending, append: [] };
      return pending
        ? {
            pending: { ...pending, blocks: [...pending.blocks, event.block] },
            append: [],
          }
        : { pending: null, append: [event.block] };
    case "bindResult": {
      if (!pending) return { pending: null, append: [] };
      const binds = pending.binds.filter((id) => id !== event.toolCallId);
      if (binds.length === pending.binds.length) return { pending, append: [] };
      return binds.length > 0
        ? { pending: { binds, blocks: pending.blocks }, append: [] }
        : { pending: null, append: held };
    }
    case "flush":
      return { pending: null, append: held };
  }
};

const correctAnswerLines = (details: QuizDetails): string[] =>
  (details.correctIndices ?? []).map((index) => {
    const label = details.options.find(
      (option) => option.index === index,
    )?.label;
    return label ? `${index}. ${label}` : `${index}`;
  });

export const formatQuizAnswerBlock = (details: QuizDetails): string => {
  if (details.status === "cancelled") {
    return callout("warning", "Quiz — cancelled", ["(user skipped)"]);
  }
  if (details.status === "unavailable") {
    return callout("warning", "Quiz — unavailable", [details.message]);
  }
  const dontKnow = details.dontKnow === true;
  const title = dontKnow
    ? "Quiz — I don't know"
    : details.isCorrect
      ? "Quiz — correct ✓"
      : "Quiz — incorrect ✗";
  // 不要用 "question"：那个类型留给题面（约定：question 块不含答案），判定块里会
  // 写出正确答案，用 "info" 让这条不变量在类型层面成立。
  const type = dontKnow ? "info" : details.isCorrect ? "success" : "failure";

  const body: string[] = [];
  if (dontKnow) {
    body.push("Your answer: I don't know");
  } else {
    const picked =
      (details.answers ?? [])
        .map((answer) => `${answer.index}. ${answer.label}`)
        .join(", ") || "(none)";
    body.push(`Your answer: ${picked}`);
  }
  body.push(
    `Correct answer: ${correctAnswerLines(details).join(", ") || "(none)"}`,
  );
  if (details.explanation) {
    body.push("", ...toLines(details.explanation));
  }
  return callout(type, title, body);
};

export const formatAskAnswerBlock = (details: AskDetails): string => {
  if (details.status === "cancelled") {
    return callout("warning", "Question — cancelled", ["(user skipped)"]);
  }
  if (details.status === "unavailable") {
    return callout("warning", "Question — unavailable", [details.message]);
  }
  const body: string[] = [];
  if (details.otherText) {
    body.push(`Other: ${details.otherText}`);
  }
  body.push(
    ...details.selections.map(
      (selection) => `${selection.index}. ${selection.label}`,
    ),
  );
  if (body.length === 0) body.push("(no answer)");
  return callout("example", "Answer", body);
};

export const isQuizDetails = (details: unknown): details is QuizDetails =>
  typeof details === "object" &&
  details !== null &&
  Array.isArray((details as QuizDetails).options) &&
  "correctValues" in details;

/**
 * `details` 是从工具结果拿来的、**没有类型保证的 JSON**，所以先认形状再排版：
 * - quiz 的校验错误会带回 `details: {}`（pi 把工具自填的 isError 归一成 false，
 *   所以 isError 靠不住），历史会话里也可能冻着旧形状；
 * - `pending` 归问题块管，答案块只处理 answered / cancelled / unavailable。
 */
const answerDetailsOf = (
  value: unknown,
): QuizDetails | AskDetails | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const status = (value as { status?: unknown }).status;
  if (
    status !== "answered" &&
    status !== "cancelled" &&
    status !== "unavailable"
  ) {
    return undefined;
  }
  if (isQuizDetails(value)) return value;
  return Array.isArray((value as AskDetails).selections)
    ? (value as AskDetails)
    : undefined;
};

/** 返回 undefined = 这条工具结果没有可写的答案；调用方跳过即可，不要写空块。 */
export const formatAnswerBlock = (details: unknown): string | undefined => {
  const answer = answerDetailsOf(details);
  if (!answer) return undefined;
  return isQuizDetails(answer)
    ? formatQuizAnswerBlock(answer)
    : formatAskAnswerBlock(answer);
};

// ── 从会话消息里抽取可读文本 ──────────────────────────────────────────────

export type MessageContent =
  | string
  | Array<{ type?: string; text?: string }>
  | undefined;

export const messageText = (content: MessageContent): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => (part.text as string).trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
};

// ── 块解析：把一篇笔记切成"段"（纯） ─────────────────────────────────────
//
// 段 = 一个 callout 起头 + 直到下一个 callout 之前的行。这样所有行都有归属，
// 存量拆分才能做到"每个块恰好出现一次、内容逐字不变"。

export type BlockKind =
  | "prose"
  | "question"
  | "answer"
  | "quiz"
  | "verdict"
  | "warning"
  | "other";

export type NoteBlock = {
  kind: BlockKind;
  title: string;
  /** 段在原文里的行范围（0-based，含头不含尾）。 */
  startLine: number;
  endLine: number;
  /** 段文本（末尾空行已规整）。 */
  text: string;
};

const blockKind = (type: string, title: string): BlockKind => {
  const lower = type.toLowerCase();
  if (lower === "question") {
    // 兼容旧笔记：早期「我不知道」判定块用的是 [!question]（现在是 [!info]），
    // 若把它当题面会被误算成"未作答"。带 ✓/✗/I don't know 的标题一律算判定。
    if (/✓|✗|I don't know/.test(title)) return "verdict";
    return title.startsWith("Quiz") ? "quiz" : "question";
  }
  if (lower === "example") return "answer";
  if (lower === "success" || lower === "failure" || lower === "info")
    return "verdict";
  if (lower === "warning") return "warning";
  if (lower === "quote" || lower === "abstract") return "prose";
  return "other";
};

export const parseNoteBlocks = (markdown: string): NoteBlock[] => {
  const lines = markdown.split("\n");
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (CALLOUT_RE.test(lines[i])) starts.push(i);
  }
  return starts.map((start, position) => {
    const endLine =
      position + 1 < starts.length ? starts[position + 1] : lines.length;
    const match = CALLOUT_RE.exec(lines[start]);
    const title = (match?.[2] ?? "").trim();
    return {
      kind: blockKind(match?.[1] ?? "", title),
      title,
      startLine: start,
      endLine,
      text: lines.slice(start, endLine).join("\n").replace(/\n+$/, ""),
    };
  });
};

export const parseChapterBlocks = (markdown: string): BlockKind[] =>
  parseNoteBlocks(markdown).map((block) => block.kind);

export const isQuestionish = (kind: BlockKind): boolean =>
  kind === "quiz" || kind === "question";

export type VerdictCounts = {
  ok: number;
  wrong: number;
  gaps: number;
  unanswered: number;
};

/**
 * 数判定块，并把"题面后面没有判定"记为 unanswered（错一题、漏一题都能看出来）。
 * 判定标题由 notes-core 自己生成，所以这里的字符串匹配是同一份契约的两面。
 */
export const countVerdicts = (blocks: NoteBlock[]): VerdictCounts => {
  const counts: VerdictCounts = { ok: 0, wrong: 0, gaps: 0, unanswered: 0 };
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.kind === "verdict") {
      if (block.title.includes("I don't know")) counts.gaps++;
      else if (block.title.includes("✓")) counts.ok++;
      else if (block.title.includes("✗")) counts.wrong++;
      else counts.gaps++; // 未知判定按"未答对"计，宁可显眼也别悄悄丢
      continue;
    }
    if (!isQuestionish(block.kind)) continue;
    let answered = false;
    for (let j = i + 1; j < blocks.length; j++) {
      const next = blocks[j];
      if (isQuestionish(next.kind)) break;
      if (next.kind === "verdict" || next.kind === "answer") {
        answered = true;
        break;
      }
    }
    if (!answered) counts.unanswered++;
  }
  return counts;
};

export type ChapterState = {
  /** 文件名前缀里的编号；未编号的旧章节没有。 */
  number?: number;
  name: string;
  path: string;
  touchedAt?: string;
  ok: number;
  wrong: number;
  gaps: number;
  unanswered: number;
  lastBlock: BlockKind | null;
};

export const summarizeChapter = (input: {
  number?: number;
  name: string;
  path: string;
  markdown: string;
  touchedAt?: string;
}): ChapterState => {
  const blocks = parseNoteBlocks(input.markdown);
  return {
    number: input.number,
    name: input.name,
    path: input.path,
    touchedAt: input.touchedAt,
    ...countVerdicts(blocks),
    lastBlock: blocks.at(-1)?.kind ?? null,
  };
};

export type ResumeReason = "unanswered-question" | "cancelled" | "recent";
export type Resume = { chapter: string; reason: ResumeReason };

const mostRecent = (chapters: ChapterState[]): ChapterState | undefined => {
  let best: ChapterState | undefined;
  for (const chapter of chapters) {
    if (!best) {
      best = chapter;
      continue;
    }
    if ((chapter.touchedAt ?? "") >= (best.touchedAt ?? "")) best = chapter;
  }
  return best;
};

/** 续做指向：未作答的题面 > 被打断的 cancelled > 最近改动。 */
export const pickResume = (chapters: ChapterState[]): Resume | undefined => {
  if (chapters.length === 0) return undefined;
  const dangling = chapters.filter((chapter) => chapter.unanswered > 0);
  if (dangling.length > 0) {
    const pick = mostRecent(dangling) ?? dangling[dangling.length - 1];
    return { chapter: pick.name, reason: "unanswered-question" };
  }
  const cancelled = chapters.filter(
    (chapter) => chapter.lastBlock === "warning",
  );
  if (cancelled.length > 0) {
    const pick = mostRecent(cancelled) ?? cancelled[cancelled.length - 1];
    return { chapter: pick.name, reason: "cancelled" };
  }
  return {
    chapter: (mostRecent(chapters) ?? chapters[chapters.length - 1]).name,
    reason: "recent",
  };
};

export type TopicState = {
  topic: string;
  index: string;
  chapters: ChapterState[];
  resume?: Resume;
};

export const buildTopicState = (input: {
  topic: string;
  index: string;
  chapters: ChapterState[];
}): TopicState => ({
  topic: input.topic,
  index: input.index,
  chapters: input.chapters,
  resume: pickResume(input.chapters),
});

// ── 章节 picker 的行（纯） ──────────────────────────────────────────────

export const CHAPTER_PICKER_NEW_ID = "__new_chapter__";
export const CHAPTER_PICKER_INDEX_ID = "__topic_index__";

/**
 * 章节 picker 的行：已有章节（按传入顺序，调用方已排序）+「＋新建章节…」+「主题索引页」。
 * resume 那章标 `· 续做`，并作为初始光标（没有 resume 就 0）。
 */
export const chapterPickerOptions = (input: {
  chapters: ChapterState[];
  resume?: Resume;
}): { rows: PickerOption[]; cursor: number } => ({
  rows: [
    ...input.chapters.map((chapter) => ({
      id: `chapter:${chapter.name}`,
      label: `${chapterLabel(chapter.number, chapter.name)}${
        input.resume?.chapter === chapter.name ? " · 续做" : ""
      }`,
      value: chapter.name,
      kind: "option" as const,
    })),
    {
      id: CHAPTER_PICKER_NEW_ID,
      label: "＋ 新建章节…",
      value: CHAPTER_PICKER_NEW_ID,
      kind: "other" as const,
    },
    {
      id: CHAPTER_PICKER_INDEX_ID,
      label: "主题索引页（不绑定章节）",
      value: CHAPTER_PICKER_INDEX_ID,
      kind: "option" as const,
    },
  ],
  cursor: Math.max(
    0,
    input.chapters.findIndex(
      (chapter) => chapter.name === input.resume?.chapter,
    ),
  ),
});

// ── 存量编号迁移（纯）：顺序 → 编号计划 ──────────────────────────────────

export type NumberingAssignment = {
  name: string;
  number: number;
  /** 当前文件名（不含 `.md`）。 */
  from: string;
  /** 目标文件名（不含 `.md`）。 */
  to: string;
  /** 已经有这个编号：计划里保留，落盘时跳过。 */
  unchanged: boolean;
};

export type NumberingPlanConflict = { name: string; hint: string };

export type NumberingPlan =
  | {
      ok: true;
      assignments: NumberingAssignment[];
      /** 既没编号也没进本次顺序的章节：报告用，不落盘。 */
      unassigned: ChapterFile[];
    }
  | { ok: false; conflicts: NumberingPlanConflict[] };

/**
 * 迁移计划：把"按讲解顺序排好的章节名"映射成编号。
 * 已编号的章节必须与计划一致（本工具不重排已编号章节），不会自动填空洞。
 */
export const planNumbering = (input: {
  chapters: string[];
  existing: ChapterFile[];
  startAt?: number;
}): NumberingPlan => {
  const conflicts: NumberingPlanConflict[] = [];
  const known = parseChapterRefInput(input.chapters, input.existing, conflicts);
  const startAt = input.startAt ?? 1;
  const assignments: NumberingAssignment[] = [];
  const inList = new Set(known.map((entry) => entry.chapter.name));
  const takenNumbers = new Map<number, string>();

  known.forEach((entry, position) => {
    // 顺序里的名字可以自带编号（`第6章 · 加锁规则地图`）：没讲的那章就留出空洞。
    const number = entry.number ?? startAt + position;
    const { chapter } = entry;
    const claimant = takenNumbers.get(number);
    if (claimant !== undefined) {
      conflicts.push({
        name: chapter.name,
        hint: `编号 ${number} 在顺序里同时给了「${claimant}」和「${chapter.name}」`,
      });
      return;
    }
    takenNumbers.set(number, chapter.name);
    if (chapter.number !== undefined && chapter.number !== number) {
      conflicts.push({
        name: chapter.name,
        hint: `「${chapterLabel(chapter.number, chapter.name)}」已经编号为 ${chapter.number}，计划要改成 ${number}；本工具不重排已编号章节，请把顺序改成与现有编号一致`,
      });
      return;
    }
    if (chapter.number === undefined) {
      const occupant = input.existing.find(
        (other) => other.number === number && !inList.has(other.name),
      );
      if (occupant) {
        conflicts.push({
          name: chapter.name,
          hint: `编号 ${number} 已被「${chapterLabel(occupant.number, occupant.name)}」占用；把这一章排到另一个位置`,
        });
        return;
      }
    }
    assignments.push({
      name: chapter.name,
      number,
      from: chapterFileName(chapter.number, chapter.name),
      to: chapterFileName(number, chapter.name),
      unchanged: chapter.number === number,
    });
  });

  if (conflicts.length > 0) return { ok: false, conflicts };
  return {
    ok: true,
    assignments,
    unassigned: input.existing.filter(
      (chapter) => chapter.number === undefined && !inList.has(chapter.name),
    ),
  };
};

/** 名字解析成目录里的章节：找不到 / 重复都在这里变成冲突。 */
const parseChapterRefInput = (
  names: string[],
  existing: ChapterFile[],
  conflicts: NumberingPlanConflict[],
): { chapter: ChapterFile; number?: number }[] => {
  const seen = new Set<string>();
  const result: { chapter: ChapterFile; number?: number }[] = [];
  for (const raw of names) {
    const ref = parseChapterRef(raw);
    const name = ref.name ?? ref.number?.toString() ?? raw;
    const matches = existing.filter((entry) => entry.name === name);
    if (matches.length === 0) {
      conflicts.push({ name, hint: `目录里没有章节「${name}」` });
      continue;
    }
    if (matches.length > 1) {
      conflicts.push({
        name,
        hint: `目录里有两份「${name}」：${matches
          .map((entry) => `${chapterFileName(entry.number, entry.name)}.md`)
          .join(" 与 ")} —— 先手工删掉多余的那份再编号`,
      });
      continue;
    }
    if (seen.has(name)) {
      conflicts.push({ name, hint: `「${name}」在顺序里出现了两次` });
      continue;
    }
    seen.add(name);
    result.push({ chapter: matches[0], number: ref.number });
  }
  return result;
};

/** 建议顺序：先按索引行顺序，再把没进索引的章节按最近改动排在后。 */
export const proposeChapterOrder = (input: {
  chapters: (ChapterFile & { touchedAt?: string })[];
  indexOrder: string[];
}): string[] => {
  const ranked: string[] = [];
  for (const name of input.indexOrder) {
    if (
      input.chapters.some((chapter) => chapter.name === name) &&
      !ranked.includes(name)
    ) {
      ranked.push(name);
    }
  }
  const rest = input.chapters
    .filter((chapter) => !ranked.includes(chapter.name))
    .sort((a, b) => (a.touchedAt ?? "").localeCompare(b.touchedAt ?? ""))
    .map((chapter) => chapter.name);
  return [...ranked, ...rest];
};

// ── 存量拆分（纯）：块目录 + 计划 + provenance ────────────────────────────

export type BlockCatalogEntry = {
  index: number;
  kind: BlockKind;
  preview: string;
};

const truncateText = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;

const previewOf = (block: NoteBlock): string => {
  const body = block.text
    .split("\n")
    .slice(1)
    .map((line) => line.replace(/^>\s?/, "").trim())
    .find((line) => line.length > 0);
  return truncateText(body ?? block.title, 60);
};

export const catalogBlocks = (markdown: string): BlockCatalogEntry[] =>
  parseNoteBlocks(markdown).map((block, position) => ({
    index: position + 1,
    kind: block.kind,
    preview: previewOf(block),
  }));

export type ChapterAssignment = { name: string; blockIndexes: number[] };

export type SplitChapter = {
  number: number;
  name: string;
  fileName: string;
  markdown: string;
  blockIndexes: number[];
};

export type SplitPlan =
  | {
      ok: true;
      /** 开头标题区（`# 主题` + header 行），原样保留在索引最前。 */
      prefix: string;
      /** 未归属块（保持原相对顺序），它们继续留在索引里。 */
      remaining: string[];
      /** 预览用：标题区 + 未归属块。 */
      index: string;
      chapters: SplitChapter[];
    }
  | { ok: false; error: string };

/**
 * 归属校验 + 计划生成：越界 / 重复 / 空章节 / 非法章节名一律拒绝；
 * 块守恒由构造保证——每个块要么留在索引，要么进且仅进一个章节。
 * 章节编号按数组顺序从 `startAt`（默认 1）递增：拆分时数组顺序就是讲解顺序。
 */
export const planSplit = (input: {
  markdown: string;
  chapters: ChapterAssignment[];
  startAt?: number;
}): SplitPlan => {
  const blocks = parseNoteBlocks(input.markdown);
  const lines = input.markdown.split("\n");
  if (blocks.length === 0)
    return { ok: false, error: "note has no callout blocks to split" };

  const prefixEnd = blocks[0].startLine;
  const prefix = lines.slice(0, prefixEnd).join("\n").replace(/\n+$/, "");

  const assigned = new Map<number, string>();
  for (const chapter of input.chapters) {
    const check = isValidChapter(chapter.name);
    if (check.ok === false) {
      return {
        ok: false,
        error: `chapter "${chapter.name}" is invalid (${check.reason})`,
      };
    }
    if (chapter.blockIndexes.length === 0) {
      return { ok: false, error: `chapter "${chapter.name}" has no blocks` };
    }
    for (const index of chapter.blockIndexes) {
      if (!Number.isInteger(index) || index < 1 || index > blocks.length) {
        return {
          ok: false,
          error: `block index ${index} is out of range (1..${blocks.length})`,
        };
      }
      if (assigned.has(index)) {
        return { ok: false, error: `block index ${index} is assigned twice` };
      }
      assigned.set(index, chapter.name);
    }
  }
  if (assigned.size === 0)
    return { ok: false, error: "no block was assigned to any chapter" };

  const remaining: string[] = [];
  blocks.forEach((block, position) => {
    if (!assigned.has(position + 1)) remaining.push(block.text);
  });
  const indexParts = [prefix, ...remaining];
  const startAt = input.startAt ?? 1;

  return {
    ok: true,
    prefix,
    remaining,
    index: `${indexParts.filter((part) => part.trim().length > 0).join("\n\n")}\n`,
    chapters: input.chapters.map((chapter, position) => {
      const number = startAt + position;
      return {
        number,
        name: chapter.name,
        fileName: chapterFileName(number, chapter.name),
        blockIndexes: [...chapter.blockIndexes],
        markdown: `${chapter.blockIndexes
          .map((index) => blocks[index - 1].text)
          .join("\n\n")}\n`,
      };
    }),
  };
};

/** 拆分后写在索引顶部的 provenance 块：章节行放在 callout 内部，读起来是一整块。 */
export const provenanceBlock = (input: {
  date: string;
  chapters: ChapterFile[];
  archiveName: string;
}): string => {
  const body = input.chapters.map((chapter) =>
    indexEntryLine({
      name: chapter.name,
      number: chapter.number,
      date: input.date,
    }),
  );
  return [
    `> [!note] ${input.date} 已拆分为 ${input.chapters
      .map((chapter) => `[[${chapterFileName(chapter.number, chapter.name)}]]`)
      .join(" ")} · 原文见 _archive/${input.archiveName}`,
    ">",
    ...body.map((line) => `> ${line}`),
  ].join("\n");
};

// ── 会话绑定与主题简报（纯） ─────────────────────────────────────────────
//
// 这一节回答两件事，而且只回答这两件：
//   1. 本会话绑到了哪篇笔记？（`readBoundNote` / `isVaultNotePath` / `topicOfNotePath`）
//   2. 这个主题现在是什么状态？（`formatTopicBrief` / `formatTopicCatalog`）
// **不回答「该绑哪儿」**——落点由学习者在 picker 里选，判定只有一条字符串比较
// （`needsPlacementGate`），没有任何同名/近似/最近改动的推断。

export const TUTOR_NOTES_ENTRY_TYPE = "tutor-notes";

/** 会话条目的结构镜像：只取判定需要的字段，不依赖 pi 的类型。 */
export type SessionEntryLike = {
  type?: string;
  customType?: string;
  data?: unknown;
  message?: { role?: string; content?: MessageContent };
};

/** 本条分支上最后一次 `tutor-notes` 绑定；没有绑定条目则 null。 */
export const readBoundNote = (
  entries: readonly SessionEntryLike[],
): string | null => {
  let file: string | null = null;
  for (const entry of entries) {
    if (entry?.type !== "custom") continue;
    if (entry.customType !== TUTOR_NOTES_ENTRY_TYPE) continue;
    const value = (entry.data as { file?: unknown } | undefined)?.file;
    if (typeof value === "string") file = value;
    else if (value === null) file = null;
  }
  return file;
};

/** `<vaultRoot>/<topDir>`（vaultRoot 需已展开 `~`）。 */
export const vaultDirOf = (vault: {
  vaultRoot: string;
  topDir: string;
}): string => joinPath(vault.vaultRoot, vault.topDir);

/** 绑定是否落在教学内容区（`<vaultRoot>/<topDir>/` 下）——决定要不要开 tutor 闸门。 */
export const isVaultNotePath = (file: string, vaultDir: string): boolean =>
  file.startsWith(`${vaultDir.replace(/\/+$/, "")}/`);

/** `<topic>/<topic>.md` 或 `<topic>/<NN-章节>.md` → 主题名；路径里没有目录则 null。 */
export const topicOfNotePath = (file: string): string | null => {
  const dir = topicDirOf(file);
  const base = dir.slice(dir.lastIndexOf("/") + 1);
  return base.length > 0 ? base : null;
};

/**
 * 落点 gate：这次 bind 要不要问人，以及问哪几步。
 *
 * - `askTopic`：请求主题不是本会话已绑定的主题（含尚未绑定）⇒ 问。
 * - `askChapter`：选了主题必然接着选章节；agent 明确要一章（`requestedChapter`）也要问
 *   ——「放到新章节，还是加到已有章节里」是学习者的事，agent 说了不算；
 *   另外当前正绑在某一章、这次却要退回索引页（`boundIsChapter`）也要问，
 *   否则一次误调就把课文写进索引页。
 *
 * 只比字符串与一个布尔——不做同名命中、近似匹配、最近改动这类推断。
 */
export type PlacementGate = { askTopic: boolean; askChapter: boolean };

export const planPlacementGate = (input: {
  requestedTopic: string;
  requestedChapter?: string;
  boundTopic: string | null;
  /** 本会话当前绑的是不是章节文件（`<topic>/<topic>.md` 之外都算章节）。 */
  boundIsChapter: boolean;
}): PlacementGate => {
  const askTopic =
    input.boundTopic === null || input.requestedTopic !== input.boundTopic;
  const wantsChapter = (input.requestedChapter ?? "").trim().length > 0;
  return {
    askTopic,
    askChapter: askTopic || wantsChapter || input.boundIsChapter,
  };
};

/** 章节一行：`第3章 · 调度与唤醒（ok 4 / wrong 1 / gaps 0）`。 */
export const formatChapterTally = (chapter: ChapterState): string => {
  const parts = [
    `ok ${chapter.ok}`,
    `wrong ${chapter.wrong}`,
    `gaps ${chapter.gaps}`,
  ];
  if (chapter.unanswered > 0) parts.push(`unanswered ${chapter.unanswered}`);
  return `${chapterLabel(chapter.number, chapter.name)}（${parts.join(" / ")}）`;
};

/**
 * 主题简报：`bind_notes` 的结果、`topic_status`、会话首轮注入共用同一份文本，
 * 保证「屏幕 / 工具 / 模型」看到的是同一个说法。
 */
export const formatTopicBrief = (input: {
  topic: string;
  indexPath: string;
  chapters: ChapterState[];
  resume?: Resume;
  chapter?: { name: string; number?: number };
  /** 本会话绑定的文件；省略时以索引页为准（主题级查询）。 */
  notePath?: string;
  /** 概念缺口行（由 concepts-core 渲染，Core 不反向依赖它）。 */
  conceptLine: string;
  unnumbered?: string[];
}): string => {
  const lines: string[] = [`笔记：${input.notePath ?? input.indexPath}`];
  if (input.notePath) {
    lines.push(`索引：${input.indexPath}（先读 ## 已知边界 / ## 未解决）`);
  }
  if (input.chapter) {
    lines.push(
      `当前章节：${chapterLabel(input.chapter.number, input.chapter.name)}`,
    );
  }
  lines.push(
    input.chapters.length === 0
      ? `章节：《${input.topic}》还没有章节`
      : `章节：${input.chapters.map(formatChapterTally).join("；")}`,
  );
  const resumeChapter = input.resume
    ? input.chapters.find((chapter) => chapter.name === input.resume?.chapter)
    : undefined;
  lines.push(
    input.resume
      ? `续做：${chapterLabel(resumeChapter?.number, input.resume.chapter)}（${input.resume.reason}）`
      : `续做：无（这一主题还没有讲过的章节）`,
  );
  lines.push(input.conceptLine);
  if (input.unnumbered && input.unnumbered.length > 0) {
    lines.push(
      `待编号：${input.unnumbered.join("、")} —— 调 number_chapters 补编号`,
    );
  }
  lines.push(
    `新增章节：bind_notes({topic:"${input.topic}", chapter:"<名字>"})（同一主题内直接生效；换主题或开新主题会弹 picker，由学习者选落点）`,
  );
  return lines.join("\n");
};

/** ISO 时间戳 → `YYYY-MM-DD HH:mm`：只用于展示，排序永远用 ISO 原值。 */
export const formatTouchedAt = (iso: string): string =>
  iso.length >= 16 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso;

/** vault 主题概览一行所需的字段（boundary DTO：排序键是 ISO，展示交给 formatTouchedAt）。 */
export type TopicSummary = {
  topic: string;
  chapters: number;
  /** 最近改动时间（ISO 8601）；索引页与章节文件都不存在时为 null。 */
  lastTouchedAt: string | null;
};

/** `vault 主题：redis高可用（2章，最近 2026-09-24 10:11）、Docker实现（1章）`。 */
export const formatTopicList = (topics: TopicSummary[]): string =>
  topics.length === 0
    ? "vault 主题：（还没有任何主题）"
    : `vault 主题：${topics
        .map(
          (entry) =>
            `${entry.topic}（${entry.chapters}章${
              entry.lastTouchedAt
                ? `，最近 ${formatTouchedAt(entry.lastTouchedAt)}`
                : ""
            }）`,
        )
        .join("、")}`;

/** 未绑定时的 vault 目录：主题清单 + 最近改动的主题，并写明落点规则。 */
export const formatTopicCatalog = (input: {
  topics: TopicSummary[];
  recent?: { topic: string; chapters: ChapterFile[] };
}): string => {
  const lines: string[] = ["本会话还没有绑定笔记。"];
  lines.push(formatTopicList(input.topics));
  if (input.recent) {
    lines.push(
      `最近改动：${input.recent.topic} —— ${
        input.recent.chapters.length === 0
          ? "（还没有章节）"
          : input.recent.chapters
              .map((chapter) => chapterLabel(chapter.number, chapter.name))
              .join("；")
      }`,
    );
  }
  lines.push(
    "落点规则：不要用参数去猜主题名；调 bind_notes 时插件会弹 picker，由学习者选「放到哪个主题 / 哪个章节（已有章节或 ＋新建章节…）」。",
  );
  return lines.join("\n");
};

/** 学习者在 picker 里取消落点选择：没写盘，也不该重试。 */
export const formatBindCancelled = (): string =>
  [
    "落点未确认：学习者取消了选择，没有写盘（主题目录与章节文件都没变）。",
    "下一步：先问学习者这次教学放到哪个主题/章节（可以用 ask_user_question 给出候选），不要原样重试这次 bind_notes。",
  ].join("\n");

/** 会话里弹不出 picker（print / json 模式）：只能把选择交回给对话。 */
export const formatPlacementRequired = (input: {
  requestedTopic: string;
  boundTopic: string | null;
}): string =>
  [
    `${input.requestedTopic} 还不能直接绑定：这个会话没有可用的选择 UI，而没有学习者的确认就不能决定落点。`,
    input.boundTopic === null
      ? "本会话还没有绑定主题。"
      : `本会话已绑定的主题是《${input.boundTopic}》。`,
    "下一步：用 ask_user_question 让学习者选（放到哪个主题 / 哪个章节：已有章节还是新建），确定后再 bind_notes；或让他自己敲 `/md-topic` 选。",
  ].join("\n");
