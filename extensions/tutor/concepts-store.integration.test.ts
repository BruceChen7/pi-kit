/**
 * concepts 落盘的集成测试：直接打到真实文件系统（临时目录），验证
 * 每个主题一份概念表、跨主题只留一个家、机器块重写、条目只增不改、
 * 两个 check 模式，以及「概念表不是章节」这个不变量。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONCEPTS_FILE_NAME } from "./concepts-core.ts";
import {
  type ConceptSettings,
  checkConcepts,
  describeConcepts,
  loadRegistries,
  loadRegistry,
  type NoteConceptParams,
  noteConcept,
  registryPath,
  scanTopicChapters,
  topicDir,
} from "./concepts-store.ts";
import { parseChapterFileName } from "./notes-core.ts";
import { scanChapters } from "./notes-store.ts";

let vault: string;
let settings: ConceptSettings;

const TOPIC = "MySQL的ACID实现";
const OTHER = "Docker实现";

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "tutor-concepts-"));
  settings = { vaultRoot: vault, topDir: "Learn", warnings: [] };
});

afterEach(() => {
  fs.rmSync(vault, { recursive: true, force: true });
});

const chapter = (name: string, markdown: string, topic = TOPIC): void => {
  const dir = topicDir(settings, topic);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), markdown, "utf-8");
};

const register = (params: Partial<NoteConceptParams> & { name: string }) =>
  noteConcept(settings, { topic: TOPIC, ...params }, "2026-09-22");

const registerIn = (
  topic: string,
  params: Partial<NoteConceptParams> & { name: string },
) => noteConcept(settings, { topic, ...params }, "2026-09-22");

const table = (topic: string): string => registryPath(settings, topic);

describe("concepts IO / 每个主题一份表", () => {
  it("creates the topic's own 概念.md on first note_concept", () => {
    expect(fs.existsSync(table(TOPIC))).toBe(false);

    const result = register({
      name: "Read View",
      definition: "事务第一次快照读时拍下的活跃事务名单。",
      why: "没有它说不清「同一事务两次 SELECT 看到同一套行」。",
      requires: ["undo 版本链"],
      chapter: 4,
      source: "trx0read.cc",
    });
    expect(result.isError).toBe(false);
    expect(result.details.created).toBe(true);
    expect(result.details.path).toBe(table(TOPIC));
    expect(result.details.home).toBe(TOPIC);

    const text = fs.readFileSync(table(TOPIC), "utf-8");
    expect(text).toContain("# 概念表 · MySQL的ACID实现");
    expect(text).toContain("## 概念");
    expect(text).toContain(
      "- [[#Read View|Read View]] · 待验证 · 首次：MySQL的ACID实现 第4章",
    );
    expect(text).toContain("## 术语");
    expect(text).toContain("### Read View");
    expect(text).toContain(
      "- 一句话定义：事务第一次快照读时拍下的活跃事务名单。",
    );
    expect(text).toContain("- 前置：[[#undo 版本链|undo 版本链]]");
    expect(text).toContain("- 出处：trx0read.cc");
    expect(text).toContain("- 首次：MySQL的ACID实现 · 第4章 · 2026-09-22");
    expect(result.content[0].text).toContain(
      "⚠️ 前置未确立：undo 版本链（未登记）",
    );
    // 不再有 vault 级的总表。
    expect(fs.existsSync(path.join(vault, "Learn", CONCEPTS_FILE_NAME))).toBe(
      false,
    );
  });

  it("refuses a new concept without a definition and writes nothing", () => {
    const result = register({ name: "mtr" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("definition");
    expect(fs.existsSync(table(TOPIC))).toBe(false);
  });

  it("updates status in place without duplicating the entry", () => {
    register({ name: "Read View", definition: "旧定义", chapter: 4 });
    const before = fs.readFileSync(table(TOPIC), "utf-8");

    const result = register({
      name: "Read View",
      status: "已确立",
      evidence: "quiz 第2题答对",
    });
    expect(result.isError).toBe(false);
    expect(result.details.changed).toContain("状态 待验证→已确立");

    const text = fs.readFileSync(table(TOPIC), "utf-8");
    expect(text.match(/### Read View/g)).toHaveLength(1);
    expect(text).toContain(
      "- [[#Read View|Read View]] · 已确立 · 首次：MySQL的ACID实现 第4章",
    );
    expect(text).toContain("- 依据：quiz 第2题答对");
    // 只增不改：上一次写下的定义一字不动。
    expect(before).toContain("- 一句话定义：旧定义");
    expect(text).toContain("- 一句话定义：旧定义");
  });

  it("keeps the previous definition as an appended revision", () => {
    register({ name: "Read View", definition: "旧定义" });
    register({ name: "Read View", definition: "新定义" });
    const text = fs.readFileSync(table(TOPIC), "utf-8");
    expect(text).toContain("- 一句话定义：新定义");
    expect(text).toContain("> [!note] 修订 2026-09-22");
    expect(text).toContain("> 定义更新（旧）：旧定义");
  });

  it("keeps two concepts of the same topic in one file, sorted in the block", () => {
    register({ name: "Read View", definition: "定义", chapter: 4 });
    register({ name: "mtr", definition: "写入单位", chapter: 7 });
    const registry = loadRegistry(settings, TOPIC);
    expect(registry.topic).toBe(TOPIC);
    expect(registry.concepts.map((concept) => concept.name)).toEqual([
      "Read View",
      "mtr",
    ]);
    const text = fs.readFileSync(table(TOPIC), "utf-8");
    expect(text.indexOf("### Read View")).toBeLessThan(text.indexOf("### mtr"));
    expect(text).toContain("- [[#Read View|Read View]] · 待验证");
    expect(text).toContain("- [[#mtr|mtr]] · 待验证");
  });
});

describe("concepts IO / 一个概念一个家", () => {
  it("writes the status back to the home table instead of duplicating", () => {
    registerIn(OTHER, {
      name: "next-key lock",
      definition: "gap lock + record lock 的组合。",
      chapter: 8,
      status: "已确立",
    });
    registerIn(TOPIC, {
      name: "next-key lock",
      definition: "gap lock + record lock 的组合。",
      chapter: 4,
      status: "缺口",
      evidence: "本主题的 quiz 答错",
    });

    // 只在 Docker 那份表里有一条；ACID 那边没有第二个条目。
    expect(
      loadRegistry(settings, OTHER).concepts.map((concept) => concept.name),
    ).toEqual(["next-key lock"]);
    expect(fs.existsSync(table(TOPIC))).toBe(false);

    const registries = loadRegistries(settings);
    expect(registries.homes).toHaveLength(1);
    expect(registries.homes[0].topic).toBe(OTHER);
    expect(registries.homes[0].concept.status).toBe("缺口");
    expect(registries.homes[0].concept.evidence).toBe("本主题的 quiz 答错");
  });

  it("tells the caller where the concept lives, with a path link to use", () => {
    registerIn(OTHER, {
      name: "next-key lock",
      definition: "gap lock + record lock 的组合。",
      chapter: 8,
    });
    const result = registerIn(TOPIC, {
      name: "next-key lock",
      chapter: 4,
    });
    expect(result.isError).toBe(false);
    expect(result.details.home).toBe(OTHER);
    expect(result.content[0].text).toContain("家在《Docker实现》");
    expect(result.content[0].text).toContain(
      "[[Docker实现/概念#next-key lock|next-key lock]]",
    );
  });

  it("renders a cross-topic prerequisite as a path link", () => {
    registerIn(OTHER, {
      name: "Read View",
      definition: "活跃事务名单。",
      chapter: 4,
      status: "已确立",
    });
    registerIn(TOPIC, {
      name: "当前读",
      definition: "加锁的读。",
      requires: ["Read View"],
      chapter: 4,
    });
    const text = fs.readFileSync(table(TOPIC), "utf-8");
    expect(text).toContain("- 前置：[[Docker实现/概念#Read View|Read View]]");
    // 解析回来还是「Read View」这个名字（不是整串 wikilink）。
    expect(loadRegistry(settings, TOPIC).concepts[0].requires).toEqual([
      "Read View",
    ]);
  });

  it("rejects a topic whose name collides with the concept table", () => {
    const result = registerIn("概念", { name: "X", definition: "定义" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("collides");
  });
});

describe("concepts / check_concepts", () => {
  it("classifies the terms of a node before teaching (union of all tables)", () => {
    register({
      name: "Read View",
      definition: "定义",
      chapter: 4,
      status: "已确立",
    });
    registerIn(OTHER, {
      name: "mtr",
      definition: "定义",
      chapter: 3,
      status: "已确立",
    });

    const result = checkConcepts(settings, {
      terms: ["Read View", "mtr", "purge"],
    });
    expect(result.isError).toBe(false);
    const text = result.content[0].text;
    expect(text).toContain("概念检查（3 个术语）");
    expect(text).toContain("已确立（2）：Read View");
    expect(text).toContain("mtr");
    expect(text).toContain("未登记（1）：purge");
    expect(text).toContain("分居 2 份");
    expect(result.details.topics).toEqual(["Docker实现", "MySQL的ACID实现"]);
  });

  it("sweeps one chapter and reports jargon never registered", () => {
    chapter(
      "08-幻读辨析.md",
      [
        "# 第8章 · 幻读辨析",
        "",
        "**Read View** 是快照读的基础，`mtr` 是写入单位。",
        "",
        "再说一次：**Read View** 不变，`mtr` 也一样。",
        "",
        "「快照读」与「当前读」是两种读；当前读读最新版本。",
        "",
        "看 `btr_cur_upd_lock_and_undo` 与 `row0upd.cc:2988`。",
      ].join("\n"),
    );
    register({
      name: "Read View",
      definition: "定义",
      chapter: 4,
      status: "已确立",
    });

    const byNumber = checkConcepts(settings, {
      topic: TOPIC,
      chapter: "第8章",
    });
    expect(byNumber.isError).toBe(false);
    expect(byNumber.details.chapters).toEqual(["幻读辨析"]);
    expect(byNumber.details.unregistered).toEqual(["mtr", "当前读", "快照读"]);
    expect(byNumber.details.established).toEqual(["Read View"]);
    expect(byNumber.details.skipped).toContain("row0upd.cc:2988");
    expect(byNumber.content[0].text).toContain(
      "《MySQL的ACID实现》第8章 · 幻读辨析",
    );
    expect(byNumber.content[0].text).toContain(`本主题概念表：${table(TOPIC)}`);

    // 三种引用写法都落到同一章。
    for (const ref of ["08-幻读辨析", "幻读辨析"]) {
      const result = checkConcepts(settings, { topic: TOPIC, chapter: ref });
      expect(result.details.chapters, ref).toEqual(["幻读辨析"]);
    }
  });

  it("sweeps every chapter when no chapter is given (backfill mode)", () => {
    chapter("01-实现地图.md", "用 `mtr` 说明 WAL。\n\n`mtr` 是写入单位。");
    chapter("02-原子性与undo.md", "「快照读」看 undo 版本链。");
    const result = checkConcepts(settings, { topic: TOPIC });
    expect(result.content[0].text).toContain("全部 2 章");
    expect(result.details.chapters).toEqual(["实现地图", "原子性与undo"]);
  });

  it("explains itself when the mode is ambiguous or the topic is unknown", () => {
    expect(checkConcepts(settings, {}).isError).toBe(true);
    const both = checkConcepts(settings, { terms: ["a"], topic: TOPIC });
    expect(both.isError).toBe(true);
    expect(both.content[0].text).toContain("not both");
    const missing = checkConcepts(settings, { topic: "不存在的主题" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("no chapter files");

    chapter("01-实现地图.md", "内容");
    const badRef = checkConcepts(settings, { topic: TOPIC, chapter: "第9章" });
    expect(badRef.isError).toBe(true);
    expect(badRef.content[0].text).toContain("第1章 · 实现地图");
  });
});

describe("concepts / 不变量", () => {
  it("lives inside the topic dir but is not a chapter", () => {
    register({ name: "Read View", definition: "定义", chapter: 4 });
    chapter("01-实现地图.md", "# 第1章 · 实现地图\n");
    chapter("02-原子性与undo.md", "# 第2章 · 原子性与undo\n");

    const registry = table(TOPIC);
    expect(path.basename(registry)).toBe(CONCEPTS_FILE_NAME);
    expect(path.dirname(registry)).toBe(topicDir(settings, TOPIC));
    expect(fs.statSync(registry).isFile()).toBe(true);

    // 三处扫描都要跳过它：章节清单、编号、主题 picker 的「N 章」计数。
    const chapters = scanTopicChapters(settings, TOPIC);
    expect(chapters.map((item) => item.name)).toEqual([
      "实现地图",
      "原子性与undo",
    ]);
    expect(scanChapters(topicDir(settings, TOPIC), TOPIC)).toHaveLength(2);
    expect(chapters.map((item) => item.number)).toEqual([1, 2]);
    expect(
      chapters.map(
        (item) => parseChapterFileName(path.basename(item.file, ".md")).number,
      ),
    ).toEqual([1, 2]);

    // picker 的计数口径 = 目录里除索引页与概念表之外的 .md。
    const counted = fs
      .readdirSync(topicDir(settings, TOPIC), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".md") &&
          entry.name !== `${TOPIC}.md` &&
          entry.name !== CONCEPTS_FILE_NAME,
      );
    expect(counted).toHaveLength(2);
  });

  it("answers /concepts per topic and looks terms up across tables", () => {
    expect(describeConcepts(settings, "").text).toContain("概念表还没建");

    registerIn(TOPIC, {
      name: "Read View",
      definition: "活跃事务名单",
      chapter: 4,
      aliases: ["RV"],
    });
    registerIn(OTHER, {
      name: "mtr",
      definition: "写入单位",
      chapter: 3,
      status: "缺口",
    });

    const summary = describeConcepts(settings, "");
    expect(summary.level).toBe("info");
    expect(summary.text).toContain("概念表共 2 条");
    expect(summary.text).toContain("MySQL的ACID实现：1 条");
    expect(summary.text).toContain(
      "Docker实现：1 条（已确立 0 / 待验证 0）｜缺口 mtr",
    );

    const one = describeConcepts(settings, "rv");
    expect(one.text).toContain("Read View（待验证｜家在 MySQL的ACID实现）");
    expect(one.text).toContain("活跃事务名单");

    const missing = describeConcepts(settings, "purge");
    expect(missing.level).toBe("warning");
    expect(missing.text).toContain("未登记");
  });
});
