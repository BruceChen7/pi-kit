/**
 * notes 落盘的集成测试：直接打到真实文件系统（临时目录），验证
 * 建目录/建文件、只追加、问题块先于答案块、以及 /md-log 的"不造文件"语义。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chapterNotePath,
  formatQuestionBlock,
  formatQuizAnswerBlock,
  parseNoteBlocks,
  planSplit,
  topicNotePath,
} from "./notes-core.ts";
import {
  appendIndexEntryOnce,
  appendToNote,
  applyTopicSplit,
  checkExistingFile,
  ensureSectionNote,
  ensureTopicNote,
} from "./notes-store.ts";

let vault: string;
let note: string;

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "tutor-notes-"));
  note = topicNotePath({
    vaultRoot: vault,
    topDir: "Learn",
    topic: "分布式共识",
  });
});

afterEach(() => {
  fs.rmSync(vault, { recursive: true, force: true });
});

describe("notes IO", () => {
  it("creates the topic directory and file on first bind", () => {
    expect(fs.existsSync(note)).toBe(false);
    expect(ensureTopicNote(note)).toEqual({ created: true });
    expect(fs.existsSync(note)).toBe(true);
    expect(fs.readFileSync(note, "utf-8")).toContain("# 分布式共识");
  });

  it("does not overwrite an existing note on a second bind", () => {
    ensureTopicNote(note);
    appendToNote(note, "> [!abstract] PI\n\n第一次课");
    const before = fs.readFileSync(note, "utf-8");

    expect(ensureTopicNote(note)).toEqual({ created: false });
    expect(fs.readFileSync(note, "utf-8")).toBe(before);
  });

  it("appends without rewriting earlier content, separated by a blank line", () => {
    ensureTopicNote(note);
    appendToNote(note, "块一");
    appendToNote(note, "块二");
    const text = fs.readFileSync(note, "utf-8");
    expect(text).toContain("块一\n\n块二\n");
    expect(text.indexOf("块一")).toBeLessThan(text.indexOf("块二"));
  });

  it("keeps the question block before the answer block in the same note", () => {
    ensureTopicNote(note);
    appendToNote(
      note,
      formatQuestionBlock({
        kind: "Quiz",
        question: "哪个行星最热？",
        options: [
          { index: 1, label: "Mercury" },
          { index: 2, label: "Venus" },
        ],
      }),
    );
    appendToNote(
      note,
      formatQuizAnswerBlock({
        status: "answered",
        question: "哪个行星最热？",
        mode: "single-select",
        options: [
          { index: 1, label: "Mercury" },
          { index: 2, label: "Venus" },
        ],
        answers: [{ index: 2, label: "Venus", value: "venus" }],
        correctValues: ["venus"],
        correctIndices: [2],
        isCorrect: true,
        explanation: "金星大气最厚。",
        message: "ok",
      }),
    );

    const text = fs.readFileSync(note, "utf-8");
    expect(text.indexOf("> [!question] Quiz")).toBeGreaterThan(-1);
    expect(text.indexOf("> [!question] Quiz")).toBeLessThan(
      text.indexOf("> [!success]"),
    );
    // 问题块先出现，答案块在其后；答案块才有解释。
    const [, afterQuestion] = text.split("> [!question] Quiz");
    expect(afterQuestion).toContain("金星大气最厚。");
  });

  it("refuses a /md-log style path that does not exist and never creates it", () => {
    const missing = path.join(vault, "nope", "typo.md");
    const check = checkExistingFile(missing);
    expect(check.ok).toBe(false);
    expect(fs.existsSync(missing)).toBe(false);
    expect(fs.existsSync(path.dirname(missing))).toBe(false);
  });

  it("accepts /md-log style paths that already exist", () => {
    ensureTopicNote(note);
    expect(checkExistingFile(note)).toEqual({ ok: true });
  });
});

const chapterMarkdown = [
  "# Docker 实现",
  "",
  "> 由 tutor 维持：每次教学按时间顺序追加，只增不改。",
  "",
  "> [!abstract] PI",
  "",
  "先看内核视角。",
  "",
  "> [!question] Quiz",
  "",
  "容器里的进程是什么？",
  "",
  "1. 一个 VM",
  "2. 一个普通进程",
  "",
  "> [!success] Quiz — correct ✓",
  "",
  "对。",
  "",
  "> [!question] Quiz",
  "",
  "1 号进程死了会怎样？",
].join("\n");

describe("sections IO", () => {
  it("creates a section file with its own header and never overwrites it", () => {
    const file = chapterNotePath({
      vaultRoot: vault,
      topDir: "Learn",
      topic: "Docker 实现",
      section: "进程与隔离",
    });
    expect(ensureSectionNote(file, "Docker 实现", "进程与隔离")).toEqual({
      created: true,
    });
    expect(fs.readFileSync(file, "utf-8")).toContain("《Docker 实现》的一章");
    appendToNote(file, "课文一");
    const before = fs.readFileSync(file, "utf-8");
    expect(ensureSectionNote(file, "Docker 实现", "进程与隔离")).toEqual({
      created: false,
    });
    expect(fs.readFileSync(file, "utf-8")).toBe(before);
  });

  it("appends an index entry exactly once", () => {
    const index = topicNotePath({
      vaultRoot: vault,
      topDir: "Learn",
      topic: "Docker 实现",
    });
    expect(fs.existsSync(index)).toBe(false);
    expect(appendIndexEntryOnce(index, "进程与隔离", "2026-09-18")).toEqual({
      appended: true,
    });
    const after = fs.readFileSync(index, "utf-8");
    expect(after).toContain("- [[进程与隔离]] · 2026-09-18");
    expect(appendIndexEntryOnce(index, "进程与隔离", "2026-09-18")).toEqual({
      appended: false,
    });
    expect(fs.readFileSync(index, "utf-8")).toBe(after);
  });
});

describe("applyTopicSplit", () => {
  const chapterPathOf = (section: string): string =>
    chapterNotePath({
      vaultRoot: vault,
      topDir: "Learn",
      topic: "Docker 实现",
      section,
    });

  const prepare = (): { index: string; original: string } => {
    const index = topicNotePath({
      vaultRoot: vault,
      topDir: "Learn",
      topic: "Docker 实现",
    });
    fs.mkdirSync(path.dirname(index), { recursive: true });
    fs.writeFileSync(index, chapterMarkdown, "utf-8");
    return { index, original: fs.readFileSync(index, "utf-8") };
  };

  it("archives the original byte-for-byte, writes chapters and keeps the index prefix", () => {
    const { index, original } = prepare();
    const plan = planSplit({
      markdown: original,
      sections: [{ name: "进程与隔离", blockIndexes: [2, 3] }],
    });
    if (plan.ok === false) throw new Error(plan.error);

    const result = applyTopicSplit({
      indexPath: index,
      topic: "Docker 实现",
      date: "2026-09-18",
      plan,
      chapterPathOf,
    });
    expect(result.ok).toBe(true);
    if (result.ok === false) return;

    // 1) 归档逐字节一致
    expect(fs.readFileSync(result.archivePath, "utf-8")).toBe(original);
    // 2) 章节文件含被分配的块（逐字）
    const section = fs.readFileSync(chapterPathOf("进程与隔离"), "utf-8");
    expect(section).toContain("> [!question] Quiz");
    expect(section).toContain("> [!success] Quiz — correct ✓");
    expect(section).not.toContain("1 号进程死了会怎样？");
    // 3) 索引：标题区 + provenance（内含章节行）+ 未归属块
    const after = fs.readFileSync(index, "utf-8");
    expect(after).toContain("已拆分为 [[进程与隔离]]");
    expect(after).toContain("> - [[进程与隔离]] · 2026-09-18");
    expect(after).toContain("# Docker 实现");
    expect(after).toContain("1 号进程死了会怎样？");
    expect(after).not.toContain("> [!success] Quiz — correct ✓");
  });

  it("conserves every block exactly once", () => {
    const { index, original } = prepare();
    const plan = planSplit({
      markdown: original,
      sections: [{ name: "A", blockIndexes: [1, 2] }],
    });
    if (plan.ok === false) throw new Error(plan.error);
    const result = applyTopicSplit({
      indexPath: index,
      topic: "Docker 实现",
      date: "2026-09-18",
      plan,
      chapterPathOf,
    });
    if (result.ok === false) throw new Error(result.error);

    const before = parseNoteBlocks(original)
      .map((block) => block.text)
      .sort();
    const after = [
      ...parseNoteBlocks(fs.readFileSync(index, "utf-8")).map(
        (block) => block.text,
      ),
      ...parseNoteBlocks(fs.readFileSync(chapterPathOf("A"), "utf-8")).map(
        (block) => block.text,
      ),
    ]
      // 拆分新增的 provenance 块（含其中的章节行）不算“原块”，其余必须逐字守恒
      .filter((text) => !text.includes("已拆分为"))
      .sort();
    expect(after).toEqual(before);
  });

  it("refuses to overwrite an existing chapter file", () => {
    const { index, original } = prepare();
    fs.writeFileSync(chapterPathOf("A"), "已存在的章节", "utf-8");
    const plan = planSplit({
      markdown: original,
      sections: [{ name: "A", blockIndexes: [1] }],
    });
    if (plan.ok === false) throw new Error(plan.error);
    const result = applyTopicSplit({
      indexPath: index,
      topic: "Docker 实现",
      date: "2026-09-18",
      plan,
      chapterPathOf,
    });
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(index, "utf-8")).toBe(original); // 索引没被改
    expect(fs.readFileSync(chapterPathOf("A"), "utf-8")).toBe("已存在的章节");
    expect(
      fs.existsSync(path.join(vault, "Learn", "Docker 实现", "_archive")),
    ).toBe(false);
  });
});
