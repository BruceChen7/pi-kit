/**
 * concepts-store — 概念表的 IO 与事件接线（Imperative Shell）。
 *
 * 职责边界：
 * - 唯一落盘出口：`<vaultRoot>/<topDir>/概念.md`（与主题目录并列，不是主题里的一章——
 *   放进主题目录会被 scanChapters 当成章节）。
 * - 判定与文本全在 concepts-core：这里只做读、写、参数校验后的 DTO 拼装。
 *
 * 工具与命令：
 * - `note_concept`：登记/更新一个概念（定义、为什么、前置、出处、状态、修订）。
 * - `check_concepts`：术语模式（讲之前问「这几个现在能用吗」）/ 扫章模式
 *   （收章或回填时问「这章有漏网的吗」）。
 * - `/concepts [术语]`：人查概念表（概况 / 单条）。
 *
 * 依赖方向：notes-store / topic-status → concepts-store → { concepts-core, notes-core,
 * settings-store, topic-store }（无环；章节清单走 topic-store 的唯一规则，不回依赖 notes-store）。
 */

import fs from "node:fs";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  auditConcepts,
  buildCheckReport,
  CONCEPT_STATUSES,
  CONCEPTS_BASENAME,
  type Concept,
  type ConceptHome,
  type ConceptStatus,
  conceptHome,
  findConcept,
  formatLocalDate,
  homeTopicIndex,
  isConceptStatus,
  isReservedTopicName,
  isValidConceptName,
  matchChapter,
  mergeConcept,
  parseRegistry,
  renderAuditReport,
  renderCheckReport,
  renderConceptResult,
  renderRegistrySkeleton,
  renderTopicConceptLine,
  summarizeRegistry,
  type TopicConceptState,
  topicConceptPath,
  topicConceptState,
  upsertConceptEntry,
  upsertConceptIndex,
} from "./concepts-core.ts";
import { CHECK_CONCEPTS_TOOL_NAME, NOTE_CONCEPT_TOOL_NAME } from "./names.ts";
import {
  parseChapterRef,
  type TutorSettings,
  topicDirPath,
} from "./notes-core.ts";
import { resolveSettings } from "./settings-store.ts";
import { scanChapters } from "./topic-store.ts";

/** `<vault>/<topDir>/<主题>/概念.md`：一个主题一份。 */
export const registryPath = (settings: TutorSettings, topic: string): string =>
  topicConceptPath({
    vaultRoot: settings.vaultRoot,
    topDir: settings.topDir,
    topic,
  });

/** 主题的概念缺口（跨主题取并集判定，家在别的主题的也算）。 */
export const topicConceptStateFor = (
  settings: TutorSettings,
  topic: string,
): TopicConceptState =>
  topicConceptState(
    loadRegistries(settings).homes.map((home) => home.concept),
    topic.trim(),
  );

/** 同一份状态渲染成一行（简报用；「主题的概念缺口」只此一处定义）。 */
export const conceptLineFor = (
  settings: TutorSettings,
  topic: string,
): string => renderTopicConceptLine(topicConceptStateFor(settings, topic));

export type ConceptRegistry = {
  topic: string;
  path: string;
  exists: boolean;
  markdown: string;
  concepts: Concept[];
};

/** 读一个主题的概念表；文件不存在时回报骨架（不落盘——只有写操作才造文件）。 */
export const loadRegistry = (
  settings: TutorSettings,
  topic: string,
): ConceptRegistry => {
  const name = topic.trim();
  const file = registryPath(settings, name);
  if (!fs.existsSync(file)) {
    return {
      topic: name,
      path: file,
      exists: false,
      markdown: "",
      concepts: [],
    };
  }
  const markdown = fs.readFileSync(file, "utf-8");
  return {
    topic: name,
    path: file,
    exists: true,
    markdown,
    concepts: parseRegistry(markdown),
  };
};

export type ConceptRegistries = {
  /** 所有主题表里的条目 + 它的家（判定用的并集）。 */
  homes: ConceptHome[];
  /** 主题 → 它那份表（含存在与否）。 */
  byTopic: Map<string, ConceptRegistry>;
};

/** 扫 `<topDir>` 下每个主题的 `概念.md`：概念表是全局判定口径（跨主题复用就靠它）。 */
export const loadRegistries = (settings: TutorSettings): ConceptRegistries => {
  const root = path.join(settings.vaultRoot, settings.topDir);
  const byTopic = new Map<string, ConceptRegistry>();
  const homes: ConceptHome[] = [];
  if (fs.existsSync(root)) {
    const topics = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "_archive")
      .map((entry) => entry.name)
      .sort();
    for (const topic of topics) {
      const registry = loadRegistry(settings, topic);
      if (!registry.exists) continue;
      byTopic.set(topic, registry);
      for (const concept of registry.concepts) {
        homes.push({ topic, concept });
      }
    }
  }
  return { homes, byTopic };
};

const writeRegistry = (registry: ConceptRegistry, markdown: string): void => {
  fs.mkdirSync(path.dirname(registry.path), { recursive: true });
  fs.writeFileSync(registry.path, markdown, "utf-8");
};

export type ScannedChapter = {
  number?: number;
  name: string;
  file: string;
  markdown: string;
};

/**
 * 扫主题目录里的章节文件（编号 + 名字排序）。
 * 「什么算章节」不在这里重写：走 topic-store 的 `scanChapters`（索引页与概念表都不算）。
 */
export const scanTopicChapters = (
  settings: TutorSettings,
  topic: string,
): ScannedChapter[] =>
  scanChapters(topicDirPath({ ...settings, topic }), topic.trim())
    .map((item) => ({
      number: item.chapter.number,
      name: item.chapter.name,
      file: item.file,
      markdown: item.markdown,
    }))
    .sort(
      (a, b) =>
        (a.number ?? Number.MAX_SAFE_INTEGER) -
          (b.number ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name),
    );

export type ConceptToolResult = {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
  isError: boolean;
};

const ok = (
  text: string,
  details: Record<string, unknown>,
): ConceptToolResult => ({
  content: [{ type: "text", text }],
  details,
  isError: false,
});

const fail = (text: string): ConceptToolResult => ({
  content: [{ type: "text", text }],
  details: {},
  isError: true,
});

// ── note_concept（工具主体，导出以便集成测直接打真实文件系统） ──────────

export type NoteConceptParams = {
  name: string;
  definition?: string;
  why?: string;
  requires?: string[];
  source?: string;
  aliases?: string[];
  topic: string;
  chapter?: number;
  status?: string;
  evidence?: string;
  revision?: string;
};

export const noteConcept = (
  settings: TutorSettings,
  params: NoteConceptParams,
  date: string,
): ConceptToolResult => {
  const nameCheck = isValidConceptName(params.name);
  if (nameCheck.ok === false) {
    return fail(
      `concept name invalid (${nameCheck.reason}) — spaces and case are fine; | # [ ] · 、 and newlines are not`,
    );
  }
  const status = params.status;
  if (status !== undefined && !isConceptStatus(status)) {
    return fail(
      `unknown status "${status}" — use one of ${CONCEPT_STATUSES.join(" / ")}`,
    );
  }
  const requestedTopic = params.topic.trim();
  if (!requestedTopic) return fail("topic must not be empty");
  if (isReservedTopicName(requestedTopic)) {
    return fail(
      `topic "${requestedTopic}" collides with the concept table file name (概念.md) — rename the topic`,
    );
  }

  const registries = loadRegistries(settings);
  const union = registries.homes.map((home) => home.concept);
  const existing = findConcept(union, nameCheck.name);
  // 一个概念只有一个家：已登记的名字写回家所在的那份表，不在本主题造副本。
  const homes = homeTopicIndex(registries.homes);
  const home =
    existing === undefined
      ? requestedTopic
      : (conceptHome(homes, existing.name) ?? requestedTopic);
  const merged = mergeConcept(existing, {
    name: nameCheck.name,
    definition: params.definition,
    why: params.why,
    requires: params.requires,
    source: params.source,
    aliases: params.aliases,
    topic: existing?.first.topic ?? requestedTopic,
    chapter: existing?.first.chapter ?? params.chapter,
    date,
    status: status as ConceptStatus | undefined,
    evidence: params.evidence,
    revision: params.revision,
  });
  if (merged.ok === false) {
    return fail(
      `${merged.error} — pass e.g. { name: "${nameCheck.name}", definition: "一句话定义", topic: "${params.topic}" }`,
    );
  }

  const registry: ConceptRegistry =
    registries.byTopic.get(home) ?? loadRegistry(settings, home);
  const concepts = [
    ...registry.concepts.filter((item) => item !== existing),
    merged.concept,
  ];
  const base = registry.exists
    ? registry.markdown
    : renderRegistrySkeleton(home);
  const next = upsertConceptEntry(
    upsertConceptIndex(base, concepts),
    merged.concept,
    homes,
  );
  writeRegistry(registry, next);

  const text = renderConceptResult(
    {
      concept: merged.concept,
      created: merged.created,
      changed: merged.changed,
    },
    concepts,
  );
  const homeLine =
    home === requestedTopic
      ? ""
      : `\n家在《${home}》：定义不重复，状态写回那一份。本主题要引用时用 [[${home}/${CONCEPTS_BASENAME}#${merged.concept.name}|${merged.concept.name}]]。`;
  return ok(
    `${text}${homeLine}\n概念表：${registry.path}（本主题已登记 ${concepts.length} 条）`,
    {
      path: registry.path,
      topic: registry.topic,
      home,
      name: merged.concept.name,
      created: merged.created,
      changed: merged.changed,
      status: merged.concept.status,
      requires: merged.concept.requires,
      total: concepts.length,
    },
  );
};

// ── check_concepts（两个模式，导出以便集成测） ─────────────────────────

export type CheckConceptsParams = {
  terms?: string[];
  topic?: string;
  chapter?: string;
  limit?: number;
};

export const checkConcepts = (
  settings: TutorSettings,
  params: CheckConceptsParams,
): ConceptToolResult => {
  const hasTerms = Array.isArray(params.terms) && params.terms.length > 0;
  const hasTopic = Boolean(params.topic?.trim());
  if (hasTerms && hasTopic) {
    return fail(
      "pass either `terms` (before teaching) or `topic`+`chapter` (chapter sweep), not both",
    );
  }
  const registries = loadRegistries(settings);
  const union = registries.homes.map((home) => home.concept);
  const tableList = [...registries.byTopic.keys()].join("、");

  if (hasTerms) {
    const report = buildCheckReport(
      union,
      (params.terms ?? []).map((term) => term.trim()).filter(Boolean),
    );
    return ok(
      `${renderCheckReport(report)}\n概念表：${registries.homes.length} 条，分居 ${registries.byTopic.size} 份（${tableList || "尚未建"}）`,
      {
        mode: "terms",
        topics: [...registries.byTopic.keys()],
        verdicts: report.verdicts.map((verdict) => ({
          term: verdict.term,
          kind: verdict.kind,
        })),
        problems: report.problems,
      },
    );
  }

  if (!hasTopic) {
    return fail(
      "pass `terms` (before teaching a node) or `topic` (+ optional `chapter`, to sweep a note)",
    );
  }

  const topic = (params.topic ?? "").trim();
  const chapters = scanTopicChapters(settings, topic);
  if (chapters.length === 0) {
    return fail(
      `topic "${topic}" has no chapter files at ${topicDirPath({ ...settings, topic })} — check the topic name`,
    );
  }
  let selected = chapters;
  let label = `《${topic}》全部 ${chapters.length} 章`;
  if (params.chapter?.trim()) {
    const match = matchChapter(chapters, parseChapterRef(params.chapter));
    if (!match) {
      return fail(
        `chapter "${params.chapter}" not found in 《${topic}》 — available: ${chapters
          .map((chapter) => `第${chapter.number}章 · ${chapter.name}`)
          .join("、")}`,
      );
    }
    selected = [match];
    label = `《${topic}》第${match.number}章 · ${match.name}`;
  }
  const report = auditConcepts({
    markdown: selected.map((chapter) => chapter.markdown).join("\n\n"),
    concepts: union,
    limit: params.limit,
  });
  const ownTable = registryPath(settings, topic);
  const ownLine = fs.existsSync(ownTable)
    ? `本主题概念表：${ownTable}`
    : `本主题还没有概念表（note_concept 会建 ${ownTable}）`;
  return ok(
    `${renderAuditReport(report, label)}\n${ownLine}；全库 ${registries.homes.length} 条 / ${registries.byTopic.size} 份`,
    {
      mode: "sweep",
      table: ownTable,
      topic,
      chapters: selected.map((chapter) => chapter.name),
      unregistered: report.unregistered.map((mention) => mention.term),
      pending: report.pending.map((item) => item.concept.name),
      established: report.established.map((item) => item.concept.name),
      skipped: report.skipped.map((mention) => mention.term),
      truncatedCount: report.truncatedCount,
    },
  );
};

// ── /concepts：人查概念表（概况 / 单条） ────────────────────────────────

export const describeConcepts = (
  settings: TutorSettings,
  arg: string,
): { text: string; level: "info" | "warning" } => {
  const registries = loadRegistries(settings);
  if (registries.byTopic.size === 0) {
    return {
      text: `概念表还没建：${registryPath(settings, "<主题>")}（讲课时 note_concept 会自动创建）`,
      level: "info",
    };
  }
  const term = arg.trim();
  if (!term) {
    // 按主题一行：概念表下沉到主题目录后，人一眼就能看到「哪个主题学到哪」。
    const lines = [...registries.byTopic.entries()].map(([topic, registry]) => {
      const summary = summarizeRegistry(registry.concepts);
      const gap =
        summary.gaps.length > 0 ? `｜缺口 ${summary.gaps.join("、")}` : "";
      return `${topic}：${summary.total} 条（已确立 ${summary.established} / 待验证 ${summary.unverified}）${gap}`;
    });
    const total = registries.homes.length;
    return {
      text: [`概念表共 ${total} 条`, ...lines].join("\n"),
      level: "info",
    };
  }
  const concept = findConcept(
    registries.homes.map((home) => home.concept),
    term,
  );
  if (!concept) {
    return {
      text: `未登记：「${term}」——讲课时用 note_concept 补上（写进当前主题的 概念.md）`,
      level: "warning",
    };
  }
  const home = conceptHome(homeTopicIndex(registries.homes), concept.name);
  return {
    text: [
      `${concept.name}（${concept.status}${home ? `｜家在 ${home}` : ""}）`,
      concept.definition,
      concept.requires.length > 0
        ? `前置：${concept.requires.join("、")}`
        : undefined,
      concept.source ? `出处：${concept.source}` : undefined,
    ]
      .filter((line): line is string => Boolean(line))
      .join("｜"),
    level: "info",
  };
};

// ── 注册 ───────────────────────────────────────────────────────────────

const statusEnum = Type.Union([
  Type.Literal("缺口"),
  Type.Literal("待验证"),
  Type.Literal("已确立"),
]);

const noteConceptParams = Type.Object({
  name: Type.String({
    description:
      "Concept name as the learner will hear it (`Read View`, `next-key lock`, `undo 版本链`). Spaces and case are fine; `| # [ ] · 、` are not.",
  }),
  definition: Type.Optional(
    Type.String({
      description:
        "ONE sentence, in Chinese, that a newcomer could use to answer 「这是什么」. Required for a new concept; omit to only update status/prerequisites.",
    }),
  ),
  why: Type.Optional(
    Type.String({
      description:
        "One sentence: what problem forces this concept to exist (so it does not feel arbitrary).",
    }),
  ),
  requires: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Names of concepts this one rests on. The tool reports any prerequisite that is unregistered or not yet established — teach those first.",
    }),
  ),
  source: Type.Optional(
    Type.String({
      description:
        "Where the definition is grounded (doc, source file, chapter).",
    }),
  ),
  aliases: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Other spellings the learner may meet (`RV`, `A3`). Matching ignores case and spacing.",
    }),
  ),
  topic: Type.String({
    description:
      "Topic this concept belongs to (the Learn/<topic> directory name). Pass it explicitly — a concept may be recorded while another topic is bound.",
  }),
  chapter: Type.Optional(
    Type.Number({
      description: "Chapter number where the concept first appeared.",
    }),
  ),
  status: Type.Optional(statusEnum),
  evidence: Type.Optional(
    Type.String({
      description:
        "Why the status is what it is (`quiz 第2题答对`, `用户说没听过`). Replaces the previous evidence.",
    }),
  ),
  revision: Type.Optional(
    Type.String({
      description:
        "Explicit revision note appended to the entry (definition/prerequisite changes are recorded automatically).",
    }),
  ),
});

const checkConceptsParams = Type.Object({
  terms: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Terms you are about to use in a node. Returns 已确立 / 待验证 / 缺口 / 未登记 plus unmet prerequisites. Use this BEFORE teaching.",
    }),
  ),
  topic: Type.Optional(
    Type.String({
      description:
        "Topic to sweep after a chapter (or for backfill). Pass `chapter` to sweep one chapter, omit it to sweep every chapter of the topic.",
    }),
  ),
  chapter: Type.Optional(
    Type.String({
      description:
        "Chapter reference: `第8章`, `08-幻读辨析` or `幻读辨析`. Only meaningful together with `topic`.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Max unregistered terms to list (default 30).",
    }),
  ),
});

export const registerConcepts = (pi: ExtensionAPI): void => {
  pi.registerTool({
    name: NOTE_CONCEPT_TOOL_NAME,
    label: "Note Concept",
    description:
      "Record or update ONE concept in the shared concept table (`<vault>/<topDir>/概念.md`), the newcomer's lookup surface for this vault. " +
      "Call it the first time a term is introduced: name + one-line definition + why it exists + prerequisites + source; the status stays `待验证` until a quiz confirms it (`已确立`) or a miss/「不知道」marks it (`缺口`). " +
      "Omit `definition` to only update status/prerequisites. It answers with any prerequisite that is still unregistered or not established — teach those first.",
    parameters: noteConceptParams,
    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      ctx: ExtensionContext,
    ) {
      const settings = resolveSettings({ cwd: ctx.cwd });
      return noteConcept(settings, params, formatLocalDate(new Date()));
    },
  });

  pi.registerTool({
    name: CHECK_CONCEPTS_TOOL_NAME,
    label: "Check Concepts",
    description:
      "Check the concept table in two modes. " +
      "Before teaching a node: pass `terms` — you get 已确立 / 待验证 / 缺口 / 未登记 per term plus unmet prerequisites, so you can close the gaps first. " +
      "After a chapter (or when backfilling an old topic): pass `topic` (+ optional `chapter`) — it sweeps the note for jargon that was never registered (marked terms like `` `mtr` ``, `**Read View**`, 「快照读」), with occurrence counts, skipping code symbols.",
    parameters: checkConceptsParams,
    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      ctx: ExtensionContext,
    ) {
      return checkConcepts(resolveSettings({ cwd: ctx.cwd }), params);
    },
  });

  pi.registerCommand("concepts", {
    description:
      "概念表：无参给概况（总数 / 缺口 / 路径），`/concepts <术语>` 查一条（含别名）",
    handler: async (args, ctx) => {
      const { text, level } = describeConcepts(
        resolveSettings({ cwd: ctx.cwd }),
        args,
      );
      ctx.ui.notify(text, level);
    },
  });
};
