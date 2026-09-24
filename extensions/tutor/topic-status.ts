/**
 * topic-status — 「本会话在哪个主题、这个主题现在什么状态」的只读出口（Imperative Shell）。
 *
 * 两个入口，都只读：
 * - `topic_status` 工具：agent 随时可以查状态（不落盘、不改索引、不建目录）。
 * - 每会话一次的首轮注入（`before_agent_start` 返回 display:false 的自定义消息）：
 *   把状态直接塞进上下文，省掉「ls / cat 考古」那一轮——这正是 2026-09-24
 *   那次会话烧掉 45 次 bash 的地方。
 *
 * 它只回答状态，**不回答「该绑哪儿」**：落点由学习者在 picker 里选
 * （见 notes-store 的 `resolvePlacement`）。
 */

import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { conceptLineFor } from "./concepts-store.ts";
import { detectTutorSkill } from "./mode-core.ts";
import { TOPIC_STATUS_TOOL_NAME } from "./names.ts";
import {
  type ChapterState,
  chapterLabel,
  formatTopicBrief,
  formatTopicCatalog,
  formatTopicList,
  isVaultNotePath,
  parseChapterFileName,
  parseChapterRef,
  readBoundNote,
  type TopicState,
  type TutorSettings,
  topicOfNotePath,
  vaultDirOf,
} from "./notes-core.ts";
import { resolveSettings } from "./settings-store.ts";
import {
  listTopics,
  readTopicState,
  recentTopic,
  topicIndexPath,
} from "./topic-store.ts";

/** 会话条目类型：本会话已经注入过首轮简报。 */
const BRIEF_ENTRY_TYPE = "tutor-brief";

export const registerTopicStatus = (pi: ExtensionAPI): void => {
  const settingsFor = (ctx: ExtensionContext): TutorSettings =>
    resolveSettings({ cwd: ctx.cwd });

  /** 只在教学内容区（`<vaultRoot>/<topDir>/`）里的绑定才算本会话的主题。 */
  const boundNoteOf = (ctx: ExtensionContext): string | null => {
    const file = readBoundNote(ctx.sessionManager.getEntries());
    if (!file) return null;
    const vaultDir = vaultDirOf(settingsFor(ctx));
    return isVaultNotePath(file, vaultDir) ? file : null;
  };

  const unnumberedOf = (chapters: ChapterState[]): string[] =>
    chapters
      .filter((chapter) => chapter.number === undefined)
      .map((chapter) => chapter.name);

  const briefForTopic = (
    settings: TutorSettings,
    topic: string,
    notePath?: string,
    preloaded?: TopicState,
  ): string => {
    const state = preloaded ?? readTopicState(settings, topic);
    return formatTopicBrief({
      topic,
      indexPath: topicIndexPath(settings, topic),
      chapters: state.chapters,
      resume: state.resume,
      notePath,
      conceptLine: conceptLineFor(settings, topic),
      unnumbered: unnumberedOf(state.chapters),
    });
  };

  /** 绑定文件的章节标签：`07-名字.md` → `第7章 · 名字`；索引页则明说。 */
  const boundLabelOf = (bound: string, topic: string): string => {
    const base = path.basename(bound, ".md");
    if (base === topic) return "主题索引页";
    const { number, name } = parseChapterFileName(base);
    return chapterLabel(number, name);
  };

  const catalogFor = (settings: TutorSettings, header: string): string => {
    const recent = recentTopic(settings);
    return [
      header,
      formatTopicCatalog({
        topics: listTopics(settings),
        recent,
      }),
    ].join("\n");
  };

  // ── 首轮注入：每会话一次（resume 不重复） ────────────────────────────────
  let injected = false;

  pi.on("session_start", async (_event, ctx) => {
    // 分支敏感的判定：只看本条分支的条目（`getBranch` 语义）。
    injected = ctx.sessionManager
      .getEntries()
      .some(
        (entry) =>
          entry.type === "custom" &&
          (entry as { customType?: string }).customType === BRIEF_ENTRY_TYPE,
      );
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (injected) return;
    const bound = boundNoteOf(ctx);
    const skill = detectTutorSkill(event.prompt);
    if (bound === null && !skill) return;

    injected = true;
    pi.appendEntry(BRIEF_ENTRY_TYPE, { at: new Date().toISOString() });

    const settings = settingsFor(ctx);
    if (bound !== null) {
      const topic = topicOfNotePath(bound);
      const content =
        topic === null
          ? catalogFor(settings, `[tutor] 本会话绑定的文件：${bound}`)
          : [
              `[tutor] 本会话已绑定《${topic}》· ${boundLabelOf(bound, topic)}`,
              briefForTopic(settings, topic, bound),
            ].join("\n");
      return {
        message: {
          customType: BRIEF_ENTRY_TYPE,
          content,
          display: false,
        },
      };
    }
    return {
      message: {
        customType: BRIEF_ENTRY_TYPE,
        content: catalogFor(
          settings,
          "[tutor] 本会话未绑定笔记（下面这次是教学请求）",
        ),
        display: false,
      },
    };
  });

  // ── 只读工具 ────────────────────────────────────────────────────────────
  pi.registerTool({
    name: TOPIC_STATUS_TOOL_NAME,
    label: "Topic Status",
    description:
      "READ-ONLY view of the notes vault for this teaching session: which topic the session is bound to, every topic with its chapter count, a topic's chapters with their quiz tallies, the chapter to resume from, the concept gaps and the index path. " +
      "It never writes anything and never decides where a lesson goes — the learner picks topic and chapter in the bind picker. " +
      "Call it whenever you need to know the state instead of exploring the vault with ls/cat.",
    parameters: Type.Object({
      topic: Type.Optional(
        Type.String({
          description:
            "Topic name to inspect. Omit to get the vault overview plus this session's binding.",
        }),
      ),
      chapter: Type.Optional(
        Type.String({
          description:
            "Optional chapter inside `topic` to focus on (`第3章`, `03-名字` or the plain name). Only looks the chapter up in that topic — it does not guess which topic a name belongs to.",
        }),
      ),
    }),
    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      ctx: ExtensionContext,
    ) {
      const settings = settingsFor(ctx);
      const bound = boundNoteOf(ctx);

      if (!params.topic) {
        const topics = listTopics(settings);
        const lines: string[] = [
          bound
            ? `本会话绑定：${bound}`
            : "本会话还没有绑定笔记（bind_notes 会弹 picker，由学习者选落点）。",
          formatTopicList(topics),
        ];
        const boundTopic = bound ? topicOfNotePath(bound) : null;
        if (boundTopic) lines.push(briefForTopic(settings, boundTopic, bound));
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: { bound, topics },
          isError: false,
        };
      }

      const topic = params.topic.trim();
      const state = readTopicState(settings, topic);
      const brief = briefForTopic(settings, topic, undefined, state);
      if (!params.chapter) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `《${topic}》${
                  state.chapters.length === 0
                    ? "（还没有章节）"
                    : `共 ${state.chapters.length} 章`
                }`,
                brief,
              ].join("\n"),
            },
          ],
          details: {
            topic,
            index: state.index,
            chapters: state.chapters,
            resume: state.resume ?? null,
          },
          isError: false,
        };
      }

      const ref = parseChapterRef(params.chapter);
      const chapter = state.chapters.find(
        (item) =>
          (ref.number !== undefined && item.number === ref.number) ||
          (ref.name !== undefined && item.name === ref.name),
      );
      if (!chapter) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `《${topic}》里没有「${params.chapter}」这一章（不做近似匹配）。`,
                state.chapters.length === 0
                  ? "这个主题还没有章节。"
                  : `现有章节：${state.chapters
                      .map((item) => chapterLabel(item.number, item.name))
                      .join("；")}`,
                "要新建一章就让学习者在 picker 里选「＋ 新建章节…」。",
              ].join("\n"),
            },
          ],
          details: { topic, chapter: null, chapters: state.chapters },
          isError: false,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `当前章节：${chapterLabel(chapter.number, chapter.name)}`,
              `文件：${chapter.path}`,
              brief,
            ].join("\n"),
          },
        ],
        details: {
          topic,
          chapter: chapter.name,
          chapterNumber: chapter.number ?? null,
          path: chapter.path,
          chapters: state.chapters,
          resume: state.resume ?? null,
        },
        isError: false,
      };
    },
  });
};
