/**
 * notes-core — 笔记落盘的纯函数核（Functional Core）。
 *
 * 负责：设置解析、主题校验与路径拼装、以及写进笔记的每一段文本格式
 * （Obsidian callout）。所有 IO 都在 notes-store；这里 value in / value out。
 */

import type { AskDetails } from "./ask-core.ts";
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
export const SECTION_MAX_LENGTH = 60;

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

/** 章节与主题共用同一套安全校验，外加长度上限。 */
/** 把名字里的空白去掉，作为给调用方的"建议名"（错误提示里附上，省一轮往返）。 */
export const sanitizeName = (name: string): string =>
  name.trim().replace(/\s+/g, "");

export const isValidSection = (section: string): TopicCheck => {
  const check = isValidTopic(section);
  if (check.ok === false) return check;
  if (check.topic.length > SECTION_MAX_LENGTH) {
    return { ok: false, reason: "too-long" };
  }
  return check;
};

/** 省略 section 时是索引页 `<topic>/<topic>.md`；给出时是章节页 `<topic>/<section>.md`。 */
export const chapterNotePath = (input: {
  vaultRoot: string;
  topDir: string;
  topic: string;
  section?: string;
}): string =>
  joinPath(
    input.vaultRoot,
    input.topDir,
    input.topic,
    `${input.section?.trim() || input.topic}.md`,
  );

/** 新章节文件的开头：标明它属于哪个主题。 */
export const formatSectionHeader = (topic: string, section: string): string =>
  `# ${section}\n\n> 《${topic}》的一章 · 由 tutor 维持：按时间顺序追加，只增不改。\n`;

/** 索引页里的章节行（只在首次绑定该章时追加）。 */
export const indexEntryLine = (input: {
  section: string;
  date: string;
}): string => `- [[${input.section}]] · ${input.date}`;

/** 用完整的 `[[name]]` 匹配，避免 `[[X2]]` 被误判成含 `[[X]]`。 */
export const hasIndexEntry = (index: string, section: string): boolean =>
  index.includes(`[[${section}]]`);

// ── 会话镜像的块格式（Obsidian callout） ──────────────────────────────────

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

export const isQuizDetails = (
  details: QuizDetails | AskDetails,
): details is QuizDetails => "correctValues" in details;

export const formatAnswerBlock = (details: QuizDetails | AskDetails): string =>
  isQuizDetails(details)
    ? formatQuizAnswerBlock(details)
    : formatAskAnswerBlock(details);

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

const CALLOUT_RE = /^>\s*\[!(\w+)\]\s*(.*)$/;

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
  name: string;
  path: string;
  markdown: string;
  touchedAt?: string;
}): ChapterState => {
  const blocks = parseNoteBlocks(input.markdown);
  return {
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

export type SectionAssignment = { name: string; blockIndexes: number[] };

export type SplitPlan =
  | {
      ok: true;
      /** 开头标题区（`# 主题` + header 行），原样保留在索引最前。 */
      prefix: string;
      /** 未归属块（保持原相对顺序），它们继续留在索引里。 */
      remaining: string[];
      /** 预览用：标题区 + 未归属块。 */
      index: string;
      sections: { name: string; markdown: string; blockIndexes: number[] }[];
    }
  | { ok: false; error: string };

/**
 * 归属校验 + 计划生成：越界 / 重复 / 空章节 / 非法章节名一律拒绝；
 * 块守恒由构造保证——每个块要么留在索引，要么进且仅进一个章节。
 */
export const planSplit = (input: {
  markdown: string;
  sections: SectionAssignment[];
}): SplitPlan => {
  const blocks = parseNoteBlocks(input.markdown);
  const lines = input.markdown.split("\n");
  if (blocks.length === 0)
    return { ok: false, error: "note has no callout blocks to split" };

  const prefixEnd = blocks[0].startLine;
  const prefix = lines.slice(0, prefixEnd).join("\n").replace(/\n+$/, "");

  const assigned = new Map<number, string>();
  for (const section of input.sections) {
    const check = isValidSection(section.name);
    if (check.ok === false) {
      return {
        ok: false,
        error: `section "${section.name}" is invalid (${check.reason})`,
      };
    }
    if (section.blockIndexes.length === 0) {
      return { ok: false, error: `section "${section.name}" has no blocks` };
    }
    for (const index of section.blockIndexes) {
      if (!Number.isInteger(index) || index < 1 || index > blocks.length) {
        return {
          ok: false,
          error: `block index ${index} is out of range (1..${blocks.length})`,
        };
      }
      if (assigned.has(index)) {
        return { ok: false, error: `block index ${index} is assigned twice` };
      }
      assigned.set(index, section.name);
    }
  }
  if (assigned.size === 0)
    return { ok: false, error: "no block was assigned to any section" };

  const remaining: string[] = [];
  blocks.forEach((block, position) => {
    if (!assigned.has(position + 1)) remaining.push(block.text);
  });
  const indexParts = [prefix, ...remaining];

  return {
    ok: true,
    prefix,
    remaining,
    index: `${indexParts.filter((part) => part.trim().length > 0).join("\n\n")}\n`,
    sections: input.sections.map((section) => ({
      name: section.name,
      blockIndexes: [...section.blockIndexes],
      markdown: `${section.blockIndexes
        .map((index) => blocks[index - 1].text)
        .join("\n\n")}\n`,
    })),
  };
};

/** 拆分后写在索引顶部的 provenance 块：章节行放在 callout 内部，读起来是一整块。 */
export const provenanceBlock = (input: {
  date: string;
  sections: string[];
  archiveName: string;
}): string => {
  const body = input.sections.map((section) =>
    indexEntryLine({ section, date: input.date }),
  );
  return [
    `> [!note] ${input.date} 已拆分为 ${input.sections
      .map((section) => `[[${section}]]`)
      .join(" ")} · 原文见 _archive/${input.archiveName}`,
    ">",
    ...body.map((line) => `> ${line}`),
  ].join("\n");
};
