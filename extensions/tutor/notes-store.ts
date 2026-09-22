/**
 * notes-store — 会话镜像的 IO 与事件接线（Imperative Shell）。
 *
 * 职责边界：
 * - 持有"本次会话绑定到哪篇笔记"这一状态，并随会话恢复（`pi.appendEntry`）。
 * - 唯一落盘出口：串行锁 + 只追加，永不重写整篇。
 * - 绑定路径由 notes-core 的纯函数算出，这里只做 mkdir/读现有的内容。
 *
 * 命令与工具：
 * - `/md-topic [主题] [章节]`：无参弹 picker（列出 `Learn/` 下已有主题 + 「新建主题…」）；
 *   给主题时按设置拼出 `<vaultRoot>/<topDir>/<主题>/<主题>.md`（给章节则是 `<章节>.md`）。
 * - `/md-log <路径>`：只链接**已存在**的文件（保留 learn 的安全语义，不因笔误造文件）。
 * - `/md-unlog`：解绑。
 * - `bind_notes` 工具：agent 可调用（`/命令` 只能由人敲，skill 需要自主开篇），
 *   并回报「恢复摘要」（章节统计 + resume），让新会话能接着上次没做完的地方继续。
 * - `split_topic` 工具：存量单文件笔记 → 索引 + 章节（默认只出计划，apply 才落盘）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  createPickerState,
  moveCursor,
  type PickerOption,
} from "../shared/picker-core.ts";
import { renderPickerLines } from "../shared/picker-view.ts";
import { loadSettings } from "../shared/settings.ts";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  BIND_NOTES_TOOL_NAME,
  NUMBER_CHAPTERS_TOOL_NAME,
  QUIZ_TOOL_NAME,
  SPLIT_TOPIC_TOOL_NAME,
} from "./names.ts";
import {
  buildTopicState,
  type ChapterFile,
  type ChapterState,
  catalogBlocks,
  chapterFileName,
  chapterLabel,
  chapterNotePath,
  expandHome,
  formatAnswerBlock,
  formatAssistantBlock,
  formatQuestionBlock,
  formatSectionHeader,
  formatTopicHeader,
  formatUserBlock,
  hasIndexEntry,
  indexEntryLine,
  isValidChapter,
  isValidTopic,
  messageText,
  mirrorAssistantText,
  type NumberingAssignment,
  parseChapterFileName,
  parseChapterRef,
  parseIndexEntries,
  planNumbering,
  planSplit,
  proposeChapterOrder,
  provenanceBlock,
  relinkIndex,
  resolveChapterNumber,
  resolveTutorSettings,
  rewriteChapterHeading,
  sanitizeName,
  stripSkillBlocks,
  summarizeChapter,
  type TopicRejection,
  topicDirOf,
  topicNotePath,
  upsertChapterToc,
} from "./notes-core.ts";
import type { QuizDetails } from "./quiz-core.ts";

const ENTRY_TYPE = "tutor-notes";
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

type NotesDeps = {
  cwd: string;
  home: string;
};

const resolveSettings = (deps: NotesDeps) => {
  const settings = resolveTutorSettings(loadSettings(deps.cwd).merged);
  return {
    ...settings,
    vaultRoot: expandHome(settings.vaultRoot, deps.home),
  };
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

export type ScannedChapter = {
  chapter: ChapterFile;
  file: string;
  markdown: string;
  touchedAt: string;
};

/** 扫一个主题目录里的章节文件：文件名就是编号的权威来源。 */
export const scanChapters = (dir: string, topic: string): ScannedChapter[] => {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".md") &&
        entry.name !== `${topic}.md`,
    )
    .map((entry) => {
      const file = path.join(dir, entry.name);
      const base = entry.name.replace(/\.md$/, "");
      const { number, name } = parseChapterFileName(base);
      return {
        chapter: { number, name },
        file,
        markdown: fs.readFileSync(file, "utf-8"),
        touchedAt: new Date(fs.statSync(file).mtimeMs).toISOString(),
      };
    });
};

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

export const registerNotes = (pi: ExtensionAPI): void => {
  let noteFile: string | null = null;
  let writeLock: Promise<void> = Promise.resolve();
  const loggedQuestions = new Set<string>();

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
    const settings = resolveSettings({ cwd: ctx.cwd, home: os.homedir() });
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

  /** 从 vault 推导主题状态：编号优先，未编号的按索引顺序、再按 mtime 补在后。 */
  const topicStateFor = (
    indexPath: string,
    topic: string,
  ): ReturnType<typeof buildTopicState> => {
    const index = fs.existsSync(indexPath)
      ? fs.readFileSync(indexPath, "utf-8")
      : "";
    const dir = topicDirOf(indexPath);
    const scanned = scanChapters(dir, topic);
    const chapters: ChapterState[] = scanned.map((item) =>
      summarizeChapter({
        number: item.chapter.number,
        name: item.chapter.name,
        path: item.file,
        markdown: item.markdown,
        touchedAt: item.touchedAt,
      }),
    );
    const indexed = parseIndexEntries(index).map((entry) => entry.name);
    const order = proposeChapterOrder({
      chapters: scanned.map((item) => ({
        ...item.chapter,
        touchedAt: item.touchedAt,
      })),
      indexOrder: indexed,
    });
    const rank = new Map(order.map((name, position) => [name, position]));
    const ordered = [...chapters].sort((a, b) => {
      if (a.number !== undefined && b.number !== undefined)
        return a.number - b.number;
      if (a.number !== undefined) return -1;
      if (b.number !== undefined) return 1;
      return (
        (rank.get(a.name) ?? 0) - (rank.get(b.name) ?? 0) ||
        (a.touchedAt ?? "").localeCompare(b.touchedAt ?? "")
      );
    });
    return buildTopicState({ topic, index, chapters: ordered });
  };

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
      if (text) await appendBlock(formatUserBlock(text));
      return;
    }
    if (message?.role === "assistant") {
      // 正文块：题面由 quiz / ask 的 pending 块写，正文里重复的那份不带进笔记。
      const text = mirrorAssistantText(message.content);
      if (text) await appendBlock(formatAssistantBlock(text));
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
    await appendBlock(
      formatQuestionBlock({
        kind: "Quiz",
        question: details.question,
        context: details.context,
        options: details.options,
      }),
    );
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
    await appendBlock(
      formatQuestionBlock({
        kind: "Question",
        question: String(input.question ?? ""),
        context: typeof input.details === "string" ? input.details : undefined,
        options,
      }),
    );
  });

  pi.on("tool_result", async (event, _ctx) => {
    if (!noteFile || !QA_TOOLS.has(event.toolName)) return;
    const block = formatAnswerBlock((event as { details?: unknown }).details);
    if (block) await appendBlock(block);
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
          "Chapter name (no number — the tool owns numbering). When given, the mirror switches to <topic>/<NN-章节>.md and returns the chapter's label `第N章 · 名字`. Bind the chapter BEFORE teaching it, otherwise that chapter's questions land in the previous file.",
      }),
    ),
    chapterNumber: Type.Optional(
      Type.Number({
        description:
          "Optional explicit chapter number. Omit to take the next free number (max + 1 — gaps left by skipped chapters are never auto-filled). Pass the number from your plan when the plan already numbers its chapters; a taken number fails with the occupant, taken numbers, gaps and the auto number so you can fix it in one go. Chapters already numbered are never renumbered.",
      }),
    ),
  });

  pi.registerTool({
    name: BIND_NOTES_TOOL_NAME,
    label: "Bind Topic Notes",
    description:
      "Bind this session's note mirror to the topic's markdown file in the notes vault, creating the directory and file when missing. " +
      "Call it once at the start of a teaching session, then every reply and quiz answer is appended to that same note. " +
      "Pass `chapter` before teaching a chapter: it assigns the chapter number, writes `<NN-章节>.md` with `# 第N章 · 名字` as its first line, adds the index line and refreshes the index's `## 章节` block. The returned `第N章 · 名字` label is the only authoritative way to refer to that chapter afterwards. " +
      "It also returns a resume summary: the topic's chapters with their quiz tallies, and which chapter to continue from.",
    parameters: BindNotesParams,
    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      ctx: ExtensionContext,
    ) {
      const settings = resolveSettings({ cwd: ctx.cwd, home: os.homedir() });
      const result = bindFromSettings(
        ctx,
        params.topic,
        params.chapter,
        params.chapterNumber,
      );
      if (result.ok === true) {
        const state = topicStateFor(result.indexPath, params.topic.trim());
        const resumeChapter =
          state.resume &&
          state.chapters.find((item) => item.name === state.resume?.chapter);
        const resumeLine = state.resume
          ? `\nResume from chapter "${chapterLabel(resumeChapter?.number, state.resume.chapter)}" (${state.resume.reason}).`
          : "\nThis topic has no chapters yet.";
        const chaptersLine =
          state.chapters.length > 0
            ? `\nChapters: ${state.chapters
                .map(
                  (chapter) =>
                    `${chapterLabel(chapter.number, chapter.name)} (ok ${chapter.ok} / wrong ${chapter.wrong} / gaps ${chapter.gaps}${chapter.unanswered > 0 ? ` / unanswered ${chapter.unanswered}` : ""})`,
                )
                .join("; ")}`
            : "";
        const healedLine = result.healedFrom
          ? `\nHealed legacy chapter file ${path.basename(result.healedFrom)} → ${path.basename(result.file)}.`
          : "";
        const unnumberedLine =
          result.unnumbered && result.unnumbered.length > 0
            ? `\nStill unnumbered in this topic: ${result.unnumbered.join(", ")} — call number_chapters to number them.`
            : "";
        const chapterLine = result.chapter
          ? ` (chapter: ${chapterLabel(result.number, result.chapter)})`
          : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `Bound session notes to ${result.file}${chapterLine}${healedLine}${resumeLine}${chaptersLine}${unnumberedLine}\nEvery reply, question and answer is appended to this file (append-only).`,
            },
          ],
          details: {
            path: result.file,
            index: result.indexPath,
            chapter: result.chapter ?? null,
            chapterNumber: result.number ?? null,
            healedFrom: result.healedFrom ?? null,
            created: result.created,
            vaultRoot: settings.vaultRoot,
            topDir: settings.topDir,
            chapters: state.chapters,
            resume: state.resume ?? null,
            warnings: settings.warnings,
          },
          isError: false,
        };
      }
      // 名字不合法时附上"去掉空白"的建议名，省一轮往返
      const suggestion = sanitizeName(params.chapter ?? params.topic);
      const hint =
        suggestion && suggestion !== (params.chapter ?? params.topic)
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
          suggestedTopic: sanitizeName(params.topic) || null,
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
      const settings = resolveSettings({ cwd: ctx.cwd, home: os.homedir() });
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
      const settings = resolveSettings({ cwd: ctx.cwd, home: os.homedir() });
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

  /** `Learn/` 下已有主题概览（供 picker 用）。 */
  const listTopics = (): {
    topic: string;
    chapters: number;
    lastTouched: string | null;
  }[] => {
    const settings = resolveSettings({
      cwd: process.cwd(),
      home: os.homedir(),
    });
    const root = path.join(settings.vaultRoot, settings.topDir);
    if (!fs.existsSync(root)) return [];
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "_archive")
      .map((entry) => {
        const dir = path.join(root, entry.name);
        const files = fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((item) => item.isFile() && item.name.endsWith(".md"));
        const newest = files.reduce((acc, item) => {
          const mtime = fs.statSync(path.join(dir, item.name)).mtimeMs;
          return mtime > acc ? mtime : acc;
        }, 0);
        return {
          topic: entry.name,
          chapters: files.filter((item) => item.name !== `${entry.name}.md`)
            .length,
          lastTouched:
            newest > 0
              ? new Date(newest).toISOString().slice(0, 16).replace("T", " ")
              : null,
        };
      })
      .sort((a, b) => (b.lastTouched ?? "").localeCompare(a.lastTouched ?? ""));
  };

  const NEW_TOPIC_ID = "__new_topic__";

  /** 无参 `/md-topic`：用 picker 选已有主题（或新建），复用 shared/picker-*。 */
  const pickTopic = async (
    ctx: ExtensionContext,
  ): Promise<string | undefined> => {
    const topics = listTopics();
    const rows: PickerOption[] = [
      ...topics.map((entry) => ({
        id: entry.topic,
        label: `${entry.topic}${entry.chapters > 0 ? ` · ${entry.chapters} 章` : ""}${entry.lastTouched ? ` · ${entry.lastTouched}` : ""}`,
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
      (tui, _theme, _kb, done) => {
        let state = createPickerState();
        const answer = (index: number): void => {
          done(rows[index]?.value);
        };
        return {
          render: (width: number) =>
            renderPickerLines({
              title: "选择主题",
              options: rows,
              state,
              width,
              multiSelect: false,
              footer: "↑/↓ 选择  enter 确认  esc 取消",
              emptyText: "还没有主题，选「新建主题…」",
            }),
          invalidate: () => {},
          handleInput: (data: string) => {
            if (data === "\u001b") {
              done(undefined);
              return;
            }
            if (data === "\r" || data === "\n") {
              answer(state.cursor);
              return;
            }
            if (data === "\u001b[A" || data === "k") {
              state = moveCursor(state, -1, rows.length);
              tui.requestRender();
              return;
            }
            if (data === "\u001b[B" || data === "j") {
              state = moveCursor(state, 1, rows.length);
              tui.requestRender();
            }
          },
        };
      },
    );
    if (picked === undefined) return undefined;
    if (picked !== NEW_TOPIC_ID) return picked;
    const created = await ctx.ui.input("新主题名");
    return created?.trim() || undefined;
  };

  pi.registerCommand("md-topic", {
    description:
      "Bind the session mirror to <vault>/<topDir>/<主题>/<主题>.md（无参时弹 picker 选主题；`/md-topic <主题> <章节>` 可切到某章，章节可写 `第3章` 或 `调度与唤醒`）",
    handler: async (args, ctx) => {
      const trimmedArgs = args.trim();
      let topic = trimmedArgs;
      let chapter: string | undefined;
      let chapterNumber: number | undefined;
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
          // `/md-topic <主题> 第3章` 也能绑：先按引用解析，再按名字匹配目录里的章节。
          const ref = parseChapterRef(rest.join(" "));
          const settings = resolveSettings({
            cwd: ctx.cwd,
            home: os.homedir(),
          });
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
      const result = bindFromSettings(ctx, topic, chapter, chapterNumber);
      if (result.ok === false) {
        ctx.ui.notify(`Cannot bind topic note: ${result.error}`, "error");
        return;
      }
      const backfilled = await backfill(ctx);
      const state = topicStateFor(result.indexPath, topic.trim());
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
      pi.appendEntry(ENTRY_TYPE, { file: null });
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
