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
import type { AskDetails } from "./ask-core.ts";
import {
  buildTopicState,
  type ChapterState,
  catalogBlocks,
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
  isValidSection,
  isValidTopic,
  messageText,
  planSplit,
  provenanceBlock,
  resolveTutorSettings,
  sanitizeName,
  stripSkillBlocks,
  summarizeChapter,
  type TopicRejection,
  topicDirOf,
  topicNotePath,
} from "./notes-core.ts";
import type { QuizDetails } from "./quiz-core.ts";

const ENTRY_TYPE = "tutor-notes";
const STATUS_KEY = "tutor-notes";
const QA_TOOLS = new Set(["quiz", "ask_user_question"]);

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

/** 章节文件的开头与索引页不同：标明它属于哪个主题。 */
export const ensureSectionNote = (
  file: string,
  topic: string,
  section: string,
): { created: boolean } => {
  fs.mkdirSync(topicDirOf(file), { recursive: true });
  if (fs.existsSync(file)) return { created: false };
  fs.writeFileSync(file, formatSectionHeader(topic, section), "utf-8");
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

/** 索引页只追加一章一行（已存在则不动）。 */
export const appendIndexEntryOnce = (
  indexPath: string,
  section: string,
  date: string = new Date().toISOString().slice(0, 10),
): { appended: boolean } => {
  ensureTopicNote(indexPath);
  const current = fs.existsSync(indexPath)
    ? fs.readFileSync(indexPath, "utf-8")
    : "";
  if (hasIndexEntry(current, section)) return { appended: false };
  appendToNote(indexPath, indexEntryLine({ section, date }));
  return { appended: true };
};

export type SplitWriteResult =
  | {
      ok: true;
      archivePath: string;
      sections: { name: string; path: string; blocks: number }[];
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
    sections: { name: string; markdown: string; blockIndexes: number[] }[];
  };
  chapterPathOf: (section: string) => string;
}): SplitWriteResult => {
  const existing = input.plan.sections
    .map((section) => input.chapterPathOf(section.name))
    .filter((file) => fs.existsSync(file));
  if (existing.length > 0)
    return { ok: false, error: "chapter-exists", existing };

  const archiveDir = path.join(topicDirOf(input.indexPath), "_archive");
  fs.mkdirSync(archiveDir, { recursive: true });
  const archiveName = `${input.topic}.${input.date}.md`;
  const archivePath = path.join(archiveDir, archiveName);
  fs.copyFileSync(input.indexPath, archivePath);

  const sectionNames = input.plan.sections.map((section) => section.name);
  fs.writeFileSync(
    input.indexPath,
    [
      input.plan.prefix,
      provenanceBlock({
        date: input.date,
        sections: sectionNames,
        archiveName,
      }),
      ...input.plan.remaining,
    ]
      .filter((part) => part.trim().length > 0)
      .join("\n\n")
      .concat("\n"),
    "utf-8",
  );

  const sections = input.plan.sections.map((section) => {
    const file = input.chapterPathOf(section.name);
    fs.mkdirSync(topicDirOf(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${formatSectionHeader(input.topic, section.name)}\n${section.markdown}`,
      "utf-8",
    );
    return {
      name: section.name,
      path: file,
      blocks: section.blockIndexes.length,
    };
  });
  return { ok: true, archivePath, sections };
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
      section?: string;
      header?: { topic: string; section: string };
    },
  ): { ok: true; created: boolean } | { ok: false; error: string } => {
    let created = false;
    if (options.create) {
      created = options.header
        ? ensureSectionNote(file, options.header.topic, options.header.section)
            .created
        : ensureTopicNote(file).created;
    } else {
      const check = checkExistingFile(file);
      if (check.ok === false) return { ok: false, error: check.error };
    }
    noteFile = file;
    pi.appendEntry(ENTRY_TYPE, { file, section: options.section ?? null });
    setStatus(ctx);
    return { ok: true, created };
  };

  /** 索引页只追加一行（首次绑定该章节时）；索引页缺失则按主题 header 建出来。 */
  const appendIndexEntry = (indexPath: string, section: string): void => {
    appendIndexEntryOnce(indexPath, section);
  };

  type BindOutcome =
    | {
        ok: true;
        file: string;
        indexPath: string;
        created: boolean;
        section?: string;
      }
    | { ok: false; error: string };

  const bindFromSettings = (
    ctx: ExtensionContext,
    topic: string,
    section?: string,
  ): BindOutcome => {
    const topicCheck = isValidTopic(topic);
    if (topicCheck.ok === false) {
      return { ok: false, error: rejectionHint(topicCheck.reason) };
    }
    let cleanSection: string | undefined;
    if (section !== undefined && section.trim().length > 0) {
      const sectionCheck = isValidSection(section);
      if (sectionCheck.ok === false) {
        return { ok: false, error: rejectionHint(sectionCheck.reason) };
      }
      cleanSection = sectionCheck.topic;
    }
    const settings = resolveSettings({ cwd: ctx.cwd, home: os.homedir() });
    const indexPath = topicNotePath({
      vaultRoot: settings.vaultRoot,
      topDir: settings.topDir,
      topic: topicCheck.topic,
    });
    const file = chapterNotePath({
      vaultRoot: settings.vaultRoot,
      topDir: settings.topDir,
      topic: topicCheck.topic,
      section: cleanSection,
    });
    const result = bind(ctx, file, {
      create: true,
      section: cleanSection,
      header: cleanSection
        ? { topic: topicCheck.topic, section: cleanSection }
        : undefined,
    });
    if (result.ok === false) return { ok: false, error: result.error };
    if (cleanSection) appendIndexEntry(indexPath, cleanSection);
    return {
      ok: true,
      file,
      indexPath,
      created: result.created,
      section: cleanSection,
    };
  };

  /** 从 vault 推导主题状态：索引顺序优先，未入索引的按 mtime 追加在后。 */
  const topicStateFor = (
    indexPath: string,
    topic: string,
  ): ReturnType<typeof buildTopicState> => {
    const index = fs.existsSync(indexPath)
      ? fs.readFileSync(indexPath, "utf-8")
      : "";
    const dir = topicDirOf(indexPath);
    const entries = fs.existsSync(dir)
      ? fs
          .readdirSync(dir, { withFileTypes: true })
          .filter(
            (entry) =>
              entry.isFile() &&
              entry.name.endsWith(".md") &&
              entry.name !== `${topic}.md`,
          )
      : [];
    const chapters: ChapterState[] = entries.map((entry) => {
      const filePath = path.join(dir, entry.name);
      const stat = fs.statSync(filePath);
      const markdown = fs.readFileSync(filePath, "utf-8");
      return summarizeChapter({
        name: entry.name.replace(/\.md$/, ""),
        path: filePath,
        markdown,
        touchedAt: new Date(stat.mtimeMs).toISOString(),
      });
    });
    const order = new Map<string, number>();
    let cursor = 0;
    for (const chapter of chapters) {
      if (index.includes(`[[${chapter.name}]]`))
        order.set(chapter.name, cursor++);
    }
    const ordered = [...chapters].sort((a, b) => {
      const oa = order.get(a.name);
      const ob = order.get(b.name);
      if (oa !== undefined && ob !== undefined) return oa - ob;
      if (oa !== undefined) return -1;
      if (ob !== undefined) return 1;
      return (a.touchedAt ?? "").localeCompare(b.touchedAt ?? "");
    });
    return buildTopicState({ topic, index, chapters: ordered });
  };

  // ── 会话恢复 ──────────────────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    let last: { file: string | null; section?: string | null } | undefined;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
        last = entry.data as
          | { file: string | null; section?: string | null }
          | undefined;
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
      const text = messageText(message.content as never);
      if (text) await appendBlock(formatAssistantBlock(text));
    }
  });

  // quiz 会在 execute 内洗牌：只认 onUpdate 发出的"用户实际看到的顺序"，
  // 并且每个 toolCallId 只写一次。
  pi.on("tool_execution_update", async (event, _ctx) => {
    if (!noteFile || event.toolName !== "quiz") return;
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
    if (!noteFile || event.toolName !== "ask_user_question") return;
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
    const details = (event as { details?: QuizDetails | AskDetails }).details;
    if (!details || details.status === "pending") return;
    await appendBlock(formatAnswerBlock(details));
  });

  // ── 绑定：工具（agent 可调） + 命令（人可敲） ─────────────────────────────
  const BindNotesParams = Type.Object({
    topic: Type.String({
      description:
        "Teaching topic. Becomes both directory and file name under the notes vault (e.g. 分布式共识 → Learn/分布式共识/分布式共识.md).",
    }),
    section: Type.Optional(
      Type.String({
        description:
          "Chapter name. When given, the mirror switches to <topic>/<section>.md. Bind the chapter BEFORE teaching it, otherwise that chapter's questions land in the previous file.",
      }),
    ),
  });

  pi.registerTool({
    name: "bind_notes",
    label: "Bind Topic Notes",
    description:
      "Bind this session's note mirror to the topic's markdown file in the notes vault, creating the directory and file when missing. " +
      "Call it once at the start of a teaching session, then every reply and quiz answer is appended to that same note. " +
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
      const result = bindFromSettings(ctx, params.topic, params.section);
      if (result.ok === true) {
        const state = topicStateFor(result.indexPath, params.topic.trim());
        const resumeLine = state.resume
          ? `\nResume from chapter "${state.resume.chapter}" (${state.resume.reason}).`
          : "\nThis topic has no chapters yet.";
        const chaptersLine =
          state.chapters.length > 0
            ? `\nChapters: ${state.chapters
                .map(
                  (chapter) =>
                    `${chapter.name} (ok ${chapter.ok} / wrong ${chapter.wrong} / gaps ${chapter.gaps}${chapter.unanswered > 0 ? ` / unanswered ${chapter.unanswered}` : ""})`,
                )
                .join("; ")}`
            : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `Bound session notes to ${result.file}${result.section ? ` (chapter: ${result.section})` : ""}${resumeLine}${chaptersLine}\nEvery reply, question and answer is appended to this file (append-only).`,
            },
          ],
          details: {
            path: result.file,
            index: result.indexPath,
            section: result.section ?? null,
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
      const suggestion = sanitizeName(params.topic);
      const hint =
        suggestion && suggestion !== params.topic
          ? ` — try topic "${suggestion}"`
          : "";
      return {
        content: [
          {
            type: "text" as const,
            text: `bind_notes failed: ${result.error}${hint}`,
          },
        ],
        details: { error: result.error, suggestedTopic: suggestion || null },
        isError: true,
      };
    },
  });

  // ── 存量拆分：块目录 → 计划 → 归档 + 写章节 + 重写索引 ────────────────────
  const SplitTopicParams = Type.Object({
    topic: Type.String({
      description: "Existing topic whose single note should be split.",
    }),
    sections: Type.Optional(
      Type.Array(
        Type.Object({
          name: Type.String({
            description: "Chapter name (2–6 汉字 is ideal).",
          }),
          blockIndexes: Type.Array(Type.Number(), {
            description:
              "1-based block numbers from the catalog returned by this tool.",
          }),
        }),
        {
          description:
            "Chapter assignments. Omit to get the block catalog first.",
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
    name: "split_topic",
    label: "Split Topic Note",
    description:
      "Split an existing single-file topic note into an index + one file per chapter. Call it without `sections` to get the block catalog (index + kind + preview), decide the chapter boundaries yourself, then call again with `sections` (and `apply: true` to write). " +
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
      const assigned = params.sections ?? [];

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
                "Next: call split_topic again with `sections: [{ name, blockIndexes }]` (apply: false to preview, true to write).",
              ].join("\n"),
            },
          ],
          details: { path: indexPath, catalog },
          isError: false,
        };
      }

      const plan = planSplit({
        markdown,
        sections: assigned.map((section) => ({
          name: section.name,
          blockIndexes: section.blockIndexes,
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
                ...plan.sections.map(
                  (section) =>
                    `${section.name} ← blocks ${section.blockIndexes.join(", ")}`,
                ),
                "Index keeps the rest plus the title area.",
                "Call again with apply: true to archive the original and write the split.",
              ].join("\n"),
            },
          ],
          details: {
            path: indexPath,
            apply: false,
            sections: plan.sections.map((section) => ({
              name: section.name,
              blockIndexes: section.blockIndexes,
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
        chapterPathOf: (section) =>
          chapterNotePath({
            vaultRoot: settings.vaultRoot,
            topDir: settings.topDir,
            topic: topicCheck.topic,
            section,
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
              `Split ${indexPath} into ${written.sections.length} chapter(s).`,
              `Archive: ${archivePath} (untracked — commit it if you want the pre-split copy kept; git clean would remove it)`,
              ...written.sections.map(
                (section) => `${section.name} ← ${section.blocks} blocks`,
              ),
            ].join("\n"),
          },
        ],
        details: {
          path: indexPath,
          apply: true,
          archivePath,
          sections: written.sections,
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
      "Bind the session mirror to <vault>/<topDir>/<主题>/<主题>.md（无参时弹 picker 选主题；`/md-topic <主题> <章节>` 可切到某章）",
    handler: async (args, ctx) => {
      const trimmedArgs = args.trim();
      let topic = trimmedArgs;
      let section: string | undefined;
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
        section = rest.length > 0 ? rest.join(" ") : undefined;
      }
      const result = bindFromSettings(ctx, topic, section);
      if (result.ok === false) {
        ctx.ui.notify(`Cannot bind topic note: ${result.error}`, "error");
        return;
      }
      const backfilled = await backfill(ctx);
      const state = topicStateFor(result.indexPath, topic.trim());
      const resume = state.resume
        ? ` · 续做：${state.resume.chapter}（${state.resume.reason}）`
        : "";
      ctx.ui.notify(
        `Bound: ${result.file}${backfilled > 0 ? ` (${backfilled} blocks backfilled)` : ""}${resume}`,
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
        const text = messageText(message.content as never);
        if (text) blocks.push(formatAssistantBlock(text));
        continue;
      }
      const toolName = (entry as { message?: { toolName?: string } }).message
        ?.toolName;
      if (message.role === "toolResult" && toolName && QA_TOOLS.has(toolName)) {
        const details = (
          entry as { message?: { details?: QuizDetails | AskDetails } }
        ).message?.details;
        if (details && details.status !== "pending") {
          blocks.push(formatAnswerBlock(details));
        }
      }
    }
    if (blocks.length === 0) return 0;
    await appendBlock(blocks.join("\n\n"));
    return blocks.length;
  }
};
