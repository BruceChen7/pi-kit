/**
 * topic-store — vault 的**只读**边界（Imperative Shell）。
 *
 * 读写分工：写路径（建目录、建章节、改索引、镜像追加）只在 notes-store；
 * 本模块只回答两个问题，绝不落盘：
 *
 * - 「vault 里有哪些主题、每个主题有哪些章节？」
 * - 「某个主题现在的状态是什么？」（章节 + 测验计数 + 续做点）
 *
 * 数据形状与格式化全在 notes-core（纯）；这里只做 fs 读取与 DTO 拼装。
 * 依赖方向：notes-store / topic-status → topic-store → { concepts-core（概念表谓词）, notes-core }
 * （无环）。概念缺口行住在 concepts-store（与概念表同一处），这里不再依赖它。
 */

import fs from "node:fs";
import path from "node:path";
import { isConceptTableName } from "./concepts-core.ts";
import {
  buildTopicState,
  type ChapterFile,
  type ChapterState,
  parseChapterFileName,
  parseIndexEntries,
  proposeChapterOrder,
  summarizeChapter,
  type TopicState,
  type TopicSummary,
  type TutorSettings,
  topicDirPath,
  topicNotePath,
  vaultDirOf,
} from "./notes-core.ts";

export const topicIndexPath = (
  settings: TutorSettings,
  topic: string,
): string =>
  topicNotePath({
    vaultRoot: settings.vaultRoot,
    topDir: settings.topDir,
    topic: topic.trim(),
  });

/** 章节文件（不读内容）：文件名就是编号的权威来源。 */
export type ChapterFileRef = {
  chapter: ChapterFile;
  file: string;
  touchedAt: string;
};

/**
 * 一个目录里算作「章节」的文件：`*.md`，排除主题索引页与概念表。
 * **这是唯一的章节文件判定**——`listTopics` 的计数与 `scanChapters` 都走它。
 */
export const listChapterFiles = (
  dir: string,
  topic: string,
): ChapterFileRef[] => {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".md") &&
        entry.name !== `${topic}.md` &&
        !isConceptTableName(entry.name),
    )
    .map((entry) => {
      const file = path.join(dir, entry.name);
      const { number, name } = parseChapterFileName(
        entry.name.replace(/\.md$/, ""),
      );
      return {
        chapter: { number, name },
        file,
        touchedAt: new Date(fs.statSync(file).mtimeMs).toISOString(),
      };
    });
};

export type ScannedChapter = ChapterFileRef & { markdown: string };

/** 章节清单 + 内容（读侧状态与镜像共用）。 */
export const scanChapters = (dir: string, topic: string): ScannedChapter[] =>
  listChapterFiles(dir, topic).map((ref) => ({
    ...ref,
    markdown: fs.readFileSync(ref.file, "utf-8"),
  }));

/** 从 vault 推导主题状态：编号优先，未编号的按索引顺序、再按 mtime 补在后。 */
export const readTopicState = (
  settings: TutorSettings,
  topic: string,
): TopicState => {
  const indexPath = topicIndexPath(settings, topic);
  const index = fs.existsSync(indexPath)
    ? fs.readFileSync(indexPath, "utf-8")
    : "";
  const scanned = scanChapters(
    topicDirPath({ ...settings, topic }),
    topic.trim(),
  );
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
  return buildTopicState({ topic: topic.trim(), index, chapters: ordered });
};

/** `Learn/` 下已有主题概览（picker 与 topic_status 共用；最近改动的排最前）。 */
export const listTopics = (settings: TutorSettings): TopicSummary[] => {
  const root = vaultDirOf(settings);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "_archive")
    .map((entry) => {
      // 章节数走 listChapterFiles：与 readTopicState / 镜像同一套「什么算章节」。
      const chapters = listChapterFiles(
        path.join(root, entry.name),
        entry.name,
      );
      // 索引页也算「最近改动」：它随章节一起被改写，但不算一章。
      const index = topicIndexPath(settings, entry.name);
      const indexTouchedAt = fs.existsSync(index)
        ? fs.statSync(index).mtimeMs
        : 0;
      const newest = chapters.reduce(
        (acc, item) => Math.max(acc, Date.parse(item.touchedAt)),
        indexTouchedAt,
      );
      return {
        topic: entry.name,
        chapters: chapters.length,
        lastTouchedAt: newest > 0 ? new Date(newest).toISOString() : null,
      };
    })
    .sort((a, b) =>
      (b.lastTouchedAt ?? "").localeCompare(a.lastTouchedAt ?? ""),
    );
};

/** 最近改动的主题 + 它的章节（未绑定会话的 brief 用；纯事实，不做「应该绑哪儿」的推断）。 */
export const recentTopic = (
  settings: TutorSettings,
): { topic: string; chapters: ChapterFile[] } | undefined => {
  const [first] = listTopics(settings);
  if (!first) return undefined;
  return {
    topic: first.topic,
    chapters: listChapterFiles(
      topicDirPath({ ...settings, topic: first.topic }),
      first.topic,
    ).map((item) => item.chapter),
  };
};
