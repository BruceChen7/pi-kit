/**
 * notes-store — 会话镜像的 IO 与事件接线（Imperative Shell）。
 *
 * 职责边界：
 * - 持有"本次会话绑定到哪篇笔记"这一状态，并随会话恢复（`pi.appendEntry`）。
 * - 唯一落盘出口：串行锁 + 只追加，永不重写整篇。
 * - 绑定路径由 notes-core 的纯函数算出，这里只做 mkdir/读现有的内容。
 *
 * 命令与工具：
 * - `/md-topic [主题] [章节]`：无参弹主题 picker（列出 `Learn/` 下已有主题 + 「新建主题…」）；
 *   给主题（或选完主题）后弹章节 picker（已有章节 / ＋新建章节… / 主题索引页）；
 *   `/md-topic <主题> <章节>` 绕过 picker，直接绑 `<vaultRoot>/<topDir>/<主题>/<NN-章节>.md`。
 * - `/md-log <路径>`：只链接**已存在**的文件（保留 learn 的安全语义，不因笔误造文件）。
 * - `/md-unlog`：解绑。
 * - `bind_notes` 工具：agent 可调用。**落点 gate**：请求的主题不是本会话已绑定的主题时就
 *   弹 picker（与 `/md-topic` 同一套组件），学习者的选择才算数；Esc ⇒ 不写盘。
 *   因此 agent 没有「自己造主题」的接口——新建主题只能由人在 picker 里选「＋新建主题…」。
 *   绑定结果回报主题简报（章节统计 + resume + 概念缺口，见 notes-core 的 `formatTopicBrief`）。
 * - `split_topic` 工具：存量单文件笔记 → 索引 + 章节（默认只出计划，apply 才落盘）。
 *
 * 读侧（主题清单 / 主题状态）在 topic-store，`topic_status` 工具在 topic-status。
 */

import fs from "node:fs";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  createPickerState,
  filterOptions,
  type PickerOption,
} from "../shared/picker-core.ts";
import { applyPickerKey } from "../shared/picker-input.ts";
import {
  type PickerComponent,
  renderPickerLines,
} from "../shared/picker-view.ts";
import { sharedUiGate } from "../shared/ui-gate.ts";
import { conceptLineFor, topicConceptStateFor } from "./concepts-store.ts";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  BIND_NOTES_TOOL_NAME,
  NUMBER_CHAPTERS_TOOL_NAME,
  QUIZ_TOOL_NAME,
  SPLIT_TOPIC_TOOL_NAME,
} from "./names.ts";
import {
  bindToolCallIds,
  CHAPTER_PICKER_INDEX_ID,
  CHAPTER_PICKER_NEW_ID,
  type ChapterFile,
  catalogBlocks,
  chapterFileName,
  chapterLabel,
  chapterNotePath,
  chapterPickerOptions,
  formatAnswerBlock,
  formatAssistantBlock,
  formatBindCancelled,
  formatPlacementRequired,
  formatQuestionBlock,
  formatSectionHeader,
  formatTopicBrief,
  formatTopicHeader,
  formatTouchedAt,
  formatUserBlock,
  hasIndexEntry,
  indexEntryLine,
  isValidChapter,
  isValidTopic,
  isVaultNotePath,
  type MirrorEvent,
  type MirrorPending,
  messageText,
  mirrorAssistantText,
  mirrorStep,
  type NumberingAssignment,
  needsPlacementGate,
  parseChapterRef,
  parseIndexEntries,
  planNumbering,
  planSplit,
  proposeChapterOrder,
  provenanceBlock,
  readBoundNote,
  relinkIndex,
  resolveChapterNumber,
  rewriteChapterHeading,
  sanitizeName,
  stripSkillBlocks,
  type TopicRejection,
  TUTOR_NOTES_ENTRY_TYPE,
  type TutorSettings,
  topicDirOf,
  topicNotePath,
  topicOfNotePath,
  upsertChapterToc,
  vaultDirOf,
} from "./notes-core.ts";
import type { QuizDetails } from "./quiz-core.ts";
import { resolveSettings } from "./settings-store.ts";
import {
  listTopics,
  readTopicState,
  type ScannedChapter,
  scanChapters,
} from "./topic-store.ts";

const ENTRY_TYPE = TUTOR_NOTES_ENTRY_TYPE;
const STATUS_KEY = "tutor-notes";
const QA_TOOLS = new Set([QUIZ_TOOL_NAME, ASK_USER_QUESTION_TOOL_NAME]);

const errorResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: {},
  isError: true,
});

const rejectionHint = (reason: TopicRejection): string => {
  switch (reason) {
    case "empty":
      return "topic must not be empty";
    case "separator":
      return 'topic must not contain "/" or "\\"';
    case "parent":
      return 'topic must not contain ".."';
    case "too-long":
      return "name is too long (max 60 characters)";
    case "space":
      return "name must not contain spaces";
    default:
      return "topic must not contain NUL";
  }
};

/** IO 薄边界（导出以便集成测试直接打到真实文件系统）。 */
export const ensureTopicNote = (file: string): { created: boolean } => {
  fs.mkdirSync(topicDirOf(file), { recursive: true });
  if (fs.existsSync(file)) return { created: false };
  fs.writeFileSync(
    file,
    formatTopicHeader(path.basename(file, ".md")),
    "utf-8",
  );
  return { created: true };
};

/** 章节文件的开头与索引页不同：标明它属于哪个主题、是第几章。 */
export const ensureChapterNote = (
  file: string,
  topic: string,
  chapter: string,
  number?: number,
): { created: boolean } => {
  fs.mkdirSync(topicDirOf(file), { recursive: true });
  if (fs.existsSync(file)) return { created: false };
  fs.writeFileSync(file, formatSectionHeader(topic, chapter, number), "utf-8");
  return { created: true };
};

/**
 * 只追加：读现有内容后在末尾接上。只规整末尾空行，绝不改动已有正文
 * （笔记是学习者的产物，镜像失败或反复绑定都不能损坏它）。
 */
export const appendToNote = (file: string, text: string): void => {
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
  const body = current.replace(/\n+$/, "");
  const prefix = body.length > 0 ? "\n\n" : "";
  fs.writeFileSync(file, `${body}${prefix}${text}\n`, "utf-8");
};

/** `/md-log` 的安全语义：只链接已存在的文件，不因笔误在 vault 里造文件。 */
export const checkExistingFile = (
  file: string,
): { ok: true } | { ok: false; error: string } =>
  fs.existsSync(file) && fs.statSync(file).isFile()
    ? { ok: true }
    : { ok: false, error: `file does not exist: ${file}` };

/** 索引页只追加一章一行（已存在则不动）；编号缺省写入旧格式。 */
export const appendIndexEntryOnce = (
  indexPath: string,
  entry: { name: string; date: string; number?: number },
): { appended: boolean } => {
  ensureTopicNote(indexPath);
  const current = fs.existsSync(indexPath)
    ? fs.readFileSync(indexPath, "utf-8")
    : "";
  if (hasIndexEntry(current, entry.name)) return { appended: false };
  appendToNote(indexPath, indexEntryLine(entry));
  return { appended: true };
};

/** 索引行里的日期：用于 `## 章节` 块（跟原行一致，不重算）。 */
const indexDates = (index: string): Map<string, string> => {
  const dates = new Map<string, string>();
  for (const entry of parseIndexEntries(index)) {
    if (entry.date && !dates.has(entry.name)) dates.set(entry.name, entry.date);
  }
  return dates;
};

/**
 * 索引页的维护：章节行只由 `## 章节` 块写（块外不再补行——补的那行会和块里的
 * 章节行重复），旧格式链接改写成带编号的，最后重建块。内容没变就不写盘。
 */
export const writeChapterIndex = (input: {
  indexPath: string;
  chapter: ChapterFile;
  scanned: ChapterFile[];
  date?: string;
}): void => {
  ensureTopicNote(input.indexPath);
  const before = fs.readFileSync(input.indexPath, "utf-8");
  let index = relinkIndex(before, {
    name: input.chapter.name,
    number: input.chapter.number,
    fileName: chapterFileName(input.chapter.number, input.chapter.name),
  });
  const dates = indexDates(before);
  // 新绑的章节在索引里还没有日期：直接用这次绑定的日期。以前是往页尾补一行来
  // 携带日期，那行会留在正文里，和块里的章节行一模一样。
  const boundDate = input.date ?? new Date().toISOString().slice(0, 10);
  const entries: ChapterFile[] = [...input.scanned]
    .map((chapter) => ({
      ...chapter,
      date:
        dates.get(chapter.name) ??
        (chapter.name === input.chapter.name ? boundDate : undefined),
    }))
    .sort(
      (a, b) =>
        (a.number ?? Number.MAX_SAFE_INTEGER) -
        (b.number ?? Number.MAX_SAFE_INTEGER),
    );
  index = upsertChapterToc(index, entries);
  if (index !== before) fs.writeFileSync(input.indexPath, index, "utf-8");
};

export type SplitWriteResult =
  | {
      ok: true;
      archivePath: string;
      chapters: {
        number: number;
        name: string;
        path: string;
        blocks: number;
      }[];
    }
  | { ok: false; error: "chapter-exists"; existing: string[] };

/** 落盘拆分：先逐字节归档原文，再写章节，最后重写索引（带 provenance 与章节行）。 */
export const applyTopicSplit = (input: {
  indexPath: string;
  topic: string;
  date: string;
  plan: {
    prefix: string;
    remaining: string[];
    index: string;
    chapters: {
      number: number;
      name: string;
      fileName: string;
      markdown: string;
      blockIndexes: number[];
    }[];
  };
  chapterPathOf: (chapter: { number: number; name: string }) => string;
}): SplitWriteResult => {
  const existing = input.plan.chapters
    .map((chapter) => input.chapterPathOf(chapter))
    .filter((file) => fs.existsSync(file));
  if (existing.length > 0)
    return { ok: false, error: "chapter-exists", existing };

  const archiveDir = path.join(topicDirOf(input.indexPath), "_archive");
  fs.mkdirSync(archiveDir, { recursive: true });
  const archiveName = `${input.topic}.${input.date}.md`;
  const archivePath = path.join(archiveDir, archiveName);
  fs.copyFileSync(input.indexPath, archivePath);

  const sectionNames = input.plan.chapters.map((chapter) => chapter.name);
  fs.writeFileSync(
    input.indexPath,
    [
      input.plan.prefix,
      provenanceBlock({
        date: input.date,
        chapters: input.plan.chapters.map((chapter) => ({
          number: chapter.number,
          name: chapter.name,
        })),
        archiveName,
      }),
      ...input.plan.remaining,
    ]
      .filter((part) => part.trim().length > 0)
      .join("\n\n")
      .concat("\n"),
    "utf-8",
  );

  const chapters = input.plan.chapters.map((chapter) => {
    const file = input.chapterPathOf(chapter);
    fs.mkdirSync(topicDirOf(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${formatSectionHeader(input.topic, chapter.name, chapter.number)}\n${chapter.markdown}`,
      "utf-8",
    );
    return {
      number: chapter.number,
      name: chapter.name,
      path: file,
      blocks: chapter.blockIndexes.length,
    };
  });
  // 拆分后立刻把 `## 章节` 块建出来：索引页从第一天就能当目录用。
  writeChapterIndex({
    indexPath: input.indexPath,
    chapter: { name: sectionNames[0], number: input.plan.chapters[0].number },
    scanned: input.plan.chapters.map((chapter) => ({
      number: chapter.number,
      name: chapter.name,
    })),
    date: input.date,
  });
  return { ok: true, archivePath, chapters };
};

export type NumberingWriteResult =
  | {
      ok: true;
      /** 改了名的章节数。 */
      changed: number;
      /** 编号已经对了、只是首行还是旧写法，被修好的章节数。 */
      healedHeadings: number;
      /** 无改名时为 null（第二次跑不会用改写后的索引覆盖旧备份）。 */
      archivePath: string | null;
      assignments: NumberingAssignment[];
      unassigned: ChapterFile[];
    }
  | { ok: false; error: "bound-file"; file: string }
  | { ok: false; error: "file-exists"; existing: string[] };

/**
 * 落盘编号迁移：先归档索引，再改名，再修首行，最后改写索引链接并重建 `## 章节` 块。
 * 前置检查全在写之前做完（被镜像的文件不改、目标文件已存在则整个拒绝）。
 */
export const applyChapterNumbering = (input: {
  indexPath: string;
  topic: string;
  scanned: ScannedChapter[];
  assignments: NumberingAssignment[];
  unassigned: ChapterFile[];
  date: string;
  boundFile: string | null;
}): NumberingWriteResult => {
  const dir = topicDirOf(input.indexPath);
  const changes = input.assignments.filter(
    (assignment) => !assignment.unchanged,
  );
  const boundChange = changes.find(
    (assignment) => input.boundFile === path.join(dir, `${assignment.from}.md`),
  );
  if (boundChange) {
    return { ok: false, error: "bound-file", file: boundChange.from };
  }
  const existing = changes
    .map((assignment) => path.join(dir, `${assignment.to}.md`))
    .filter((file) => fs.existsSync(file));
  if (existing.length > 0) return { ok: false, error: "file-exists", existing };

  let archivePath: string | null = null;
  if (changes.length > 0) {
    const archiveDir = path.join(dir, "_archive");
    fs.mkdirSync(archiveDir, { recursive: true });
    archivePath = path.join(
      archiveDir,
      `${input.topic}.${input.date}-numbered.md`,
    );
    // 已经备份过就不覆盖：备份的意义是"编号前的索引"，不是最新快照。
    if (!fs.existsSync(archivePath)) {
      fs.copyFileSync(input.indexPath, archivePath);
    }
  }

  for (const assignment of changes) {
    fs.renameSync(
      path.join(dir, `${assignment.from}.md`),
      path.join(dir, `${assignment.to}.md`),
    );
  }

  // 首行修复对**所有**章节都跑：已编号的旧章节也可能还留着 `# chroot 与挂载时机` 这种旧标题。
  let healedHeadings = 0;
  for (const assignment of input.assignments) {
    const file = path.join(dir, `${assignment.to}.md`);
    if (!fs.existsSync(file)) continue;
    const markdown = fs.readFileSync(file, "utf-8");
    const rewritten = rewriteChapterHeading(
      markdown,
      assignment.name,
      assignment.number,
    );
    if (rewritten !== markdown) {
      fs.writeFileSync(file, rewritten, "utf-8");
      healedHeadings++;
    }
  }

  const index = fs.readFileSync(input.indexPath, "utf-8");
  const numberedBy = new Map(
    input.assignments.map((assignment) => [assignment.name, assignment.number]),
  );
  const numbered: ChapterFile[] = input.scanned.map((item) => ({
    number: numberedBy.get(item.chapter.name) ?? item.chapter.number,
    name: item.chapter.name,
  }));
  let next = index;
  for (const chapter of numbered) {
    next = relinkIndex(next, {
      name: chapter.name,
      number: chapter.number,
      fileName: chapterFileName(chapter.number, chapter.name),
    });
  }
  const dates = new Map(
    parseIndexEntries(next).map((entry) => [entry.name, entry.date]),
  );
  next = upsertChapterToc(
    next,
    [...numbered]
      .map((chapter) => ({ ...chapter, date: dates.get(chapter.name) }))
      .sort(
        (a, b) =>
          (a.number ?? Number.MAX_SAFE_INTEGER) -
          (b.number ?? Number.MAX_SAFE_INTEGER),
      ),
  );
  if (next !== index) fs.writeFileSync(input.indexPath, next, "utf-8");

  return {
    ok: true,
    changed: changes.length,
    healedHeadings,
    archivePath,
    assignments: input.assignments,
    unassigned: input.unassigned,
  };
};

/**
 * 变章绑定的准备：定号→旧章节就地编号→建章节目录行与小节块。不改会话状态（那是 bind 的事），
 * 所以可以单独拿出来测。
 */
export const prepareChapterBinding = (input: {
  indexPath: string;
  topic: string;
  chapter: string;
  number?: number;
  boundFile: string | null;
}):
  | {
      ok: true;
      file: string;
      number: number;
      created: boolean;
      healedFrom?: string;
      scanned: ChapterFile[];
      unnumbered: string[];
    }
  | { ok: false; error: string; conflict?: unknown } => {
  const dir = topicDirOf(input.indexPath);
  const scanned = scanChapters(dir, input.topic);
  const named = scanned.filter((item) => item.chapter.name === input.chapter);
  // 同名两份（旧文件 + 已编号文件）时以已编号的那份为准，另一份由 number_chapters 报冲突
  const existing =
    named.find((item) => item.chapter.number !== undefined) ?? named[0];
  const decision = resolveChapterNumber({
    existing: existing?.chapter.number,
    requested: input.number,
    chapters: scanned.map((item) => item.chapter),
  });
  if (decision.ok === false) {
    return {
      ok: false,
      error: decision.hint,
      conflict: decision.conflict ?? undefined,
    };
  }
  const number = decision.number;
  const file = path.join(dir, `${chapterFileName(number, input.chapter)}.md`);

  // 旧格式章节（`名字.md`）：就地编号——改名 + 改首行，索引行稍后统一改写。
  let healedFrom: string | undefined;
  if (existing && existing.file !== file) {
    if (fs.existsSync(file)) {
      return { ok: false, error: `target file already exists: ${file}` };
    }
    fs.renameSync(existing.file, file);
    const rewritten = rewriteChapterHeading(
      existing.markdown,
      input.chapter,
      number,
    );
    if (rewritten !== existing.markdown) {
      fs.writeFileSync(file, rewritten, "utf-8");
    }
    healedFrom = existing.file;
  }

  const created = ensureChapterNote(
    file,
    input.topic,
    input.chapter,
    number,
  ).created;
  const refreshed = scanChapters(dir, input.topic);
  writeChapterIndex({
    indexPath: input.indexPath,
    chapter: { name: input.chapter, number },
    scanned: refreshed.map((item) => item.chapter),
  });
  return {
    ok: true,
    file,
    number,
    created,
    healedFrom,
    scanned: refreshed.map((item) => item.chapter),
    unnumbered: refreshed
      .filter((item) => item.chapter.number === undefined)
      .map((item) => item.chapter.name),
  };
};

export type NotesDeps = {
  /**
   * 绑定状态变化：绑定 / 换绑（file 为路径）与解绑（file 为 null）。
   * 只报告事实，不下指令：闸门开合由 mode 控制器按会话条目重新推导（见 index.ts），
   * 所以解绑不需要在这里传「关闸」。
   */
  onBindingChange?: (event: { file: string | null; inVault: boolean }) => void;
};

export const registerNotes = (pi: ExtensionAPI, deps: NotesDeps = {}): void => {
  let noteFile: string | null = null;
  /** 镜像闸门：关闸期间扣住还没归属的块（见 notes-core 的 mirrorStep）。 */
  let mirror: MirrorPending | null = null;
  let writeLock: Promise<void> = Promise.resolve();
  const loggedQuestions = new Set<string>();

  /** settings → vault 路径：读侧派生只此一处（settings-store），避免各条路径各读一遍。 */
  const settingsFor = (ctx: ExtensionContext): TutorSettings =>
    resolveSettings({ cwd: ctx.cwd });

  const withLock = <T>(fn: () => T | Promise<T>): Promise<T> => {
    const previous = writeLock;
    let release: () => void = () => {};
    writeLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(fn).finally(() => release());
  };

  /** 唯一落盘出口：读现有内容后在末尾追加，外部删文件不影响会话。 */
  const appendBlock = async (text: string): Promise<void> => {
    const target = noteFile;
    if (!target) return;
    await withLock(() => {
      try {
        appendToNote(target, text);
      } catch {
        // 外部删掉/改权限：静默忽略，绝不因为镜像失败打断教学。
      }
    });
  };

  /**
   * 镜像编排（Shell）：闸门规则全在 Core 的 `mirrorStep` 里，这里只负责
   * 「更新 pending + 把该放行的块写出去」。落盘仍只走 `appendBlock`。
   */
  const runMirror = async (event: MirrorEvent): Promise<void> => {
    const step = mirrorStep(mirror, event);
    mirror = step.pending;
    for (const block of step.append) await appendBlock(block);
  };

  const setStatus = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus(
      STATUS_KEY,
      noteFile ? `📝 ${path.basename(noteFile)}` : undefined,
    );
  };

  const bind = (
    ctx: ExtensionContext,
    file: string,
    options: {
      create: boolean;
      chapter?: string;
      header?: { topic: string; chapter: string; number: number };
    },
  ): { ok: true; created: boolean } | { ok: false; error: string } => {
    let created = false;
    if (options.create) {
      created = options.header
        ? ensureChapterNote(
            file,
            options.header.topic,
            options.header.chapter,
            options.header.number,
          ).created
        : ensureTopicNote(file).created;
    } else {
      const check = checkExistingFile(file);
      if (check.ok === false) return { ok: false, error: check.error };
    }
    noteFile = file;
    pi.appendEntry(ENTRY_TYPE, { file, chapter: options.chapter ?? null });
    setStatus(ctx);
    // ① 绑定教学内容 = 教学会话：把事实交给 mode 控制器（index.ts 据此开 tutor 闸门）；
    // ② 会话名（仅在还没名字时）——`/resume` 列表里能直接认出主题。
    const vaultDir = vaultDirOf(settingsFor(ctx));
    const inVault = isVaultNotePath(file, vaultDir);
    deps.onBindingChange?.({ file, inVault });
    const topic = inVault ? topicOfNotePath(file) : null;
    if (topic && !pi.getSessionName()) pi.setSessionName(`tutor:${topic}`);
    return { ok: true, created };
  };

  type BindOutcome =
    | {
        ok: true;
        file: string;
        indexPath: string;
        created: boolean;
        chapter?: string;
        number?: number;
        healedFrom?: string;
        directorySize?: number;
        unnumbered?: string[];
      }
    | {
        ok: false;
        error: string;
        conflict?: unknown;
        suggestedChapter?: string;
      };

  /**
   * 绑定主题或章节。章节绑定前先定号（文件名是编号权威）、把旧格式章节就地编号，
   * 并维护索引页（补行 + 改写链接 + 重建 `## 章节` 块）。
   */
  const bindFromSettings = (
    ctx: ExtensionContext,
    topic: string,
    chapter?: string,
    chapterNumber?: number,
  ): BindOutcome => {
    const topicCheck = isValidTopic(topic);
    if (topicCheck.ok === false) {
      return { ok: false, error: rejectionHint(topicCheck.reason) };
    }
    let cleanChapter: string | undefined;
    if (chapter !== undefined && chapter.trim().length > 0) {
      const chapterCheck = isValidChapter(chapter);
      if (chapterCheck.ok === false) {
        return {
          ok: false,
          error: rejectionHint(chapterCheck.reason),
          suggestedChapter: sanitizeName(chapter) || undefined,
        };
      }
      cleanChapter = chapterCheck.topic;
    }
    const settings = settingsFor(ctx);
    const indexPath = topicNotePath({
      vaultRoot: settings.vaultRoot,
      topDir: settings.topDir,
      topic: topicCheck.topic,
    });

    if (!cleanChapter) {
      const file = chapterNotePath({
        vaultRoot: settings.vaultRoot,
        topDir: settings.topDir,
        topic: topicCheck.topic,
      });
      const result = bind(ctx, file, { create: true });
      if (result.ok === false) return { ok: false, error: result.error };
      return { ok: true, file, indexPath, created: result.created };
    }

    const prepared = prepareChapterBinding({
      indexPath,
      topic: topicCheck.topic,
      chapter: cleanChapter,
      number: chapterNumber,
      boundFile: noteFile,
    });
    if (prepared.ok === false) {
      return {
        ok: false,
        error: prepared.error,
        conflict: prepared.conflict,
      };
    }

    const result = bind(ctx, prepared.file, {
      create: false,
      chapter: cleanChapter,
    });
    if (result.ok === false) return { ok: false, error: result.error };
    return {
      ok: true,
      file: prepared.file,
      indexPath,
      created: prepared.created,
      chapter: cleanChapter,
      number: prepared.number,
      healedFrom: prepared.healedFrom,
      directorySize: prepared.scanned.length,
      unnumbered: prepared.unnumbered,
    };
  };

  /** 主题状态：读侧统一走 topic-store（与 picker / topic_status 同一份扫描）。 */
  const topicStateFor = (settings: TutorSettings, topic: string) =>
    readTopicState(settings, topic);

  // ── 会话恢复 ──────────────────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    let last: { file: string | null } | undefined;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
        last = entry.data as { file: string | null } | undefined;
      }
    }
    if (last?.file) {
      noteFile = last.file;
      mirror = null;
      setStatus(ctx);
    }
  });

  // ── 会话文本镜像 ──────────────────────────────────────────────────────────
  pi.on("message_end", async (event, _ctx) => {
    if (!noteFile) return;
    const message = event.message as { role?: string; content?: unknown };
    if (message?.role === "user") {
      const text = stripSkillBlocks(
        messageText(message.content as never).trim(),
      );
      if (text)
        await runMirror({ kind: "block", block: formatUserBlock(text) });
      return;
    }
    if (message?.role === "assistant") {
      // 正文块：题面由 quiz / ask 的 pending 块写，正文里重复的那份不带进笔记。
      const text = mirrorAssistantText(message.content);
      const binds = bindToolCallIds(message.content);
      // 正文为空也要发：这条消息里的 bind 必须关上闸门，否则同轮的题面块会跟着漏到旧文件。
      if (text || binds.length > 0) {
        await runMirror({
          kind: "assistant",
          block: text ? formatAssistantBlock(text) : "",
          binds,
        });
      }
    }
  });

  // quiz 会在 execute 内洗牌：只认 onUpdate 发出的"用户实际看到的顺序"，
  // 并且每个 toolCallId 只写一次。
  pi.on("tool_execution_update", async (event, _ctx) => {
    if (!noteFile || event.toolName !== QUIZ_TOOL_NAME) return;
    if (loggedQuestions.has(event.toolCallId)) return;
    const details = event.partialResult?.details as QuizDetails | undefined;
    if (details?.status !== "pending" || details.options.length === 0) return;
    loggedQuestions.add(event.toolCallId);
    await runMirror({
      kind: "block",
      block: formatQuestionBlock({
        kind: "Quiz",
        question: details.question,
        context: details.context,
        options: details.options,
      }),
    });
  });

  // ask 不洗牌：tool_call 的参数就是展示顺序，可以在用户作答前先写问题块。
  pi.on("tool_call", async (event, _ctx) => {
    if (!noteFile || event.toolName !== ASK_USER_QUESTION_TOOL_NAME) return;
    const input = event.input as Record<string, unknown>;
    const options = Array.isArray(input.options)
      ? (input.options as Array<{ label?: string }>).flatMap((option, index) =>
          typeof option?.label === "string" && option.label.trim()
            ? [{ index: index + 1, label: option.label.trim() }]
            : [],
        )
      : [];
    await runMirror({
      kind: "block",
      block: formatQuestionBlock({
        kind: "Question",
        question: String(input.question ?? ""),
        context: typeof input.details === "string" ? input.details : undefined,
        options,
      }),
    });
  });

  pi.on("tool_result", async (event, _ctx) => {
    if (!noteFile) return;
    // bind 的结果 = 镜像目标已经切到新章节，开闸放行这一轮扣住的块。
    if (event.toolName === BIND_NOTES_TOOL_NAME) {
      await runMirror({ kind: "bindResult", toolCallId: event.toolCallId });
      return;
    }
    if (!QA_TOOLS.has(event.toolName)) return;
    const block = formatAnswerBlock((event as { details?: unknown }).details);
    if (block) await runMirror({ kind: "block", block });
  });

  // 兜底：bind 的工具结果没回来（失败 / 中断）也要把扣住的块写出去——
  // 宁可落在旧文件，绝不丢字。turn_end 一定晚于同批工具的结果。
  pi.on("turn_end", async () => {
    await runMirror({ kind: "flush" });
  });

  // ── 绑定：工具（agent 可调） + 命令（人可敲） ─────────────────────────────
  const BindNotesParams = Type.Object({
    topic: Type.String({
      description:
        "Teaching topic. Becomes both directory and file name under the notes vault (e.g. 分布式共识 → Learn/分布式共识/分布式共识.md).",
    }),
    chapter: Type.Optional(
      Type.String({
        description:
          "Chapter name (no number — the tool owns numbering). When given, the mirror switches to <topic>/<NN-章节>.md and returns the chapter's label `第N章 · 名字`. Call this in a message of its own, with no prose in it: the mirror writes a message's prose when the message ends, before tool calls run, so chapter prose written alongside this call lands in the previous chapter's file. Bind the chapter BEFORE teaching it, then teach in the next message.",
      }),
    ),
    chapterNumber: Type.Optional(
      Type.Number({
        description:
          "Optional explicit chapter number. Omit to take the next free number (max + 1 — gaps left by skipped chapters are never auto-filled). Pass the number from your plan when the plan already numbers its chapters; a taken number fails with the occupant, taken numbers, gaps and the auto number so you can fix it in one go. Chapters already numbered are never renumbered.",
      }),
    ),
  });

  /**
   * 落点 gate：请求的主题不是本会话已绑定的主题时，**绝不替学习者决定**。
   * 弹主题 picker → 章节 picker，由人选；Esc 取消则不写盘。
   * 只有交互式 TUI 能弹自定义组件（RPC / json / print 都不行）——那些模式下也不猜，
   * 把选择交回对话（`formatPlacementRequired`）。
   */
  const resolvePlacement = async (
    ctx: ExtensionContext,
    input: { topic: string; chapter?: string; chapterNumber?: number },
  ): Promise<
    | {
        ok: true;
        topic: string;
        chapter?: string;
        chapterNumber?: number;
      }
    | { ok: false; cancelled?: boolean; message: string }
  > => {
    const requestedTopic = input.topic.trim();
    const bound = readBoundNote(ctx.sessionManager.getEntries());
    const boundTopic = bound ? topicOfNotePath(bound) : null;
    if (!needsPlacementGate({ requestedTopic, boundTopic })) {
      return { ok: true, ...input, topic: requestedTopic };
    }
    if (ctx.mode !== "tui" || ctx.hasUI !== true) {
      return {
        ok: false,
        message: formatPlacementRequired({ requestedTopic, boundTopic }),
      };
    }
    const topic = await pickTopic(ctx, { suggested: requestedTopic });
    if (!topic) {
      return { ok: false, cancelled: true, message: formatBindCancelled() };
    }
    const choice = await pickChapter(ctx, topic, {
      suggested: input.chapter,
    });
    if (!choice) {
      return { ok: false, cancelled: true, message: formatBindCancelled() };
    }
    if (choice.kind === "index") {
      return { ok: true, topic, chapterNumber: input.chapterNumber };
    }
    return {
      ok: true,
      topic,
      chapter: choice.name,
      chapterNumber: input.chapterNumber,
    };
  };

  pi.registerTool({
    name: BIND_NOTES_TOOL_NAME,
    label: "Bind Topic Notes",
    description:
      "Bind this session's note mirror to the topic's markdown file in the notes vault, creating the directory and file when missing. " +
      "Call it once at the start of a teaching session, then every reply and quiz answer is appended to that same note. " +
      "Pass `chapter` before teaching a chapter: it assigns the chapter number, writes `<NN-章节>.md` with `# 第N章 · 名字` as its first line, adds the index line and refreshes the index's `## 章节` block. The returned `第N章 · 名字` label is the only authoritative way to refer to that chapter afterwards. " +
      "Send this call as a message of its own, with no prose around it — the mirror writes a message's prose when the message ends, before tool calls run, so chapter prose sent alongside the bind lands in the previous chapter's file. Bind first, teach in the next message. " +
      "It also returns a resume summary: the topic's chapters with their quiz tallies, and which chapter to continue from. " +
      "When the topic is not the one this session is already bound to, the tool opens a picker and the learner chooses the topic and chapter — do not guess a topic name (a chapter name is not a topic name), and do not retry a cancelled bind: ask the learner where the lesson should go instead.",
    parameters: BindNotesParams,
    // 落点 gate 会独占终端 UI（主题 / 章节 picker），与 quiz / ask_user_question 同理：
    // 并行发两个 tool call 会把先上屏的组件摘掉。
    executionMode: "sequential",
    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      ctx: ExtensionContext,
    ) {
      const settings = settingsFor(ctx);
      const placement = await resolvePlacement(ctx, {
        topic: params.topic,
        chapter: params.chapter,
        chapterNumber: params.chapterNumber,
      });
      if (placement.ok === false) {
        return {
          content: [{ type: "text" as const, text: placement.message }],
          details: {
            cancelled: placement.cancelled === true,
            requestedTopic: params.topic.trim(),
          },
          isError: placement.cancelled !== true,
        };
      }
      const topic = placement.topic.trim();
      const result = bindFromSettings(
        ctx,
        topic,
        placement.chapter,
        placement.chapterNumber,
      );
      if (result.ok === true) {
        const state = topicStateFor(settings, topic);
        const conceptLine = conceptLineFor(settings, topic);
        const healedLine = result.healedFrom
          ? `\n已给旧章节补编号：${path.basename(result.healedFrom)} → ${path.basename(result.file)}`
          : "";
        const chapterLine = result.chapter
          ? `（章节：${chapterLabel(result.number, result.chapter)}）`
          : "（主题索引页）";
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `已绑定本会话笔记：${result.file}${chapterLine}${healedLine}`,
                formatTopicBrief({
                  topic,
                  indexPath: result.indexPath,
                  chapters: state.chapters,
                  resume: state.resume,
                  chapter: result.chapter
                    ? { name: result.chapter, number: result.number }
                    : undefined,
                  notePath: result.file,
                  conceptLine,
                  unnumbered: result.unnumbered,
                }),
                "之后每一轮回复、提问与作答都会追加到这篇笔记（只追加）。",
              ].join("\n"),
            },
          ],
          details: {
            path: result.file,
            index: result.indexPath,
            topic,
            chapter: result.chapter ?? null,
            chapterNumber: result.number ?? null,
            healedFrom: result.healedFrom ?? null,
            created: result.created,
            vaultRoot: settings.vaultRoot,
            topDir: settings.topDir,
            chapters: state.chapters,
            resume: state.resume ?? null,
            concepts: topicConceptStateFor(settings, topic),
            warnings: settings.warnings,
          },
          isError: false,
        };
      }
      // 名字不合法时附上"去掉空白"的建议名，省一轮往返
      const suggestion = sanitizeName(placement.chapter ?? topic);
      const hint =
        suggestion && suggestion !== (placement.chapter ?? topic)
          ? ` — try "${suggestion}"`
          : "";
      return {
        content: [
          {
            type: "text" as const,
            text: `bind_notes failed: ${result.error}${hint}`,
          },
        ],
        details: {
          error: result.error,
          conflict: result.conflict ?? null,
          suggestedTopic: sanitizeName(topic) || null,
        },
        isError: true,
      };
    },
  });

  // ── 存量编号：现状 → 顺序计划 → 归档 + 改名 + 重写索引 ──────────────────
  const NumberChaptersParams = Type.Object({
    topic: Type.String({ description: "Existing topic to number." }),
    chapters: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Chapter names in teaching order. A name may carry its number (`第6章 · 加锁规则地图`, or `06-加锁规则地图`) — use that to keep a gap open for a chapter the plan numbers but you have not taught; otherwise numbers run from `startAt` in list order. Omit to get the current state plus a suggested order.",
      }),
    ),
    startAt: Type.Optional(
      Type.Number({ description: "First number to assign. Defaults to 1." }),
    ),
    apply: Type.Optional(
      Type.Boolean({
        description:
          "Defaults to false: return the plan only. Set true to archive the index, rename the chapter files, rewrite their headings and relink the index.",
      }),
    ),
  });

  pi.registerTool({
    name: NUMBER_CHAPTERS_TOOL_NAME,
    label: "Number Topic Chapters",
    description:
      "Give an existing topic's chapters their `第N章` numbers: rename `<名字>.md` → `<NN-名字>.md`, write `# 第N章 · 名字` as the first line and relink the index. " +
      "Call it without `chapters` to see the current numbers and a suggested order, then pass the teaching order you (and the user) agreed on. " +
      "Already numbered chapters are never renumbered: a conflict returns the offender so you can fix the order instead. The index is archived under _archive/ before it is rewritten; nothing is written while `apply` is false.",
    parameters: NumberChaptersParams,
    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      ctx: ExtensionContext,
    ) {
      const settings = settingsFor(ctx);
      const topicCheck = isValidTopic(params.topic);
      if (topicCheck.ok === false) {
        return errorResult(
          `number_chapters failed: ${rejectionHint(topicCheck.reason)}`,
        );
      }
      const topic = topicCheck.topic;
      const indexPath = topicNotePath({
        vaultRoot: settings.vaultRoot,
        topDir: settings.topDir,
        topic,
      });
      if (!fs.existsSync(indexPath)) {
        return errorResult(`number_chapters failed: no note at ${indexPath}`);
      }
      const dir = topicDirOf(indexPath);
      const scanned = scanChapters(dir, topic);
      const index = fs.readFileSync(indexPath, "utf-8");
      const entries = parseIndexEntries(index);

      const describe = (item: ScannedChapter): string =>
        `${chapterLabel(item.chapter.number, item.chapter.name)} · ${path.basename(item.file)} · ${item.chapter.number === undefined ? "未编号" : "已编号"}`;

      if (!params.chapters || params.chapters.length === 0) {
        if (scanned.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `${indexPath} has no chapter files yet.`,
              },
            ],
            details: { path: indexPath, chapters: [] },
            isError: false,
          };
        }
        const proposed = proposeChapterOrder({
          chapters: scanned.map((item) => ({
            ...item.chapter,
            touchedAt: item.touchedAt,
          })),
          indexOrder: entries.map((entry) => entry.name),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Chapters in ${indexPath} (${scanned.length}):`,
                ...scanned.map((item) => `- ${describe(item)}`),
                "",
                "Suggested order (index order first, then most recently touched):",
                ...proposed.map((name, position) => `${position + 1}. ${name}`),
                "",
                "Next: call number_chapters again with `chapters: [...]` in the teaching order (apply: false to preview, true to write).",
              ].join("\n"),
            },
          ],
          details: {
            path: indexPath,
            chapters: scanned.map((item) => ({
              ...item.chapter,
              file: item.file,
            })),
            suggestedOrder: proposed,
          },
          isError: false,
        };
      }

      const plan = planNumbering({
        chapters: params.chapters,
        existing: scanned.map((item) => ({ ...item.chapter, date: undefined })),
        startAt: params.startAt,
      });
      if (plan.ok === false) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                "number_chapters cannot proceed — fix the order and retry:",
                ...plan.conflicts.map(
                  (conflict) => `- ${conflict.name}: ${conflict.hint}`,
                ),
              ].join("\n"),
            },
          ],
          details: { path: indexPath, conflicts: plan.conflicts },
          isError: true,
        };
      }

      const changes = plan.assignments.filter(
        (assignment) => !assignment.unchanged,
      );
      const planLines = plan.assignments.map(
        (assignment) =>
          `- ${assignment.name}: ${assignment.from}.md → ${assignment.to}.md${assignment.unchanged ? " (已编号，跳过)" : ""}`,
      );
      const unassignedLine =
        plan.unassigned.length > 0
          ? `\n不在这份顺序里、也没编号的章节（保持原样）：${plan.unassigned.map((chapter) => chapter.name).join(", ")}`
          : "";

      if (params.apply !== true) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Plan for ${indexPath} (${changes.length} file(s) to rename):`,
                ...planLines,
                unassignedLine,
                "",
                "Call again with apply: true to archive the index, rename the files, rewrite the headings and relink the index.",
              ]
                .filter((line) => line.length > 0)
                .join("\n"),
            },
          ],
          details: {
            path: indexPath,
            assignments: plan.assignments,
            unassigned: plan.unassigned,
            apply: false,
          },
          isError: false,
        };
      }

      const date = new Date().toISOString().slice(0, 10);
      const written = applyChapterNumbering({
        indexPath,
        topic,
        scanned,
        assignments: plan.assignments,
        unassigned: plan.unassigned,
        date,
        boundFile: noteFile,
      });
      if (written.ok === false) {
        if (written.error === "bound-file") {
          return errorResult(
            `number_chapters refused: this session is mirroring ${written.file}.md — run /md-unlog first, then number the topic.`,
          );
        }
        return errorResult(
          `number_chapters refused: target file(s) already exist:\n${written.existing.join("\n")}`,
        );
      }

      if (written.changed === 0 && written.healedHeadings === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No changes: every chapter in ${indexPath} already has the planned number.`,
            },
          ],
          details: {
            path: indexPath,
            assignments: plan.assignments,
            unassigned: plan.unassigned,
            apply: true,
          },
          isError: false,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Numbered ${written.changed} chapter(s) in ${indexPath}${written.healedHeadings > 0 ? ` (repaired the heading in ${written.healedHeadings})` : ""}${written.archivePath ? `; index archived to _archive/${path.basename(written.archivePath)}` : ""}.`,
              ...planLines,
              unassignedLine,
            ]
              .filter((line) => line.length > 0)
              .join("\n"),
          },
        ],
        details: {
          path: indexPath,
          archivePath: written.archivePath,
          assignments: plan.assignments,
          unassigned: plan.unassigned,
          apply: true,
        },
        isError: false,
      };
    },
  });

  // ── 存量拆分：块目录 → 计划 → 归档 + 写章节 + 重写索引 ────────────────────
  const SplitTopicParams = Type.Object({
    topic: Type.String({
      description: "Existing topic whose single note should be split.",
    }),
    chapters: Type.Optional(
      Type.Array(
        Type.Object({
          name: Type.String({
            description: "Chapter name (2–6 汉字 is ideal, no number needed).",
          }),
          blockIndexes: Type.Array(Type.Number(), {
            description:
              "1-based block numbers from the catalog returned by this tool.",
          }),
        }),
        {
          description:
            "Chapter assignments **in teaching order** (they become 第1章, 第2章, …). Omit to get the block catalog first.",
        },
      ),
    ),
    apply: Type.Optional(
      Type.Boolean({
        description:
          "Defaults to false: return the plan only. Set true to archive the original, write the chapter files and rewrite the index.",
      }),
    ),
  });

  pi.registerTool({
    name: SPLIT_TOPIC_TOOL_NAME,
    label: "Split Topic Note",
    description:
      "Split an existing single-file topic note into an index + one file per chapter (`<NN-名字>.md`). Call it without `chapters` to get the block catalog (index + kind + preview), decide the chapter boundaries yourself, then call again with `chapters: [{ name, blockIndexes }]` (apply: false to preview, true to write). " +
      "The original is archived byte-for-byte under _archive/ first; nothing is written while `apply` is false.",
    parameters: SplitTopicParams,
    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      ctx: ExtensionContext,
    ) {
      const settings = settingsFor(ctx);
      const topicCheck = isValidTopic(params.topic);
      if (topicCheck.ok === false) {
        const hint = rejectionHint(topicCheck.reason);
        const suggestion = sanitizeName(params.topic);
        return {
          content: [
            {
              type: "text" as const,
              text: `split_topic failed: ${hint}${suggestion && suggestion !== params.topic ? ` — try topic "${suggestion}"` : ""}`,
            },
          ],
          details: { error: hint, suggestedTopic: suggestion || null },
          isError: true,
        };
      }
      const indexPath = topicNotePath({
        vaultRoot: settings.vaultRoot,
        topDir: settings.topDir,
        topic: topicCheck.topic,
      });
      if (!fs.existsSync(indexPath)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `split_topic failed: no note at ${indexPath}`,
            },
          ],
          details: { error: "missing-note", path: indexPath },
          isError: true,
        };
      }

      const markdown = fs.readFileSync(indexPath, "utf-8");
      const catalog = catalogBlocks(markdown);
      const assigned = params.chapters ?? [];

      if (assigned.length === 0) {
        if (catalog.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `${indexPath} has no callout blocks to split.`,
              },
            ],
            details: { path: indexPath, catalog: [] },
            isError: false,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Block catalog for ${indexPath} (${catalog.length} blocks):`,
                ...catalog.map(
                  (entry) => `${entry.index}. [${entry.kind}] ${entry.preview}`,
                ),
                "",
                "Next: call split_topic again with `chapters: [{ name, blockIndexes }]` in teaching order (apply: false to preview, true to write).",
              ].join("\n"),
            },
          ],
          details: { path: indexPath, catalog },
          isError: false,
        };
      }

      const plan = planSplit({
        markdown,
        chapters: assigned.map((chapter) => ({
          name: chapter.name,
          blockIndexes: chapter.blockIndexes,
        })),
      });
      if (plan.ok === false) {
        return {
          content: [
            {
              type: "text" as const,
              text: `split_topic plan rejected: ${plan.error}`,
            },
          ],
          details: { error: plan.error },
          isError: false,
        };
      }

      const date = new Date().toISOString().slice(0, 10);

      if (params.apply !== true) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Split plan for ${indexPath} (nothing written yet):`,
                ...plan.chapters.map(
                  (chapter) =>
                    `${chapterLabel(chapter.number, chapter.name)} ← blocks ${chapter.blockIndexes.join(", ")} · → ${chapter.fileName}.md`,
                ),
                "Index keeps the rest plus the title area.",
                "Call again with apply: true to archive the original and write the split.",
              ].join("\n"),
            },
          ],
          details: {
            path: indexPath,
            apply: false,
            chapters: plan.chapters.map((chapter) => ({
              number: chapter.number,
              name: chapter.name,
              fileName: chapter.fileName,
              blockIndexes: chapter.blockIndexes,
            })),
          },
          isError: false,
        };
      }

      const written = applyTopicSplit({
        indexPath,
        topic: topicCheck.topic,
        date,
        plan,
        chapterPathOf: (chapter) =>
          chapterNotePath({
            vaultRoot: settings.vaultRoot,
            topDir: settings.topDir,
            topic: topicCheck.topic,
            chapter: chapter.name,
            number: chapter.number,
          }),
      });
      if (written.ok === false) {
        return {
          content: [
            {
              type: "text" as const,
              text: `split_topic refused: chapter file(s) already exist:\n${written.existing.join("\n")}`,
            },
          ],
          details: { error: written.error, existing: written.existing },
          isError: false,
        };
      }
      const archivePath = written.archivePath;

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Split ${indexPath} into ${written.chapters.length} chapter(s).`,
              `Archive: ${archivePath} (untracked — commit it if you want the pre-split copy kept; git clean would remove it)`,
              ...written.chapters.map(
                (chapter) =>
                  `${chapterLabel(chapter.number, chapter.name)} ← ${chapter.blocks} blocks · ${path.basename(chapter.path)}`,
              ),
            ].join("\n"),
          },
        ],
        details: {
          path: indexPath,
          apply: true,
          archivePath,
          chapters: written.chapters,
        },
        isError: false,
      };
    },
  });

  const NEW_TOPIC_ID = "__new_topic__";

  /**
   * 两个 picker 的壳完全一样：Core（applyPickerKey）决定动作，这里只做渲染、
   * 焦点态与结算。`focused` 让搜索框发出 CURSOR_MARKER —— pi 靠它把硬件光标
   * （以及 IME 候选窗）移进框里，否则光标停在编辑器位置，输入法没法落到搜索框。
   * 组件契约复用 shared/picker-view 的 `PickerComponent`（ask / quiz 用的是同一份）。
   */
  const showPicker = (args: {
    tui: { requestRender: () => void };
    done: (value: string | undefined) => void;
    title: string;
    rows: PickerOption[];
    emptyText: string;
    /** 初始光标（如章节 picker 的 resume 行）。 */
    cursor?: number;
  }): PickerComponent => {
    let state = { ...createPickerState(), cursor: args.cursor ?? 0 };
    const visible = (): PickerOption[] => filterOptions(args.rows, state.query);
    const component: PickerComponent = {
      focused: true,
      render: (width: number) =>
        renderPickerLines({
          title: args.title,
          options: visible(),
          state,
          width,
          multiSelect: false,
          focused: component.focused,
          footer: "↑/↓ 选择  type 过滤  enter 确认  esc 取消",
          emptyText: args.emptyText,
        }),
      invalidate: () => {},
      handleInput: (data: string) => {
        const action = applyPickerKey(data, state, visible().length);
        if (action.kind === "cancel") {
          args.done(undefined);
          return;
        }
        if (action.kind === "submit") {
          args.done(visible()[action.index]?.value);
          return;
        }
        if (action.kind === "update") {
          state = action.state;
          args.tui.requestRender();
        }
      },
    };
    return component;
  };

  /**
   * 无参 `/md-topic`：用 picker 选已有主题（或新建），复用 shared/picker-*。
   * 整段交互（picker + 「新建主题…」的名字输入）都占着终端，所以走 sharedUiGate：
   * 终端只有一块编辑器槽位，别的模态要等这次交互出闸（见 ui-gate）。
   */
  const pickTopic = (
    ctx: ExtensionContext,
    options: { suggested?: string } = {},
  ): Promise<string | undefined> =>
    sharedUiGate.run(async () => {
      const topics = listTopics(settingsFor(ctx));
      const rows: PickerOption[] = [
        ...topics.map((entry) => ({
          id: entry.topic,
          label: `${entry.topic}${entry.chapters > 0 ? ` · ${entry.chapters} 章` : ""}${entry.lastTouchedAt ? ` · ${formatTouchedAt(entry.lastTouchedAt)}` : ""}`,
          value: entry.topic,
          kind: "option" as const,
        })),
        {
          id: NEW_TOPIC_ID,
          label: "＋ 新建主题…",
          value: NEW_TOPIC_ID,
          kind: "other" as const,
        },
      ];
      const picked = await ctx.ui.custom<string | undefined>(
        (tui, _theme, _kb, done) =>
          showPicker({
            tui,
            done,
            title: "选择主题",
            rows,
            emptyText: "没有匹配的主题，清空搜索可选「新建主题…」",
          }),
      );
      if (picked === undefined) return undefined;
      if (picked !== NEW_TOPIC_ID) return picked;
      // agent 提议的名字只做 placeholder：人能看到、能改、能放弃。
      const created = await ctx.ui.input("新主题名", options.suggested);
      return created?.trim() || undefined;
    });

  type ChapterChoice = { kind: "chapter"; name: string } | { kind: "index" };

  /**
   * 章节 picker：已有章节（resume 那章带 `· 续做` 尾标并作为初始光标）+
   * 「＋新建章节…」+「主题索引页」。返回 undefined 表示取消（esc / 空输入）。
   * 与 pickTopic 一样独占终端，走 sharedUiGate。
   */
  const pickChapter = (
    ctx: ExtensionContext,
    topic: string,
    options: { suggested?: string } = {},
  ): Promise<ChapterChoice | undefined> =>
    sharedUiGate.run(async () => {
      const settings = settingsFor(ctx);
      const state = topicStateFor(settings, topic);
      const { rows, cursor } = chapterPickerOptions({
        chapters: state.chapters,
        resume: state.resume,
      });
      const picked = await ctx.ui.custom<string | undefined>(
        (tui, _theme, _kb, done) =>
          showPicker({
            tui,
            done,
            title: `选择章节 · ${topic}`,
            rows,
            emptyText: "没有匹配的章节",
            cursor,
          }),
      );
      if (picked === undefined) return undefined;
      if (picked === CHAPTER_PICKER_INDEX_ID) return { kind: "index" };
      if (picked === CHAPTER_PICKER_NEW_ID) {
        const name = (
          await ctx.ui.input("新章节名", options.suggested)
        )?.trim();
        return name ? { kind: "chapter", name } : undefined;
      }
      return { kind: "chapter", name: picked };
    });

  pi.registerCommand("md-topic", {
    description:
      "Bind the session mirror to <vault>/<topDir>/<主题>/<主题>.md（无参时先弹主题 picker；给主题时弹章节 picker：已有章节 / ＋新建章节… / 主题索引页；`/md-topic <主题> <章节>` 绕过 picker 直接切到该章，章节可写 `第3章` 或 `调度与唤醒`）",
    handler: async (args, ctx) => {
      const trimmedArgs = args.trim();
      let topic = trimmedArgs;
      let chapter: string | undefined;
      let chapterNumber: number | undefined;
      let explicitChapter = false;
      if (!topic) {
        const picked = await pickTopic(ctx);
        if (!picked) {
          ctx.ui.notify("未选择主题。", "warning");
          return;
        }
        topic = picked;
      } else {
        const [first, ...rest] = trimmedArgs.split(/\s+/);
        topic = first;
        if (rest.length > 0) {
          explicitChapter = true;
          // `/md-topic <主题> 第3章` 也能绑：先按引用解析，再按名字匹配目录里的章节。
          const ref = parseChapterRef(rest.join(" "));
          const settings = settingsFor(ctx);
          const dir = topicDirOf(
            topicNotePath({
              vaultRoot: settings.vaultRoot,
              topDir: settings.topDir,
              topic,
            }),
          );
          const scanned = scanChapters(dir, topic);
          const byNumber =
            ref.number === undefined
              ? undefined
              : scanned.find((item) => item.chapter.number === ref.number)
                  ?.chapter.name;
          chapter = ref.name ?? byNumber ?? rest.join(" ");
          chapterNumber = ref.number;
        }
      }
      if (!explicitChapter) {
        const choice = await pickChapter(ctx, topic);
        if (!choice) {
          ctx.ui.notify("未选择章节。", "warning");
          return;
        }
        if (choice.kind === "chapter") chapter = choice.name;
      }
      const result = bindFromSettings(ctx, topic, chapter, chapterNumber);
      if (result.ok === false) {
        const hint = result.suggestedChapter
          ? ` — try "${result.suggestedChapter}"`
          : "";
        ctx.ui.notify(
          `Cannot bind topic note: ${result.error}${hint}`,
          "error",
        );
        return;
      }
      const backfilled = await backfill(ctx);
      const state = topicStateFor(settingsFor(ctx), topic.trim());
      const resumeChapter =
        state.resume &&
        state.chapters.find((item) => item.name === state.resume?.chapter);
      const label = state.resume
        ? ` · 续做：${chapterLabel(resumeChapter?.number, state.resume.chapter)}${
            state.resume.reason === "recent" ? "" : `（${state.resume.reason}）`
          }`
        : "";
      const bound = result.chapter
        ? `（章节：${chapterLabel(result.number, result.chapter)}）`
        : "";
      const healed = result.healedFrom
        ? ` · 已给旧章节补编号：${path.basename(result.healedFrom)} → ${path.basename(result.file)}`
        : "";
      ctx.ui.notify(
        `Bound: ${result.file}${bound}${healed}${backfilled > 0 ? ` (${backfilled} blocks backfilled)` : ""}${label}`,
        "info",
      );
    },
  });

  pi.registerCommand("md-log", {
    description:
      "Mirror the session to an existing markdown file (never creates one)",
    handler: async (args, ctx) => {
      const target = args.trim();
      if (!target) {
        ctx.ui.notify("Usage: /md-log <filepath>", "warning");
        return;
      }
      const resolved = path.isAbsolute(target)
        ? target
        : path.resolve(ctx.cwd, target);
      const result = bind(ctx, resolved, { create: false });
      if (result.ok === false) {
        ctx.ui.notify(`Cannot bind: ${result.error}`, "error");
        return;
      }
      const backfilled = await backfill(ctx);
      ctx.ui.notify(
        `Linked: ${resolved}${backfilled > 0 ? ` (${backfilled} blocks backfilled)` : ""}`,
        "info",
      );
    },
  });

  pi.registerCommand("md-unlog", {
    description: "Stop mirroring the session to the linked markdown file",
    handler: async (_args, ctx) => {
      if (!noteFile) {
        ctx.ui.notify("No markdown file is linked.", "warning");
        return;
      }
      noteFile = null;
      mirror = null;
      pi.appendEntry(ENTRY_TYPE, { file: null });
      // 解绑也是「绑定状态变化」：mode 控制器按会话条目重新推导（下一轮关闸）。
      deps.onBindingChange?.({ file: null, inVault: false });
      setStatus(ctx);
      ctx.ui.notify("Unlinked session mirror.", "info");
    },
  });

  /** 链接后回填本次会话已有的内容（只看当前分支）。 */
  async function backfill(ctx: ExtensionContext): Promise<number> {
    const blocks: string[] = [];
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "message") continue;
      const message = (
        entry as { message?: { role?: string; content?: unknown } }
      ).message;
      if (!message?.role) continue;
      if (message.role === "user") {
        const text = stripSkillBlocks(
          messageText(message.content as never).trim(),
        );
        if (text) blocks.push(formatUserBlock(text));
        continue;
      }
      if (message.role === "assistant") {
        const text = mirrorAssistantText(message.content);
        if (text) blocks.push(formatAssistantBlock(text));
        continue;
      }
      const toolName = (entry as { message?: { toolName?: string } }).message
        ?.toolName;
      if (message.role === "toolResult" && toolName && QA_TOOLS.has(toolName)) {
        const block = formatAnswerBlock(
          (entry as { message?: { details?: unknown } }).message?.details,
        );
        if (block) blocks.push(block);
      }
    }
    if (blocks.length === 0) return 0;
    await appendBlock(blocks.join("\n\n"));
    return blocks.length;
  }
};
