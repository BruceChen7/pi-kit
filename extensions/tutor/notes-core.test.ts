import { describe, expect, it } from "vitest";
import type { AskDetails } from "./ask-core.ts";
import {
  buildTopicState,
  catalogBlocks,
  chapterNotePath,
  countVerdicts,
  expandHome,
  formatAskAnswerBlock,
  formatQuestionBlock,
  formatQuizAnswerBlock,
  formatSectionHeader,
  formatTopicHeader,
  hasIndexEntry,
  indexEntryLine,
  isValidSection,
  isValidTopic,
  messageText,
  parseNoteBlocks,
  pickResume,
  planSplit,
  provenanceBlock,
  resolveTutorSettings,
  sanitizeName,
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

  it("rejects names containing inner whitespace and suggests a space-free name", () => {
    expect(isValidTopic("Docker 实现")).toEqual({ ok: false, reason: "space" });
    expect(isValidTopic("Docker\t实现")).toEqual({
      ok: false,
      reason: "space",
    });
    expect(isValidSection("进程与 namespace")).toEqual({
      ok: false,
      reason: "space",
    });
    expect(sanitizeName("  Docker   实现 ")).toBe("Docker实现");
    expect(sanitizeName("进程与 namespace")).toBe("进程与namespace");
  });

  it("rejects empty, separator, parent and NUL topics", () => {
    expect(isValidTopic("   ")).toEqual({ ok: false, reason: "empty" });
    expect(isValidTopic("a/b")).toEqual({ ok: false, reason: "separator" });
    expect(isValidTopic("a\\b")).toEqual({ ok: false, reason: "separator" });
    // "../etc" 同时含分隔符与 ..，按检查顺序先命中 separator；纯 .. 才是 parent
    expect(isValidTopic("../etc")).toEqual({ ok: false, reason: "separator" });
    expect(isValidTopic("..")).toEqual({ ok: false, reason: "parent" });
    expect(isValidTopic("a\0b")).toEqual({ ok: false, reason: "nul" });
    expect(TOPIC_REJECTION_REASONS).toHaveLength(6);
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

// ── 章节 / 续做 / 存量拆分 ────────────────────────────────────────────────

describe("notes-core / sections", () => {
  it("builds chapter paths and keeps the index path when no section is given", () => {
    expect(
      chapterNotePath({
        vaultRoot: "/v",
        topDir: "Learn",
        topic: "Docker 实现",
      }),
    ).toBe("/v/Learn/Docker 实现/Docker 实现.md");
    expect(
      chapterNotePath({
        vaultRoot: "/v/",
        topDir: "/Learn/",
        topic: "Docker 实现",
        section: "  进程与隔离  ",
      }),
    ).toBe("/v/Learn/Docker 实现/进程与隔离.md");
  });

  it("validates section names with the topic rules plus a length cap", () => {
    expect(isValidSection("进程与隔离").ok).toBe(true);
    expect(isValidSection("  ")).toEqual({ ok: false, reason: "empty" });
    expect(isValidSection("a/b")).toEqual({ ok: false, reason: "separator" });
    expect(isValidSection("..")).toEqual({ ok: false, reason: "parent" });
    expect(isValidSection("a\0b")).toEqual({ ok: false, reason: "nul" });
    expect(isValidSection("x".repeat(60)).ok).toBe(true);
    expect(isValidSection("x".repeat(61))).toEqual({
      ok: false,
      reason: "too-long",
    });
  });

  it("writes a section header naming its topic", () => {
    expect(formatSectionHeader("Docker 实现", "进程与隔离")).toContain(
      "# 进程与隔离",
    );
    expect(formatSectionHeader("Docker 实现", "进程与隔离")).toContain(
      "《Docker 实现》",
    );
  });

  it("builds index lines and detects existing ones without prefix confusion", () => {
    expect(indexEntryLine({ section: "进程与隔离", date: "2026-09-18" })).toBe(
      "- [[进程与隔离]] · 2026-09-18",
    );
    const index = "- [[进程与隔离]] · 2026-09-18";
    expect(hasIndexEntry(index, "进程与隔离")).toBe(true);
    expect(hasIndexEntry(index, "进程")).toBe(false);
    expect(hasIndexEntry("- [[进程与隔离2]] · x", "进程与隔离")).toBe(false);
  });
});

const chapterNote = [
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
  "",
  "1. 被 SIGKILL",
  "2. 无事发生",
].join("\n");

describe("notes-core / block parsing and tallies", () => {
  it("classifies callout blocks in order", () => {
    // 开头的 "# 标题" 与 "> 由 tutor 维持…" 不是 callout，所以不计入块
    expect(parseNoteBlocks(chapterNote).map((block) => block.kind)).toEqual([
      "prose",
      "quiz",
      "verdict",
      "quiz",
    ]);
    expect(parseNoteBlocks("").length).toBe(0);
  });

  it("counts verdicts and flags a question with no verdict as unanswered", () => {
    expect(countVerdicts(parseNoteBlocks(chapterNote))).toEqual({
      ok: 1,
      wrong: 0,
      gaps: 0,
      unanswered: 1,
    });
    expect(
      countVerdicts(
        parseNoteBlocks(
          "> [!question] Quiz\n\nq\n\n> [!info] Quiz — I don't know\n\n> [!question] Quiz\n\nq2\n\n> [!failure] Quiz — incorrect ✗",
        ),
      ),
    ).toEqual({ ok: 0, wrong: 1, gaps: 1, unanswered: 0 });
  });

  it("treats a legacy [!question] verdict block as a verdict, not a question", () => {
    const legacy =
      "> [!question] Quiz\n\nq\n\n> [!question] Quiz — I don't know\n\n> [!success] Quiz — correct ✓";
    expect(parseNoteBlocks(legacy).map((block) => block.kind)).toEqual([
      "quiz",
      "verdict",
      "verdict",
    ]);
    expect(countVerdicts(parseNoteBlocks(legacy))).toEqual({
      ok: 1,
      wrong: 0,
      gaps: 1,
      unanswered: 0,
    });
  });

  it("counts an ask answer block as an answered question", () => {
    expect(
      countVerdicts(
        parseNoteBlocks(
          "> [!question] Question\n\n先学哪块？\n\n> [!example] Answer\n\n1. 实践",
        ),
      ),
    ).toEqual({ ok: 0, wrong: 0, gaps: 0, unanswered: 0 });
  });
});

describe("notes-core / resume", () => {
  const done = {
    name: "进程与隔离",
    path: "/v/进程与隔离.md",
    ok: 4,
    wrong: 1,
    gaps: 2,
    unanswered: 0,
    lastBlock: "verdict" as const,
    touchedAt: "2026-09-18T10:00:00.000Z",
  };
  const dangling = {
    name: "namespace 与 cgroup",
    path: "/v/namespace.md",
    ok: 2,
    wrong: 0,
    gaps: 1,
    unanswered: 1,
    lastBlock: "quiz" as const,
    touchedAt: "2026-09-18T12:00:00.000Z",
  };

  it("prefers an unanswered question, then cancelled, then the most recent", () => {
    expect(pickResume([done, dangling])).toEqual({
      chapter: "namespace 与 cgroup",
      reason: "unanswered-question",
    });
    expect(
      pickResume([
        { ...done, lastBlock: "warning" },
        { ...done, name: "第二章" },
      ]),
    ).toEqual({ chapter: "进程与隔离", reason: "cancelled" });
    expect(
      pickResume([
        done,
        { ...done, name: "第二章", touchedAt: "2026-09-19T00:00:00.000Z" },
      ]),
    ).toEqual({
      chapter: "第二章",
      reason: "recent",
    });
    expect(pickResume([])).toBeUndefined();
  });

  it("passes chapters through buildTopicState and attaches the resume", () => {
    const state = buildTopicState({
      topic: "Docker 实现",
      index: "- [[x]]",
      chapters: [done],
    });
    expect(state.chapters).toHaveLength(1);
    expect(state.resume).toEqual({ chapter: "进程与隔离", reason: "recent" });
  });
});

describe("notes-core / split", () => {
  it("catalogs blocks with 1-based indexes and short previews", () => {
    const catalog = catalogBlocks(chapterNote);
    expect(catalog.map((entry) => entry.index)).toEqual([1, 2, 3, 4]);
    expect(catalog[0].kind).toBe("prose");
    expect(catalog.every((entry) => !entry.preview.includes("\n"))).toBe(true);
    expect(catalog[0].preview.length).toBeLessThanOrEqual(61);
  });

  it("plans a split that keeps unassigned blocks in the index", () => {
    const plan = planSplit({
      markdown: chapterNote,
      sections: [{ name: "进程与隔离", blockIndexes: [2, 3] }],
    });
    expect(plan.ok).toBe(true);
    if (plan.ok === false) return;
    expect(plan.sections[0].markdown).toContain("> [!question] Quiz");
    expect(plan.sections[0].markdown).toContain(
      "> [!success] Quiz — correct ✓",
    );
    expect(plan.index).toContain("# Docker 实现");
    expect(plan.index).toContain("> [!question] Quiz"); // 第二题仍在索引
    expect(plan.index).not.toContain("> [!success] Quiz — correct ✓");
  });

  it("conserves every block exactly once", () => {
    const plan = planSplit({
      markdown: chapterNote,
      sections: [
        { name: "A", blockIndexes: [2, 3] },
        { name: "B", blockIndexes: [4] },
      ],
    });
    expect(plan.ok).toBe(true);
    if (plan.ok === false) return;
    const original = parseNoteBlocks(chapterNote).map((block) => block.text);
    const after = [
      ...parseNoteBlocks(plan.index).map((block) => block.text),
      ...plan.sections.flatMap((section) =>
        parseNoteBlocks(section.markdown).map((block) => block.text),
      ),
    ];
    expect(after.slice().sort()).toEqual(original.slice().sort());
  });

  it("rejects bad assignments", () => {
    const cases = [
      { sections: [{ name: "A", blockIndexes: [99] }], error: "out of range" },
      {
        sections: [{ name: "A", blockIndexes: [1, 1] }],
        error: "assigned twice",
      },
      { sections: [{ name: "A", blockIndexes: [] }], error: "has no blocks" },
      { sections: [{ name: "a/b", blockIndexes: [1] }], error: "is invalid" },
      { sections: [], error: "no block was assigned" },
    ];
    for (const item of cases) {
      const plan = planSplit({
        markdown: chapterNote,
        sections: item.sections,
      });
      expect(plan.ok).toBe(false);
      if (plan.ok === false) expect(plan.error).toContain(item.error);
    }
    expect(
      planSplit({
        markdown: "# empty",
        sections: [{ name: "A", blockIndexes: [1] }],
      }),
    ).toMatchObject({
      ok: false,
    });
  });

  it("writes a provenance block that points at the archive and lists the chapters", () => {
    const block = provenanceBlock({
      date: "2026-09-18",
      sections: ["进程与隔离", "namespace"],
      archiveName: "Docker 实现.2026-09-18.md",
    });
    expect(block).toContain("[[进程与隔离]] [[namespace]]");
    expect(block).toContain("_archive/Docker 实现.2026-09-18.md");
    expect(block).toContain("> - [[进程与隔离]] · 2026-09-18");
  });
});
