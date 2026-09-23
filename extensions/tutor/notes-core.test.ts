import { describe, expect, it } from "vitest";
import type { AskDetails } from "./ask-core.ts";
import {
  bindToolCallIds,
  buildTopicState,
  CHAPTERS_END,
  catalogBlocks,
  chapterFileName,
  chapterLabel,
  chapterNotePath,
  countVerdicts,
  expandHome,
  formatAnswerBlock,
  formatAskAnswerBlock,
  formatNumberingConflict,
  formatQuestionBlock,
  formatQuizAnswerBlock,
  formatSectionHeader,
  formatTopicHeader,
  hasIndexEntry,
  indexEntryLine,
  isValidChapter,
  isValidTopic,
  messageText,
  mirrorAssistantText,
  mirrorStep,
  nextChapterNumber,
  parseChapterFileName,
  parseChapterRef,
  parseIndexEntries,
  parseNoteBlocks,
  pickResume,
  planNumbering,
  planSplit,
  proposeChapterOrder,
  provenanceBlock,
  relinkIndex,
  resolveChapterNumber,
  resolveTutorSettings,
  rewriteChapterHeading,
  sanitizeName,
  stripQuestionCallouts,
  stripSkillBlocks,
  TOPIC_REJECTION_REASONS,
  toolCallQuestions,
  topicNotePath,
  upsertChapterToc,
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
    expect(isValidChapter("进程与 namespace")).toEqual({
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

  it("writes nothing for tool results that carry no answer", () => {
    // 真实崩过的形状：quiz 校验失败时工具返回 `details: {}`。
    expect(formatAnswerBlock({})).toBeUndefined();
    expect(formatAnswerBlock(undefined)).toBeUndefined();
    expect(formatAnswerBlock(null)).toBeUndefined();
    expect(formatAnswerBlock("answered")).toBeUndefined();
    // pending 归问题块管；status 对但形状错的情况也不猜。
    expect(
      formatAnswerBlock({ status: "pending", selections: [] }),
    ).toBeUndefined();
    expect(
      formatAnswerBlock({ status: "answered", correctValues: [] }),
    ).toBeUndefined();
    expect(
      formatAnswerBlock({ status: "answered", selections: "2. 实践" }),
    ).toBeUndefined();
  });

  it("dispatches recognized answers to the quiz or ask block", () => {
    expect(formatAnswerBlock(quizDetails)).toContain(
      "> [!success] Quiz — correct ✓",
    );
    expect(
      formatAnswerBlock({
        status: "answered",
        question: "先学哪块？",
        mode: "single-select",
        options: [],
        selections: [{ index: 2, label: "实践", value: "实践" }],
        message: "ok",
      }),
    ).toContain("2. 实践");
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

describe("notes-core / duplicate question callouts", () => {
  it("collects the stems a message asks through quiz / ask_user_question", () => {
    expect(
      toolCallQuestions([
        { type: "thinking", text: "先别问" },
        {
          type: "toolCall",
          name: "quiz",
          arguments: { question: "哪个行星最热？" },
        },
        {
          type: "toolCall",
          name: "ask_user_question",
          arguments: { question: "接下来讲哪章？" },
        },
        { type: "toolCall", name: "read", arguments: { path: "x.md" } },
        // 校验失败的调用没有 question：不算"工具在提问"。
        { type: "toolCall", name: "quiz", arguments: { correctAnswer: "a" } },
        "nope",
      ]),
    ).toEqual(["哪个行星最热？", "接下来讲哪章？"]);
    expect(toolCallQuestions(undefined)).toEqual([]);
    expect(toolCallQuestions({ type: "toolCall" })).toEqual([]);
  });

  it("drops the hand-written callout, however the model reworded it", () => {
    // 真实形状：正文里的题面把 SQL 抄成了代码块，工具里的题面把 SQL 写在题干里。
    const content = [
      { type: "text", text: "先看这段会被隐式提交的代码。" },
      {
        type: "text",
        text: [
          "> [!question] Quiz",
          "> 在 MySQL 8.0 上执行下面这段，最后 `t` 表是什么状态？",
          ">",
          "> ```sql",
          "> BEGIN;",
          "> ALTER TABLE t ADD COLUMN c INT;",
          "> ROLLBACK;",
          "> ```",
        ].join("\n"),
      },
      {
        type: "toolCall",
        name: "quiz",
        arguments: {
          question:
            "在 MySQL 8.0 上执行 BEGIN; ALTER TABLE t ADD COLUMN c INT; ROLLBACK; ，最后 t 表是什么状态？",
        },
      },
    ];
    expect(mirrorAssistantText(content)).toBe("先看这段会被隐式提交的代码。");
  });

  it("keeps a question callout no tool backs, and leaves other callouts alone", () => {
    const text = [
      "> [!question] Quiz",
      "> 表 t 的主键是 id，锁落在哪？",
      ">",
      "> 1. 索引记录",
      "> 2. 行本身",
    ].join("\n");
    expect(mirrorAssistantText([{ type: "text", text }])).toBe(text);
    expect(stripQuestionCallouts(text)).toBe("");
  });

  it("removes a mid-text duplicate and keeps the prose tidy", () => {
    const text = [
      "第一段。",
      "",
      "> [!question] Quiz",
      "> 哪个行星最热？",
      ">",
      "> 1. Mercury",
      "",
      "第二段。",
      "",
      "> [!abstract] PI",
      "> 收尾。",
    ].join("\n");
    expect(stripQuestionCallouts(text)).toBe(
      "第一段。\n\n第二段。\n\n> [!abstract] PI\n> 收尾。",
    );
  });

  it("never touches a fenced example of the note format", () => {
    const text = [
      "题面块的格式长这样：",
      "",
      "```markdown",
      "> [!question] Quiz",
      "> 题干",
      ">",
      "> 1. 选项",
      "```",
    ].join("\n");
    expect(stripQuestionCallouts(text)).toBe(text);
  });

  it("treats ask callouts like quiz callouts and never touches verdict blocks", () => {
    const text = [
      "> [!Question] Question",
      "> 接下来讲哪章？",
      ">",
      "> 1. 加锁规则地图",
      "",
      "> [!info] Quiz — I don't know",
      "> Your answer: I don't know",
    ].join("\n");
    expect(stripQuestionCallouts(text)).toBe(
      "> [!info] Quiz — I don't know\n> Your answer: I don't know",
    );
  });
});

// ── 章节 / 续做 / 存量拆分 ────────────────────────────────────────────────

describe("notes-core / chapters", () => {
  it("builds chapter paths from the number and keeps the index path when no chapter is given", () => {
    expect(
      chapterNotePath({
        vaultRoot: "/v",
        topDir: "Learn",
        topic: "Docker实现",
      }),
    ).toBe("/v/Learn/Docker实现/Docker实现.md");
    expect(
      chapterNotePath({
        vaultRoot: "/v/",
        topDir: "/Learn/",
        topic: "Docker实现",
        chapter: "  进程与隔离  ",
        number: 3,
      }),
    ).toBe("/v/Learn/Docker实现/03-进程与隔离.md");
    expect(
      chapterNotePath({
        vaultRoot: "/v",
        topDir: "Learn",
        topic: "Docker实现",
        chapter: "进程与隔离",
      }),
    ).toBe("/v/Learn/Docker实现/进程与隔离.md");
  });

  it("validates chapter names with the topic rules plus a length cap", () => {
    expect(isValidChapter("进程与隔离").ok).toBe(true);
    expect(isValidChapter("  ")).toEqual({ ok: false, reason: "empty" });
    expect(isValidChapter("a/b")).toEqual({ ok: false, reason: "separator" });
    expect(isValidChapter("..")).toEqual({ ok: false, reason: "parent" });
    expect(isValidChapter("a\0b")).toEqual({ ok: false, reason: "nul" });
    expect(isValidChapter("x".repeat(60)).ok).toBe(true);
    expect(isValidChapter("x".repeat(61))).toEqual({
      ok: false,
      reason: "too-long",
    });
  });

  it("writes a chapter header that names its topic and number", () => {
    expect(formatSectionHeader("Docker实现", "进程与隔离", 3)).toContain(
      "# 第3章 · 进程与隔离",
    );
    expect(formatSectionHeader("Docker实现", "进程与隔离", 3)).toContain(
      "《Docker实现》第 3 章",
    );
    // 无编号时退回旧文案（迁移前的章节）
    expect(formatSectionHeader("Docker实现", "进程与隔离")).toContain(
      "《Docker实现》的一章",
    );
  });

  it("builds index lines and detects existing ones without prefix confusion", () => {
    expect(indexEntryLine({ name: "进程与隔离", date: "2026-09-18" })).toBe(
      "- [[进程与隔离]] · 2026-09-18",
    );
    expect(
      indexEntryLine({ name: "进程与隔离", number: 3, date: "2026-09-18" }),
    ).toBe("- 第3章 · [[03-进程与隔离|进程与隔离]] · 2026-09-18");
    const index = "- 第3章 · [[03-进程与隔离|进程与隔离]] · 2026-09-18";
    expect(hasIndexEntry(index, "进程与隔离")).toBe(true);
    expect(hasIndexEntry(index, "进程")).toBe(false);
    expect(hasIndexEntry("- [[进程与隔离2]] · x", "进程与隔离")).toBe(false);
    // 旧格式与 provenance 的 `> - ` 行
    expect(hasIndexEntry("- [[进程与隔离]] · 2026-09-18", "进程与隔离")).toBe(
      true,
    );
    expect(hasIndexEntry("> - [[进程与隔离]] · 2026-09-18", "进程与隔离")).toBe(
      true,
    );
  });

  it("parses index entries with their numbers, names and dates", () => {
    const index = [
      "> [!note] 2026-09-18 已拆分为 [[01-a]] [[02-b]]",
      ">",
      "> - 第1章 · [[01-a|a]] · 2026-09-18",
      "> - [[b]] · 2026-09-19",
      "正文里的 [[c]] 不是章节行",
    ].join("\n");
    expect(parseIndexEntries(index)).toEqual([
      {
        number: 1,
        name: "a",
        fileName: "01-a",
        date: "2026-09-18",
        line: "> - 第1章 · [[01-a|a]] · 2026-09-18",
      },
      {
        number: undefined,
        name: "b",
        fileName: "b",
        date: "2026-09-19",
        line: "> - [[b]] · 2026-09-19",
      },
    ]);
  });
});

describe("notes-core / chapter ordinals", () => {
  it("derives labels and file names from the number", () => {
    expect(chapterLabel(3, "调度与唤醒")).toBe("第3章 · 调度与唤醒");
    expect(chapterLabel(undefined, "调度与唤醒")).toBe("调度与唤醒");
    expect(chapterFileName(3, "调度与唤醒")).toBe("03-调度与唤醒");
    expect(chapterFileName(10, "x")).toBe("10-x");
    expect(chapterFileName(100, "x")).toBe("100-x");
    expect(chapterFileName(undefined, "调度与唤醒")).toBe("调度与唤醒");
  });

  it("round-trips file names and keeps non-numeric prefixes as names", () => {
    expect(parseChapterFileName("03-调度与唤醒")).toEqual({
      number: 3,
      name: "调度与唤醒",
    });
    expect(parseChapterFileName("调度与唤醒")).toEqual({
      name: "调度与唤醒",
    });
    // 不是编号前缀：4 位年号、以数字开头的章名
    expect(parseChapterFileName("2026-09-18-x")).toEqual({
      name: "2026-09-18-x",
    });
    expect(parseChapterFileName("1号进程与生命周期")).toEqual({
      name: "1号进程与生命周期",
    });
  });

  it("parses the chapter refs a human or agent might type", () => {
    expect(parseChapterRef("第3章")).toEqual({ number: 3 });
    expect(parseChapterRef("第三章")).toEqual({ number: 3 });
    expect(parseChapterRef("第二十三章")).toEqual({ number: 23 });
    expect(parseChapterRef("第3章 · 调度与唤醒")).toEqual({
      number: 3,
      name: "调度与唤醒",
    });
    expect(parseChapterRef("第 3 章：调度与唤醒")).toEqual({
      number: 3,
      name: "调度与唤醒",
    });
    expect(parseChapterRef("03-调度与唤醒")).toEqual({
      number: 3,
      name: "调度与唤醒",
    });
    expect(parseChapterRef("3")).toEqual({ number: 3 });
    expect(parseChapterRef("调度与唤醒")).toEqual({ name: "调度与唤醒" });
  });

  it("resolves numbers: reuse existing, honour a free request, otherwise max + 1", () => {
    const chapters = [
      { number: 1, name: "一" },
      { number: 2, name: "二" },
      { number: 4, name: "四" },
      { name: "未编号" },
    ];
    // 该章已有编号（第4章的"四"）：沿用它
    expect(
      resolveChapterNumber({ existing: 4, requested: 4, chapters }),
    ).toEqual({ ok: true, number: 4 });
    expect(resolveChapterNumber({ existing: 4, chapters })).toEqual({
      ok: true,
      number: 4,
    });
    // 显式要求一个空闲编号（补讲空洞）→ 允许
    expect(resolveChapterNumber({ requested: 3, chapters })).toEqual({
      ok: true,
      number: 3,
    });
    // 未指定 → max + 1，空洞不自动填
    expect(resolveChapterNumber({ chapters })).toEqual({ ok: true, number: 5 });
    expect(nextChapterNumber([])).toBe(1);
    expect(nextChapterNumber([1, 2, 4])).toBe(5);
  });

  it("fails a taken number with the occupant, taken numbers, gaps and the auto number", () => {
    const chapters = [
      { number: 1, name: "锁模式与位掩码" },
      { number: 3, name: "调度与唤醒" },
    ];
    const decision = resolveChapterNumber({ requested: 3, chapters });
    expect(decision.ok).toBe(false);
    if (decision.ok === true) return;
    expect(decision.conflict).toMatchObject({
      requested: 3,
      occupant: "第3章 · 调度与唤醒",
      taken: [1, 3],
      gaps: [2],
      auto: 4,
    });
    expect(decision.hint).toBe(
      formatNumberingConflict({
        requested: 3,
        occupant: "第3章 · 调度与唤醒",
        taken: [1, 3],
        gaps: [2],
        auto: 4,
      }),
    );
    expect(decision.hint).toContain("已被「第3章 · 调度与唤醒」占用");
    expect(decision.hint).toContain("空闲 2");
    expect(decision.hint).toContain("自动取 4");
  });

  it("refuses to renumber an already numbered chapter and rejects bad requests", () => {
    const chapters = [{ number: 3, name: "调度与唤醒" }];
    const renumber = resolveChapterNumber({
      existing: 3,
      requested: 5,
      chapters,
    });
    expect(renumber.ok).toBe(false);
    if (renumber.ok === false) {
      expect(renumber.conflict).toBe(null);
      expect(renumber.hint).toContain("不重排已编号章节");
    }
    const bad = resolveChapterNumber({ requested: 0, chapters });
    expect(bad.ok).toBe(false);
    if (bad.ok === false) expect(bad.hint).toContain("positive integer");
  });

  it("rewrites the heading only when it is the plain name", () => {
    expect(rewriteChapterHeading("# 调度与唤醒\n\n正文", "调度与唤醒", 3)).toBe(
      "# 第3章 · 调度与唤醒\n\n正文",
    );
    expect(
      rewriteChapterHeading("# 我改过的标题\n\n正文", "调度与唤醒", 3),
    ).toBe("# 我改过的标题\n\n正文");
    // 旧笔记的标题带空格（名字后来去了空格）：只差空白就算同一个标题
    expect(
      rewriteChapterHeading(
        "# chroot 与挂载时机\n\n正文",
        "chroot与挂载时机",
        4,
      ),
    ).toBe("# 第4章 · chroot与挂载时机\n\n正文");
    // 没有标题行 / 标题行多了别的话 → 一个字都不动
    expect(rewriteChapterHeading("正文没有标题\n", "调度与唤醒", 3)).toBe(
      "正文没有标题\n",
    );
    expect(
      rewriteChapterHeading("# 调度与唤醒（改过）\n", "调度与唤醒", 3),
    ).toBe("# 调度与唤醒（改过）\n");
  });

  it("relinks every form of link to the numbered target and leaves prose alone", () => {
    const index = [
      "> [!note] 2026-09-18 已拆分为 [[调度与唤醒]] [[别的]]",
      "- [[调度与唤醒]] · 2026-09-18",
      "> - [[调度与唤醒|唤醒]] · 2026-09-19",
      "- 第 3 章还是别扭",
    ].join("\n");
    const relinked = relinkIndex(index, {
      name: "调度与唤醒",
      number: 3,
      fileName: "03-调度与唤醒",
    });
    expect(relinked).toContain("[[03-调度与唤醒|调度与唤醒]] [[别的]]");
    expect(relinked).toContain(
      "- 第3章 · [[03-调度与唤醒|调度与唤醒]] · 2026-09-18",
    );
    expect(relinked).toContain(
      "> - 第3章 · [[03-调度与唤醒|唤醒]] · 2026-09-19",
    );
    expect(relinked).toContain("- 第 3 章还是别扭");
    // 索引列表行补上「第N章 ·」前缀（provenance 的 `> - ` 行也算），已有编号的不重复加
    expect(relinked).toContain(
      "- 第3章 · [[03-调度与唤醒|调度与唤醒]] · 2026-09-18",
    );
    expect(relinked).toContain(
      "> - 第3章 · [[03-调度与唤醒|唤醒]] · 2026-09-19",
    );
    // 幂等：再跑一次不变
    expect(
      relinkIndex(relinked, {
        name: "调度与唤醒",
        number: 3,
        fileName: "03-调度与唤醒",
      }),
    ).toBe(relinked);
  });

  it("inserts the TOC before the first callout, not between a callout and its body", () => {
    const index = [
      "# Docker实现",
      "",
      "> 由 tutor 维持：每次教学按时间顺序追加，只增不改。",
      "",
      "> [!abstract] PI",
      "",
      "先确认方向。",
      "",
    ].join("\n");
    const withToc = upsertChapterToc(index, [
      { number: 1, name: "重建地基：对象视角", date: "2026-09-18" },
    ]);
    expect(withToc.indexOf("## 章节")).toBeLessThan(
      withToc.indexOf("> [!abstract] PI"),
    );
    expect(withToc.indexOf("> 由 tutor 维持")).toBeLessThan(
      withToc.indexOf("## 章节"),
    );
    // 有 provenance / 正文 callout 的索引也插在第一个 callout 之前
    const withProvenance = upsertChapterToc(
      [
        "# Docker实现",
        "",
        "> 由 tutor 维持：…",
        "",
        "> [!note] 2026-09-18 已拆分为 [[01-a]]",
        ">",
        "> - [[01-a]] · 2026-09-18",
        "",
        "正文。",
      ].join("\n"),
      [{ number: 1, name: "a", date: "2026-09-18" }],
    );
    expect(withProvenance.indexOf("## 章节")).toBeLessThan(
      withProvenance.indexOf("> [!note]"),
    );
  });

  it("inserts the chapter TOC after the topic header, then rebuilds it in place", () => {
    const header =
      "# MySQL锁原理与实现\n\n> 由 tutor 维持：每次教学按时间顺序追加，只增不改。\n";
    const chapters = [
      { number: 1, name: "锁模式与位掩码", date: "2026-09-21" },
      { number: 2, name: "加锁过程与等待队列" },
    ];
    const withToc = upsertChapterToc(header, chapters);
    expect(withToc.startsWith("# MySQL锁原理与实现")).toBe(true);
    expect(withToc.indexOf("## 章节")).toBeGreaterThan(
      withToc.indexOf("> 由 tutor 维持"),
    );
    expect(withToc).toContain(
      "- 第1章 · [[01-锁模式与位掩码|锁模式与位掩码]] · 2026-09-21",
    );
    expect(withToc).toContain(
      "- 第2章 · [[02-加锁过程与等待队列|加锁过程与等待队列]]",
    );
    expect(withToc).toContain(CHAPTERS_END);
    // 原地重建：加一章后块被重写，块外一字不动
    const rebuilt = upsertChapterToc(withToc, [
      ...chapters,
      { number: 3, name: "调度与唤醒", date: "2026-09-21" },
    ]);
    expect(rebuilt).toContain(
      "- 第3章 · [[03-调度与唤醒|调度与唤醒]] · 2026-09-21",
    );
    expect(rebuilt.match(/## 章节/g)).toHaveLength(1);
    expect(rebuilt).toContain("> 由 tutor 维持");
    // 空列表不动索引；没有定界符的老索引不会被凭空改
    expect(upsertChapterToc(header, [])).toBe(header);
  });

  it("plans a numbering migration in the given order", () => {
    const existing = [
      { name: "锁模式与位掩码" },
      { name: "加锁过程与等待队列" },
      { name: "调度与唤醒" },
      { number: 4, name: "超时与死锁检测" },
    ];
    const plan = planNumbering({
      chapters: ["锁模式与位掩码", "加锁过程与等待队列", "调度与唤醒"],
      existing,
    });
    expect(plan.ok).toBe(true);
    if (plan.ok === false) return;
    expect(plan.assignments).toEqual([
      {
        name: "锁模式与位掩码",
        number: 1,
        from: "锁模式与位掩码",
        to: "01-锁模式与位掩码",
        unchanged: false,
      },
      {
        name: "加锁过程与等待队列",
        number: 2,
        from: "加锁过程与等待队列",
        to: "02-加锁过程与等待队列",
        unchanged: false,
      },
      {
        name: "调度与唤醒",
        number: 3,
        from: "调度与唤醒",
        to: "03-调度与唤醒",
        unchanged: false,
      },
    ]);
    // 已编号且和计划一致 → 计划里保留但标记跳过；没进顺序的未编号章节列入 unassigned
    const keep = planNumbering({
      chapters: ["超时与死锁检测", "排查对应表"],
      existing: [...existing, { name: "排查对应表" }],
      startAt: 4,
    });
    expect(keep.ok).toBe(true);
    if (keep.ok === true) {
      expect(keep.assignments.map((item) => item.unchanged)).toEqual([
        true,
        false,
      ]);
      expect(keep.unassigned.map((item) => item.name)).toEqual([
        "锁模式与位掩码",
        "加锁过程与等待队列",
        "调度与唤醒",
      ]);
    }
  });

  it("refuses a migration that would renumber, misspell or duplicate a chapter", () => {
    const existing = [
      { number: 3, name: "调度与唤醒" },
      { name: "排查对应表" },
    ];
    const renumber = planNumbering({
      chapters: ["排查对应表", "调度与唤醒"],
      existing,
    });
    expect(renumber.ok).toBe(false);
    if (renumber.ok === false) {
      expect(renumber.conflicts[0].name).toBe("调度与唤醒");
      expect(renumber.conflicts[0].hint).toContain("不重排已编号章节");
    }
    const typo = planNumbering({ chapters: ["调度与唤配"], existing });
    expect(typo.ok).toBe(false);
    if (typo.ok === false)
      expect(typo.conflicts[0].hint).toContain("目录里没有章节");
    const dup = planNumbering({
      chapters: ["排查对应表", "排查对应表"],
      existing,
    });
    expect(dup.ok).toBe(false);
    if (dup.ok === false) expect(dup.conflicts[0].hint).toContain("出现了两次");
  });

  it("suggests an order: index order first, then most recently touched", () => {
    expect(
      proposeChapterOrder({
        chapters: [
          { name: "c", touchedAt: "2026-09-01T00:00:00.000Z" },
          { name: "a", touchedAt: "2026-09-03T00:00:00.000Z" },
          { name: "b", touchedAt: "2026-09-02T00:00:00.000Z" },
        ],
        indexOrder: ["a", "b", "不在目录里的"],
      }),
    ).toEqual(["a", "b", "c"]);
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
      chapters: [{ name: "进程与隔离", blockIndexes: [2, 3] }],
    });
    expect(plan.ok).toBe(true);
    if (plan.ok === false) return;
    expect(plan.chapters[0].number).toBe(1);
    expect(plan.chapters[0].fileName).toBe("01-进程与隔离");
    expect(plan.chapters[0].markdown).toContain("> [!question] Quiz");
    expect(plan.chapters[0].markdown).toContain(
      "> [!success] Quiz — correct ✓",
    );
    expect(plan.index).toContain("# Docker 实现");
    expect(plan.index).toContain("> [!question] Quiz"); // 第二题仍在索引
    expect(plan.index).not.toContain("> [!success] Quiz — correct ✓");
  });

  it("conserves every block exactly once", () => {
    const plan = planSplit({
      markdown: chapterNote,
      chapters: [
        { name: "A", blockIndexes: [2, 3] },
        { name: "B", blockIndexes: [4] },
      ],
    });
    expect(plan.ok).toBe(true);
    if (plan.ok === false) return;
    const original = parseNoteBlocks(chapterNote).map((block) => block.text);
    const after = [
      ...parseNoteBlocks(plan.index).map((block) => block.text),
      ...plan.chapters.flatMap((chapter) =>
        parseNoteBlocks(chapter.markdown).map((block) => block.text),
      ),
    ];
    expect(after.slice().sort()).toEqual(original.slice().sort());
  });

  it("rejects bad assignments", () => {
    const cases = [
      { chapters: [{ name: "A", blockIndexes: [99] }], error: "out of range" },
      {
        chapters: [{ name: "A", blockIndexes: [1, 1] }],
        error: "assigned twice",
      },
      { chapters: [{ name: "A", blockIndexes: [] }], error: "has no blocks" },
      { chapters: [{ name: "a/b", blockIndexes: [1] }], error: "is invalid" },
      { chapters: [], error: "no block was assigned" },
    ];
    for (const item of cases) {
      const plan = planSplit({
        markdown: chapterNote,
        chapters: item.chapters,
      });
      expect(plan.ok).toBe(false);
      if (plan.ok === false) expect(plan.error).toContain(item.error);
    }
    expect(
      planSplit({
        markdown: "# empty",
        chapters: [{ name: "A", blockIndexes: [1] }],
      }),
    ).toMatchObject({
      ok: false,
    });
  });

  it("writes a provenance block that points at the archive and lists the chapters", () => {
    const block = provenanceBlock({
      date: "2026-09-18",
      chapters: [
        { number: 1, name: "进程与隔离" },
        { number: 2, name: "namespace" },
      ],
      archiveName: "Docker实现.2026-09-18.md",
    });
    expect(block).toContain("[[01-进程与隔离]] [[02-namespace]]");
    expect(block).toContain("_archive/Docker实现.2026-09-18.md");
    expect(block).toContain(
      "> - 第1章 · [[01-进程与隔离|进程与隔离]] · 2026-09-18",
    );
  });
});

describe("notes-core / numbering order with explicit numbers", () => {
  it("honours a number written into the order list, leaving the gap open", () => {
    const existing = [
      { name: "锁模式与位掩码" },
      { name: "加锁过程与等待队列" },
      { name: "加锁规则地图" },
      { name: "排查对应表" },
    ];
    const plan = planNumbering({
      chapters: [
        "第1章 · 锁模式与位掩码",
        "第2章 · 加锁过程与等待队列",
        "第6章 · 加锁规则地图",
        "第7章 · 排查对应表",
      ],
      existing,
    });
    expect(plan.ok).toBe(true);
    if (plan.ok === false) return;
    expect(plan.assignments.map((item) => [item.name, item.number])).toEqual([
      ["锁模式与位掩码", 1],
      ["加锁过程与等待队列", 2],
      ["加锁规则地图", 6],
      ["排查对应表", 7],
    ]);
    expect(plan.assignments.map((item) => item.to)).toEqual([
      "01-锁模式与位掩码",
      "02-加锁过程与等待队列",
      "06-加锁规则地图",
      "07-排查对应表",
    ]);
  });

  it("rejects the same number twice in one order", () => {
    const plan = planNumbering({
      chapters: ["第2章 · 甲", "第2章 · 乙"],
      existing: [{ name: "甲" }, { name: "乙" }],
    });
    expect(plan.ok).toBe(false);
    if (plan.ok === false) expect(plan.conflicts[0].hint).toContain("同时给了");
  });
});

describe("notes-core / 镜像闸门", () => {
  const bind = (id: string) => ({ type: "toolCall", id, name: "bind_notes" });

  it("挑出 bind_notes 的 tool call id，忽略其他工具", () => {
    expect(
      bindToolCallIds([
        { type: "text", text: "先收尾，再开新章" },
        { type: "toolCall", id: "q1", name: "quiz" },
        bind("b1"),
        { type: "toolCall", id: "a1", name: "ask_user_question" },
      ]),
    ).toEqual(["b1"]);
  });

  it("认不出形状时返回空数组，绝不抛", () => {
    expect(bindToolCallIds(undefined)).toEqual([]);
    expect(bindToolCallIds("字符串")).toEqual([]);
    expect(bindToolCallIds([{ type: "toolCall", name: "bind_notes" }])).toEqual(
      [],
    );
  });

  it("不带 bind 的消息立即放行（既有行为不变）", () => {
    expect(
      mirrorStep(null, { kind: "assistant", block: "正文", binds: [] }),
    ).toEqual({ pending: null, append: ["正文"] });
  });

  it("同轮 bind：正文先扣住，等 bindResult 才放行", () => {
    const held = mirrorStep(null, {
      kind: "assistant",
      block: "第2章正文",
      binds: ["b1"],
    });
    expect(held).toEqual({
      pending: { binds: ["b1"], blocks: ["第2章正文"] },
      append: [],
    });
    expect(
      mirrorStep(held.pending, { kind: "bindResult", toolCallId: "b1" }),
    ).toEqual({ pending: null, append: ["第2章正文"] });
  });

  it("别人家的 bindResult 不认领，闸门继续关着", () => {
    const held = {
      pending: { binds: ["b1"], blocks: ["第2章正文"] },
      append: [],
    };
    expect(
      mirrorStep(held.pending, { kind: "bindResult", toolCallId: "other" }),
    ).toEqual({ pending: held.pending, append: [] });
  });

  it("同轮两个 bind：全部回来才开闸", () => {
    const first = mirrorStep(null, {
      kind: "assistant",
      block: "正文",
      binds: ["b1", "b2"],
    });
    const second = mirrorStep(first.pending, {
      kind: "bindResult",
      toolCallId: "b1",
    });
    expect(second).toEqual({
      pending: { binds: ["b2"], blocks: ["正文"] },
      append: [],
    });
    expect(
      mirrorStep(second.pending, { kind: "bindResult", toolCallId: "b2" }),
    ).toEqual({ pending: null, append: ["正文"] });
  });

  it("关闸期间的块排队，开闸后按产出顺序放行", () => {
    const held = mirrorStep(null, {
      kind: "assistant",
      block: "正文",
      binds: ["b1"],
    });
    const queued = mirrorStep(held.pending, { kind: "block", block: "题面" });
    expect(queued).toEqual({
      pending: { binds: ["b1"], blocks: ["正文", "题面"] },
      append: [],
    });
    expect(
      mirrorStep(queued.pending, { kind: "bindResult", toolCallId: "b1" }),
    ).toEqual({ pending: null, append: ["正文", "题面"] });
  });

  it("flush 兜底：bind 没回结果也要放行，绝不丢字", () => {
    const held = mirrorStep(null, {
      kind: "assistant",
      block: "正文",
      binds: ["b1"],
    });
    expect(mirrorStep(held.pending, { kind: "flush" })).toEqual({
      pending: null,
      append: ["正文"],
    });
  });

  it("空块不占位：正文为空但带 bind 时，闸门照样关上", () => {
    const held = mirrorStep(null, {
      kind: "assistant",
      block: "",
      binds: ["b1"],
    });
    expect(held).toEqual({
      pending: { binds: ["b1"], blocks: [] },
      append: [],
    });
    const queued = mirrorStep(held.pending, { kind: "block", block: "题面" });
    expect(queued.pending?.blocks).toEqual(["题面"]);
  });

  it("空块被丢弃：空正文/空题面都不会写进笔记", () => {
    expect(
      mirrorStep(null, { kind: "assistant", block: "", binds: [] }).append,
    ).toEqual([]);
    expect(mirrorStep(null, { kind: "block", block: "" }).append).toEqual([]);
  });

  it("上一个 bind 没回结果时又来一条带 bind 的消息：先放行旧的，再扣新的", () => {
    const stale = { binds: ["old"], blocks: ["旧正文"] };
    expect(
      mirrorStep(stale, { kind: "assistant", block: "新正文", binds: ["new"] }),
    ).toEqual({
      pending: { binds: ["new"], blocks: ["新正文"] },
      append: ["旧正文"],
    });
  });

  it("不带 bind 的消息也能放行扣住的块（顺序：先旧后新）", () => {
    const stale = { binds: ["old"], blocks: ["旧正文"] };
    expect(
      mirrorStep(stale, { kind: "assistant", block: "新正文", binds: [] }),
    ).toEqual({ pending: null, append: ["旧正文", "新正文"] });
  });
});
