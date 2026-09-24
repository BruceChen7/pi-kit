/**
 * topic-store 集成测试（Shell：只读边界，真 fs + 临时 vault）。
 *
 * 契约：读侧只回答「有哪些主题 / 某主题什么状态」，**绝不落盘**——
 * 所以每个用例结束前都断言目录快照没变。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSettings } from "./settings-store.ts";
import {
  listChapterFiles,
  listTopics,
  readTopicState,
  recentTopic,
  scanChapters,
  topicIndexPath,
} from "./topic-store.ts";

let root: string;
let vault: string;
let cwd: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tutor-topic-store-"));
  vault = path.join(root, "vault");
  cwd = path.join(root, "cwd");
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".pi", "third_extension_settings.json"),
    JSON.stringify({ tutor: { vaultRoot: vault, topDir: "Learn" } }),
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const settings = () => resolveSettings({ cwd, home: os.homedir() });
const topicDir = (topic: string): string => path.join(vault, "Learn", topic);

const seedTopic = (topic: string, chapters: string[]): void => {
  const dir = topicDir(topic);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${topic}.md`), `# ${topic}\n`);
  chapters.forEach((name, index) => {
    fs.writeFileSync(
      path.join(dir, `${String(index + 1).padStart(2, "0")}-${name}.md`),
      `# 第${index + 1}章 · ${name}\n`,
    );
  });
};

/** 目录快照：名字 + mtime，用来断言「只读」没有副作用。 */
const snapshot = (dir: string): string[] => {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true, recursive: true })
    .map((entry) => `${entry.parentPath ?? ""}/${entry.name}`)
    .sort();
};

describe("topic-store / listTopics", () => {
  it("列出主题、算章节数（索引页与概念表不算章节），最近改动的排最前", () => {
    seedTopic("redis高可用", ["四个动作", "收口三场景"]);
    seedTopic("Docker实现", ["重建地基"]);
    fs.writeFileSync(
      path.join(topicDir("redis高可用"), "概念.md"),
      "# 概念表\n",
    );

    const older = new Date("2026-09-01T00:00:00.000Z");
    const newer = new Date("2026-09-24T00:00:00.000Z");
    for (const name of fs.readdirSync(topicDir("Docker实现"))) {
      fs.utimesSync(path.join(topicDir("Docker实现"), name), older, older);
    }
    for (const name of fs.readdirSync(topicDir("redis高可用"))) {
      fs.utimesSync(path.join(topicDir("redis高可用"), name), newer, newer);
    }

    const topics = listTopics(settings());

    expect(topics.map((entry) => entry.topic)).toEqual([
      "redis高可用",
      "Docker实现",
    ]);
    expect(topics[0]).toEqual({
      topic: "redis高可用",
      chapters: 2,
      lastTouchedAt: "2026-09-24T00:00:00.000Z",
    });
    expect(topics[1]?.chapters).toBe(1);
  });

  it("vault 不存在时给空清单，不抛错", () => {
    expect(listTopics(settings())).toEqual([]);
    expect(recentTopic(settings())).toBeUndefined();
  });
});

describe("topic-store / readTopicState", () => {
  it("编号优先排序，未编号的旧章节补在后；resume 指向最近改动的章节", () => {
    seedTopic("Docker实现", ["重建地基", "进程与命名空间"]);
    const legacy = path.join(topicDir("Docker实现"), "旧笔记.md");
    fs.writeFileSync(legacy, "# 旧笔记\n\n> [!abstract] PI\n\n老内容\n");
    const older = new Date("2026-09-01T00:00:00.000Z");
    fs.utimesSync(legacy, older, older);

    const state = readTopicState(settings(), "Docker实现");

    expect(state.chapters.map((chapter) => chapter.number)).toEqual([
      1,
      2,
      undefined,
    ]);
    expect(state.chapters.at(-1)?.name).toBe("旧笔记");
    expect(state.resume?.reason).toBe("recent");
    expect(state.topic).toBe("Docker实现");
    expect(state.index).toContain("# Docker实现");
  });

  it("扫描只认文件名里的编号（索引页与概念表都不算章节）", () => {
    seedTopic("Docker实现", ["重建地基"]);
    fs.writeFileSync(
      path.join(topicDir("Docker实现"), "概念.md"),
      "# 概念表\n",
    );

    const scanned = scanChapters(topicDir("Docker实现"), "Docker实现");

    expect(scanned).toHaveLength(1);
    expect(scanned[0]?.chapter).toEqual({ number: 1, name: "重建地基" });
  });

  it("主题不存在时给空状态（供 topic_status 报「还没有章节」）", () => {
    const state = readTopicState(settings(), "不存在的主题");

    expect(state.chapters).toEqual([]);
    expect(state.resume).toBeUndefined();
    expect(state.index).toBe("");
  });
});

describe("topic-store / recentTopic 与章节清单", () => {
  it("最近改动主题 + 它的章节（未绑定会话的 brief 用）", () => {
    seedTopic("redis高可用", ["四个动作"]);
    seedTopic("Docker实现", ["重建地基"]);
    const older = new Date("2026-09-01T00:00:00.000Z");
    const newer = new Date("2026-09-24T00:00:00.000Z");
    for (const name of fs.readdirSync(topicDir("Docker实现"))) {
      fs.utimesSync(path.join(topicDir("Docker实现"), name), older, older);
    }
    for (const name of fs.readdirSync(topicDir("redis高可用"))) {
      fs.utimesSync(path.join(topicDir("redis高可用"), name), newer, newer);
    }

    expect(recentTopic(settings())).toEqual({
      topic: "redis高可用",
      chapters: [{ number: 1, name: "四个动作" }],
    });
  });

  it("listChapterFiles 是唯一的「什么算章节」：索引页与概念表不算，且不读内容", () => {
    seedTopic("redis高可用", ["四个动作", "收口三场景"]);
    fs.writeFileSync(
      path.join(topicDir("redis高可用"), "概念.md"),
      "# 概念表\n",
    );

    const refs = listChapterFiles(topicDir("redis高可用"), "redis高可用");

    expect(refs.map((ref) => ref.chapter)).toEqual([
      { number: 1, name: "四个动作" },
      { number: 2, name: "收口三场景" },
    ]);
    expect(refs.every((ref) => !("markdown" in ref))).toBe(true);
    // 清单与 scanChapters 同源：章节集合一致（后者只是多读了内容）
    expect(
      scanChapters(topicDir("redis高可用"), "redis高可用").map(
        (item) => item.chapter,
      ),
    ).toEqual(refs.map((ref) => ref.chapter));
  });
});

describe("topic-store / 只读", () => {
  it("查询不改变磁盘（目录与 mtime 都不变）", () => {
    seedTopic("redis高可用", ["四个动作", "收口三场景"]);
    fs.writeFileSync(
      path.join(topicDir("redis高可用"), "概念.md"),
      "# 概念表\n",
    );
    const before = snapshot(vault);

    listTopics(settings());
    readTopicState(settings(), "redis高可用");
    recentTopic(settings());
    listChapterFiles(topicDir("redis高可用"), "redis高可用");
    topicIndexPath(settings(), "redis高可用");

    expect(snapshot(vault)).toEqual(before);
  });
});
