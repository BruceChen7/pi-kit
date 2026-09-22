/**
 * concepts-core 单测：全部 value in / value out —— 给字符串/概念对象，断言文本或决策对象。
 * 不 mock、不落盘（落盘在 concepts-store.integration.test.ts）。
 */

import { describe, expect, it } from "vitest";
import type { Concept, ConceptInput } from "./concepts-core.ts";
import {
  auditConcepts,
  buildCheckReport,
  CONCEPTS_BEGIN,
  CONCEPTS_END,
  CONCEPTS_FILE_NAME,
  classifyTerms,
  conceptHome,
  countOccurrences,
  extractTermMentions,
  findConcept,
  formatFirstRef,
  homeTopicIndex,
  isConceptTableName,
  isReservedTopicName,
  isValidConceptName,
  mergeConcept,
  normalizeConceptKey,
  parseConceptIndex,
  parseRegistry,
  prereqProblems,
  renderAuditReport,
  renderCheckReport,
  renderConceptEntry,
  renderConceptIndexLine,
  renderTopicConceptLine,
  topicConceptPath,
  topicConceptState,
  upsertConceptEntry,
  upsertConceptIndex,
} from "./concepts-core.ts";

const input = (
  partial: Partial<ConceptInput> & { name: string },
): ConceptInput => ({
  topic: "MySQL的ACID实现",
  date: "2026-09-22",
  ...partial,
});

const concept = (partial: Partial<Concept> & { name: string }): Concept => ({
  aliases: [],
  definition: "一句话定义",
  requires: [],
  first: { topic: "MySQL的ACID实现", chapter: 4, date: "2026-09-21" },
  status: "待验证",
  revisions: [],
  ...partial,
});

describe("concepts-core / 名字与匹配键", () => {
  it("accepts human names with spaces, rejects machine-line separators", () => {
    const cases: Array<[string, boolean, string?]> = [
      ["Read View", true],
      ["next-key lock", true],
      ["undo 版本链", true],
      ["  幻读  ", true],
      ["", false, "empty"],
      ["a|b", false, "forbidden-character:|"],
      ["a#b", false, "forbidden-character:#"],
      ["[[x]]", false, "forbidden-character:["],
      ["a·b", false, "forbidden-character:·"],
      ["a、b", false, "forbidden-character:、"],
      ["a\nb", false, "newline"],
      ["x".repeat(41), false, "too-long"],
    ];
    for (const [name, ok, reason] of cases) {
      const check = isValidConceptName(name);
      expect(check.ok, name).toBe(ok);
      if (check.ok === false) expect(check.reason, name).toBe(reason);
    }
  });

  it("trims and collapses inner whitespace", () => {
    const check = isValidConceptName("  Read   View  ");
    expect(check).toEqual({ ok: true, name: "Read View" });
  });

  it("normalizes writing variants to one key", () => {
    const keys = [
      "Read View",
      "read view",
      "read-view",
      "readview",
      " read  VIEW ",
    ].map(normalizeConceptKey);
    expect(new Set(keys).size).toBe(1);
  });
});

describe("concepts-core / 机器块", () => {
  const a = concept({ name: "Read View", status: "已确立" });
  const b = concept({
    name: "mtr",
    status: "缺口",
    first: { topic: "MySQL的ACID实现", chapter: 7, date: "2026-09-21" },
  });

  it("renders a line that parses back", () => {
    const entries = parseConceptIndex(
      [
        "## 概念",
        CONCEPTS_BEGIN,
        renderConceptIndexLine(a),
        renderConceptIndexLine(b),
        CONCEPTS_END,
      ].join("\n"),
    );
    expect(entries.map((entry) => [entry.name, entry.status])).toEqual([
      ["Read View", "已确立"],
      ["mtr", "缺口"],
    ]);
    expect(entries[0].first).toEqual({
      topic: "MySQL的ACID实现",
      chapter: 4,
      date: "",
    });
  });

  it("keeps the block sorted by first topic/chapter/name", () => {
    const later = concept({
      name: "A3",
      first: { topic: "MySQL锁原理与实现", chapter: 1, date: "2026-09-22" },
    });
    const markdown = upsertConceptIndex("# 概念表\n", [later, b, a]);
    expect(markdown).toContain(
      [
        renderConceptIndexLine(a),
        renderConceptIndexLine(b),
        renderConceptIndexLine(later),
      ].join("\n"),
    );
  });

  it("inserts the block after the header when delimiters are missing", () => {
    const markdown = upsertConceptIndex(
      "# 概念表 · Learn\n\n> 由 tutor 维持。\n\n## 术语\n",
      [a],
    );
    const lines = markdown.split("\n");
    expect(lines[0]).toBe("# 概念表 · Learn");
    expect(lines.indexOf("## 概念")).toBeGreaterThan(0);
    expect(lines.indexOf("## 概念")).toBeLessThan(
      lines.indexOf(renderConceptIndexLine(a)),
    );
    expect(markdown).toContain("## 术语");
  });

  it("replaces only the delimited block", () => {
    const original = [
      "# 概念表 · Learn",
      "",
      "## 概念",
      CONCEPTS_BEGIN,
      "- [[#旧|旧]] · 缺口 · 首次：X",
      CONCEPTS_END,
      "",
      "## 术语",
      "",
      "### 旧",
      "",
      "- 一句话定义：别动我",
      "",
    ].join("\n");
    const next = upsertConceptIndex(original, [a]);
    expect(next).toContain("- 一句话定义：别动我");
    expect(next).not.toContain("[[#旧|旧]]");
    expect(next).toContain(renderConceptIndexLine(a));
  });
});

describe("concepts-core / 条目", () => {
  it("renders every field and parses it back", () => {
    const full = concept({
      name: "Read View",
      aliases: ["RV"],
      definition: "事务第一次快照读时拍下的活跃事务名单。",
      why: "没有它就说不清「同一事务两次 SELECT 看到同一套行」。",
      requires: ["undo 版本链", "mtr"],
      source: "trx0read.cc",
      status: "已确立",
      evidence: "quiz 第2题答对（2026-09-22）",
      revisions: [{ date: "2026-09-22", text: "定义更新（旧）：旧的写法" }],
    });
    const parsed = parseRegistry(renderConceptEntry(full));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual(full);
  });

  it("defaults to 待验证 when the status line is missing", () => {
    const parsed = parseRegistry(
      "### X\n\n- 一句话定义：定义\n- 首次：T · 2026-09-22\n",
    );
    expect(parsed[0].status).toBe("待验证");
    expect(formatFirstRef(parsed[0].first)).toBe("T");
  });

  it("replaces an existing entry instead of appending a second one", () => {
    const first = upsertConceptEntry(
      "# 概念表\n",
      concept({ name: "Read View" }),
    );
    const second = upsertConceptEntry(
      first,
      concept({ name: "Read View", status: "已确立", definition: "新定义" }),
    );
    expect(parseRegistry(second)).toHaveLength(1);
    expect(second).toContain("新定义");
    expect(second.match(/### Read View/g)).toHaveLength(1);
  });

  it("appends to an existing 术语 section without touching earlier entries", () => {
    const base = upsertConceptEntry(
      "# 概念表\n\n## 术语\n",
      concept({ name: "Read View" }),
    );
    const next = upsertConceptEntry(base, concept({ name: "mtr" }));
    expect(next.indexOf("### Read View")).toBeLessThan(next.indexOf("### mtr"));
    expect(parseRegistry(next).map((item) => item.name)).toEqual([
      "Read View",
      "mtr",
    ]);
  });
});

describe("concepts-core / mergeConcept", () => {
  it("refuses a new concept without a definition", () => {
    const result = mergeConcept(undefined, input({ name: "mtr" }));
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.error).toContain("definition");
  });

  it("creates a new concept as 待验证 with first-seen info", () => {
    const result = mergeConcept(
      undefined,
      input({ name: "mtr", definition: "  写入单位  ", chapter: 7 }),
    );
    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.created).toBe(true);
      expect(result.concept.status).toBe("待验证");
      expect(result.concept.definition).toBe("写入单位");
      expect(result.concept.first).toEqual({
        topic: "MySQL的ACID实现",
        chapter: 7,
        date: "2026-09-22",
      });
    }
  });

  it("updates status only when the definition is omitted", () => {
    const existing = concept({ name: "Read View" });
    const result = mergeConcept(
      existing,
      input({
        name: "Read View",
        status: "已确立",
        evidence: "quiz 第2题答对",
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.created).toBe(false);
      expect(result.concept.definition).toBe(existing.definition);
      expect(result.concept.status).toBe("已确立");
      expect(result.concept.evidence).toBe("quiz 第2题答对");
      expect(result.changed).toContain("状态 待验证→已确立");
      expect(result.concept.revisions).toEqual([]);
    }
  });

  it("keeps the old definition as a revision when it changes", () => {
    const existing = concept({ name: "Read View", definition: "旧定义" });
    const result = mergeConcept(
      existing,
      input({ name: "Read View", definition: "新定义" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.concept.definition).toBe("新定义");
      expect(result.concept.revisions).toEqual([
        { date: "2026-09-22", text: "定义更新（旧）：旧定义" },
      ]);
      expect(result.changed).toContain("定义已更新");
    }
  });

  it("keeps the old prerequisites as a revision when they change", () => {
    const existing = concept({ name: "Read View", requires: ["undo 版本链"] });
    const result = mergeConcept(
      existing,
      input({ name: "Read View", requires: ["undo 版本链", "mtr"] }),
    );
    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.concept.requires).toEqual(["undo 版本链", "mtr"]);
      expect(result.concept.revisions[0].text).toBe(
        "前置更新（旧）：undo 版本链",
      );
    }
  });

  it("marks a regression and rewrites the evidence when narrowing back", () => {
    const existing = concept({
      name: "Read View",
      status: "已确立",
      evidence: "quiz 答对",
    });
    const result = mergeConcept(
      existing,
      input({ name: "Read View", status: "缺口" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.changed).toContain("状态 已确立→缺口（回退）");
      expect(result.concept.evidence).toContain("回退");
    }
  });

  it("unions aliases and rejects invalid names/statuses", () => {
    const existing = concept({ name: "幻读", aliases: ["phantom"] });
    const merged = mergeConcept(
      existing,
      input({ name: "幻读", aliases: ["P3"] }),
    );
    expect(merged.ok).toBe(true);
    if (merged.ok === true)
      expect(merged.concept.aliases).toEqual(["phantom", "P3"]);

    expect(mergeConcept(existing, input({ name: "a|b" })).ok).toBe(false);
    expect(
      mergeConcept(existing, input({ name: "幻读", status: "nope" as never }))
        .ok,
    ).toBe(false);
  });

  it("finds concepts by alias, case and spacing", () => {
    const concepts = [concept({ name: "Read View", aliases: ["RV"] })];
    expect(findConcept(concepts, "rv")?.name).toBe("Read View");
    expect(findConcept(concepts, "readview")?.name).toBe("Read View");
    expect(findConcept(concepts, "next-key lock")).toBeUndefined();
  });
});

describe("concepts-core / 检查与前置", () => {
  const concepts = [
    concept({ name: "Read View", status: "已确立" }),
    concept({ name: "undo 版本链", status: "待验证", requires: ["undo 页"] }),
    concept({ name: "undo 页", status: "缺口" }),
    concept({ name: "mtr", status: "缺口" }),
  ];

  it("classifies terms into four buckets", () => {
    const verdicts = classifyTerms(concepts, [
      "Read View",
      "undo 版本链",
      "mtr",
      "purge",
    ]);
    expect(verdicts.map((verdict) => verdict.kind)).toEqual([
      "已确立",
      "待验证",
      "缺口",
      "未登记",
    ]);
  });

  it("reports missing, gap and unverified prerequisites transitively", () => {
    const problems = prereqProblems(concepts, [
      findConcept(concepts, "undo 版本链") as Concept,
    ]);
    expect(problems).toEqual([
      {
        concept: "undo 版本链",
        missing: [],
        gap: ["undo 页"],
        unverified: [],
      },
    ]);
  });

  it("does not hang on prerequisite cycles", () => {
    const cycle = [
      concept({ name: "A", status: "缺口", requires: ["B"] }),
      concept({ name: "B", status: "缺口", requires: ["A"] }),
    ];
    const problems = prereqProblems(cycle, [cycle[0]]);
    expect(problems).toHaveLength(1);
    expect(problems[0].gap).toEqual(["B"]);
  });

  it("renders a report that says what to do next", () => {
    const text = renderCheckReport(
      buildCheckReport(concepts, ["Read View", "mtr", "purge"]),
    );
    expect(text).toContain("概念检查（3 个术语）");
    expect(text).toContain("已确立（1）：Read View");
    expect(text).toContain("缺口（1）：mtr —— 先补它，再讲本节点");
    expect(text).toContain("未登记（1）：purge");
  });
});

describe("concepts-core / 候选术语提取", () => {
  const markdown = [
    "**Read View** 决定可见性，`mtr` 是写入单位，mtr 还会出现在别处。",
    "",
    "「快照读」与「当前读」是两种读：快照读不加锁，当前读加锁。",
    "",
    "```go",
    "// `fake` 出现在围栏里，不算",
    "```",
    "",
    "看 `btr_cur_upd_lock_and_undo` 与 `row0upd.cc:2988`，还有 `UPDATE`。",
    "",
    "Read View 在别处再提一次。",
  ].join("\n");

  it("counts latin terms on word boundaries only", () => {
    expect(countOccurrences("undo 与 undo_page 与 undo", "undo")).toBe(2);
    expect(countOccurrences("快照读、当前读、快照读", "快照读")).toBe(2);
  });

  it("extracts marked tokens and known terms, skipping code shapes and fences", () => {
    const mentions = extractTermMentions(markdown, [
      concept({ name: "Read View" }),
    ]);
    const byTerm = new Map(mentions.map((mention) => [mention.term, mention]));
    expect(byTerm.get("Read View")).toMatchObject({ count: 2, marked: true });
    expect(byTerm.get("mtr")).toMatchObject({ count: 2, marked: true });
    expect(byTerm.get("快照读")).toMatchObject({ marked: true, code: false });
    expect(byTerm.get("btr_cur_upd_lock_and_undo")).toMatchObject({
      code: true,
    });
    expect(byTerm.get("row0upd.cc:2988")).toMatchObject({ code: true });
    expect(byTerm.get("UPDATE")?.code).toBe(true);
    expect(byTerm.has("fake")).toBe(false);
  });

  it("drops emphasis-only spans and code-shaped tokens", () => {
    const noisy = [
      "这一章**没有**讲**还在干活**的事。",
      "「可能」「需要」「之前」都是虚词。",
      "看 `age` 与 `t1` 与 `orders` 这三张表的例子。",
      "`ip link add veth0 type veth peer name veth1` 和 `-p 8080:80` 都不是术语。",
      "「快照读」「快照读」是真术语。",
    ].join("\n");
    const terms = extractTermMentions(noisy).map((mention) => mention.term);
    expect(terms).toContain("快照读");
    for (const noise of [
      "没有",
      "还在干活",
      "可能",
      "需要",
      "之前",
      "age",
      "t1",
      "orders",
    ]) {
      expect(terms, noise).not.toContain(noise);
    }
    // 命令行选项/整条命令属于代码符号：不进「未登记」，只进「跳过」。
    const report = auditConcepts({ markdown: noisy, concepts: [], limit: 10 });
    const unregistered = report.unregistered.map((mention) => mention.term);
    expect(unregistered).toEqual(["快照读"]);
    expect(report.skipped.map((mention) => mention.term)).toContain(
      "-p 8080:80",
    );
  });

  it("audits a chapter into unregistered / pending / established / skipped", () => {
    const report = auditConcepts({
      markdown,
      concepts: [
        concept({ name: "Read View", status: "已确立" }),
        concept({ name: "快照读", status: "缺口" }),
      ],
    });
    expect(report.unregistered.map((mention) => mention.term)).toEqual([
      "mtr",
      "当前读",
    ]);
    expect(report.pending.map((item) => item.concept.status)).toEqual(["缺口"]);
    expect(report.established.map((item) => item.concept.name)).toEqual([
      "Read View",
    ]);
    expect(report.skipped.map((mention) => mention.term)).toContain(
      "row0upd.cc:2988",
    );
  });

  it("ignores registered concepts that do not appear in this note", () => {
    const report = auditConcepts({
      markdown: "本章只讲 `gap lock` 一件事，gap lock 再说一次。",
      concepts: [
        concept({ name: "gap lock", status: "已确立" }),
        concept({ name: "MVCC", status: "缺口" }),
      ],
    });
    expect(report.established.map((item) => item.concept.name)).toEqual([
      "gap lock",
    ]);
    expect(report.pending).toEqual([]);
  });

  it("reports one row per concept even when aliases are used in the note", () => {
    const report = auditConcepts({
      markdown:
        "**Read View** 讲一次，Read View 再讲一次，Read View 第三次，`RV` 一次。",
      concepts: [
        concept({ name: "Read View", aliases: ["RV"], status: "已确立" }),
      ],
    });
    expect(report.established).toHaveLength(1);
    expect(report.established[0].mention.term).toBe("Read View");
    expect(report.established[0].mention.count).toBe(3);
  });

  it("caps the unregistered list and says how many were folded", () => {
    const terms = ["间隙锁", "谓词", "版本链", "坏页", "排他锁"];
    const many = terms
      .map((term) => `**${term}** 出现在这里，${term} 又一次。`)
      .join("\n\n");
    const report = auditConcepts({ markdown: many, concepts: [], limit: 2 });
    expect(report.unregistered).toHaveLength(2);
    expect(report.truncatedCount).toBe(3);
    expect(renderAuditReport(report, "第8章 · 幻读辨析")).toContain(
      "另有 3 个未列出",
    );
  });
});

describe("concepts-core / 主题视图", () => {
  const concepts = [
    concept({ name: "Read View", status: "已确立" }),
    concept({ name: "mtr", status: "缺口" }),
    concept({ name: "undo 版本链", status: "待验证", requires: ["mtr"] }),
    concept({
      name: "next-key lock",
      status: "已确立",
      first: { topic: "MySQL锁原理与实现", chapter: 1, date: "2026-09-22" },
    }),
  ];

  it("summarizes the topic's concepts and unmet prerequisites", () => {
    const state = topicConceptState(concepts, "MySQL的ACID实现");
    expect(state).toEqual({
      total: 3,
      established: 1,
      unverified: ["undo 版本链"],
      gaps: ["mtr"],
      // mtr 是 undo 版本链 的前置，而且它自己还是缺口 → 前置未确立里也要出现
      missingPrereqs: ["mtr"],
    });
  });

  it("lists a prerequisite that lives in another topic as a gap", () => {
    const withCross = [
      ...concepts,
      concept({ name: "幻读", status: "已确立", requires: ["next-key lock"] }),
    ];
    const state = topicConceptState(withCross, "MySQL的ACID实现");
    // next-key lock 自己已确立（在锁主题学的），所以这里不算前置未确立；mtr 仍是缺口。
    expect(state.missingPrereqs).toEqual(["mtr"]);
    const line = renderTopicConceptLine(
      topicConceptState(
        withCross.map((item) =>
          item.name === "next-key lock" ? { ...item, status: "缺口" } : item,
        ),
        "MySQL的ACID实现",
      ),
    );
    expect(line).toContain("缺口 mtr");
    expect(line).toContain("前置未确立 mtr、next-key lock");
  });

  it("says so when the topic has no concepts yet", () => {
    const line = renderTopicConceptLine(topicConceptState([], "新主题"));
    expect(line).toContain("无");
  });
});

describe("concepts-core / 主题目录里的概念表", () => {
  it("assembles <vault>/<topDir>/<topic>/概念.md", () => {
    expect(
      topicConceptPath({
        vaultRoot: "/v/notes/",
        topDir: "Learn",
        topic: "Docker实现",
      }),
    ).toBe("/v/notes/Learn/Docker实现/概念.md");
    expect(isConceptTableName(CONCEPTS_FILE_NAME)).toBe(true);
    expect(isConceptTableName("Docker实现.md")).toBe(false);
    expect(isReservedTopicName("概念")).toBe(true);
    expect(isReservedTopicName("Docker实现")).toBe(false);
  });

  it("maps names and aliases to their home topic", () => {
    const homes = homeTopicIndex([
      {
        topic: "MySQL的ACID实现",
        concept: concept({ name: "Read View", aliases: ["RV"] }),
      },
      {
        topic: "Docker实现",
        concept: concept({ name: "cgroup v2", aliases: ["cgroup"] }),
      },
    ]);
    expect(conceptHome(homes, "read view")).toBe("MySQL的ACID实现");
    expect(conceptHome(homes, "rv")).toBe("MySQL的ACID实现");
    expect(conceptHome(homes, "CGROUP")).toBe("Docker实现");
    expect(conceptHome(homes, "purge")).toBeUndefined();
  });

  it("renders prerequisites as in-file links or cross-topic path links", () => {
    const entry = concept({
      name: "当前读",
      requires: ["Read View", "undo 版本链"],
    });
    const homes = homeTopicIndex([
      { topic: "MySQL的ACID实现", concept: concept({ name: "Read View" }) },
      { topic: "MySQL的ACID实现", concept: concept({ name: "undo 版本链" }) },
    ]);
    // 同主题（或不知道家在哪）：文件内链接
    expect(renderConceptEntry(entry)).toContain(
      "- 前置：[[#Read View|Read View]]、[[#undo 版本链|undo 版本链]]",
    );
    expect(renderConceptEntry(entry, homes)).toContain(
      "- 前置：[[#Read View|Read View]]、[[#undo 版本链|undo 版本链]]",
    );
    // 家在别的主题：带路径链接
    const crossHomes = homeTopicIndex([
      { topic: "Docker实现", concept: concept({ name: "Read View" }) },
    ]);
    const rendered = renderConceptEntry(entry, crossHomes);
    expect(rendered).toContain("[[Docker实现/概念#Read View|Read View]]");
    expect(rendered).toContain("[[#undo 版本链|undo 版本链]]");
  });

  it("parses cross-topic path links back into plain names", () => {
    const parsed = parseRegistry(
      [
        "### 当前读",
        "",
        "- 状态：待验证",
        "- 一句话定义：加锁的读。",
        "- 前置：[[Docker实现/概念#Read View|Read View]]、[[#gap lock|gap lock]]",
        "- 首次：MySQL的ACID实现 · 第4章 · 2026-09-22",
        "",
      ].join("\n"),
    );
    expect(parsed[0].requires).toEqual(["Read View", "gap lock"]);
  });
});
