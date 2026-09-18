/**
 * notes 落盘的集成测试：直接打到真实文件系统（临时目录），验证
 * 建目录/建文件、只追加、问题块先于答案块、以及 /md-log 的"不造文件"语义。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatQuestionBlock,
  formatQuizAnswerBlock,
  topicNotePath,
} from "./notes-core.ts";
import {
  appendToNote,
  checkExistingFile,
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
