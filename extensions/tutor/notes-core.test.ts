import { describe, expect, it } from "vitest";
import type { AskDetails } from "./ask-core.ts";
import {
  expandHome,
  formatAskAnswerBlock,
  formatQuestionBlock,
  formatQuizAnswerBlock,
  formatTopicHeader,
  isValidTopic,
  messageText,
  resolveTutorSettings,
  stripSkillBlocks,
  TOPIC_REJECTION_REASONS,
  topicNotePath,
} from "./notes-core.ts";
import type { QuizDetails } from "./quiz-core.ts";

describe("notes-core / topic validation", () => {
  it("accepts Chinese topics and trims surrounding space", () => {
    expect(isValidTopic("  分布式共识  ")).toEqual({
      ok: true,
      topic: "分布式共识",
    });
  });

  it("rejects empty, separator, parent and NUL topics", () => {
    expect(isValidTopic("   ")).toEqual({ ok: false, reason: "empty" });
    expect(isValidTopic("a/b")).toEqual({ ok: false, reason: "separator" });
    expect(isValidTopic("a\\b")).toEqual({ ok: false, reason: "separator" });
    // "../etc" 同时含分隔符与 ..，按检查顺序先命中 separator；纯 .. 才是 parent
    expect(isValidTopic("../etc")).toEqual({ ok: false, reason: "separator" });
    expect(isValidTopic("..")).toEqual({ ok: false, reason: "parent" });
    expect(isValidTopic("a\0b")).toEqual({ ok: false, reason: "nul" });
    expect(TOPIC_REJECTION_REASONS).toHaveLength(4);
  });
});

describe("notes-core / paths and settings", () => {
  it("builds the topic note path without duplicated separators", () => {
    expect(
      topicNotePath({ vaultRoot: "/v", topDir: "Learn", topic: "分布式共识" }),
    ).toBe("/v/Learn/分布式共识/分布式共识.md");
    expect(
      topicNotePath({ vaultRoot: "/v/", topDir: "/Learn/", topic: "Go" }),
    ).toBe("/v/Learn/Go/Go.md");
  });

  it("expands ~ without touching the filesystem", () => {
    expect(expandHome("~/work/notes", "/Users/x")).toBe("/Users/x/work/notes");
    expect(expandHome("~", "/Users/x")).toBe("/Users/x");
    expect(expandHome("/abs/path", "/Users/x")).toBe("/abs/path");
  });

  it("falls back to defaults when settings are missing or malformed", () => {
    expect(resolveTutorSettings(undefined)).toEqual({
      vaultRoot: "~/work/notes",
      topDir: "Learn",
      warnings: [],
    });

    const malformed = resolveTutorSettings({
      tutor: { vaultRoot: "", topDir: "Learn/Sub" },
    });
    expect(malformed.vaultRoot).toBe("~/work/notes");
    expect(malformed.topDir).toBe("Learn");
    expect(malformed.warnings).toHaveLength(2);

    expect(resolveTutorSettings({ tutor: "nope" }).warnings).toHaveLength(1);
  });

  it("honours good settings", () => {
    expect(
      resolveTutorSettings({
        tutor: { vaultRoot: "/tmp/vault", topDir: "学习" },
      }),
    ).toEqual({ vaultRoot: "/tmp/vault", topDir: "学习", warnings: [] });
  });

  it("writes a header that explains the append-only contract", () => {
    expect(formatTopicHeader("Gossip")).toContain("# Gossip");
    expect(formatTopicHeader("Gossip")).toContain("只增不改");
  });
});

describe("notes-core / question and answer blocks", () => {
  const quizDetails: QuizDetails = {
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
  };

  it("never leaks the answer into the question block", () => {
    const block = formatQuestionBlock({
      kind: "Quiz",
      question: "哪个行星最热？",
      context: "只看太阳系",
      options: [
        { index: 1, label: "Mercury" },
        { index: 2, label: "Venus" },
      ],
    });
    expect(block).toContain("> [!question] Quiz");
    expect(block).toContain("1. Mercury");
    expect(block).not.toContain("Venus 最热");
    expect(block).not.toContain("Explanation");
    expect(block).not.toContain("Correct answer");
  });

  it("renders quiz answers with verdict, correct option and explanation", () => {
    const block = formatQuizAnswerBlock(quizDetails);
    expect(block).toContain("> [!success] Quiz — correct ✓");
    expect(block).toContain("Your answer: 2. Venus");
    expect(block).toContain("Correct answer: 2. Venus");
    expect(block).toContain("金星大气最厚。");
  });

  it("keeps 'I don't know' out of the ✓/✗ verdicts and out of the question callout type", () => {
    const block = formatQuizAnswerBlock({
      ...quizDetails,
      dontKnow: true,
      isCorrect: null,
      answers: [],
    });
    expect(block).toContain("> [!info] Quiz — I don't know");
    expect(block).not.toContain("✗");
    expect(block).not.toContain("✓");
    // 不变量：只有“题面”块用 [!question]，判定块里会出现正确答案。
    expect(block.startsWith("> [!question]")).toBe(false);
  });

  it("marks cancelled and unavailable runs explicitly", () => {
    expect(
      formatQuizAnswerBlock({ ...quizDetails, status: "cancelled" }),
    ).toContain("> [!warning] Quiz — cancelled");
    expect(
      formatQuizAnswerBlock({ ...quizDetails, status: "unavailable" }),
    ).toContain("> [!warning] Quiz — unavailable");
  });

  it("renders ask answers including free text", () => {
    const withOption: AskDetails = {
      status: "answered",
      question: "先学哪块？",
      mode: "single-select",
      options: [
        { index: 1, label: "理论" },
        { index: 2, label: "实践" },
      ],
      selections: [{ index: 2, label: "实践", value: "实践" }],
      message: "ok",
    };
    expect(formatAskAnswerBlock(withOption)).toContain("> [!example] Answer");
    expect(formatAskAnswerBlock(withOption)).toContain("2. 实践");

    const withText = formatAskAnswerBlock({
      ...withOption,
      selections: [],
      otherText: "先讲幂等性",
    });
    expect(withText).toContain("Other: 先讲幂等性");
  });
});

describe("notes-core / session text helpers", () => {
  it("collapses injected skill bodies into a single note line", () => {
    const text = `before\n<skill name="tutor">${"x".repeat(200)}</skill>\nafter`;
    const stripped = stripSkillBlocks(text);
    expect(stripped).toContain("> [!note] SKILL loaded: tutor");
    expect(stripped).not.toContain("xxxx");
    expect(stripped).toContain("after");
  });

  it("extracts joined text from string and structured content", () => {
    expect(messageText("hi")).toBe("hi");
    expect(
      messageText([
        { type: "text", text: " a " },
        { type: "image", text: "ignored" } as never,
        { type: "text", text: "b" },
      ]),
    ).toBe("a\n\nb");
    expect(messageText(undefined)).toBe("");
  });
});
