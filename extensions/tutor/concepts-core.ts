/**
 * concepts-core — 概念表的纯函数核（Functional Core）。
 *
 * 解决的问题：笔记里的术语只有上下文、没有可查的一句话定义，也没有「学习者到底会不会」的
 * 状态——于是 Pi 可以整章使用一个从没交代过的概念而没人发现。这里只做判定与文本：
 *
 * - 概念（Concept）的校验、合并（状态机 + 修订留痕）、条目与机器块的渲染/解析；
 * - 术语查询与分桶（已确立 / 待验证 / 缺口 / 未登记）与前置检查；
 * - 从章节 markdown 里提取高信号候选术语（标记符里的术语 + 已登记术语的明文出现）。
 *
 * 不碰 fs、不碰 pi、不读时钟：日期由调用方传入（Shell 负责 IO 与注册工具）。
 */

export type ConceptStatus = "缺口" | "待验证" | "已确立";

/** 展示顺序：已确立 → 待验证 → 缺口（越靠前越可用）。 */
export const CONCEPT_STATUSES: readonly ConceptStatus[] = [
  "已确立",
  "待验证",
  "缺口",
];

export const DEFAULT_CONCEPT_STATUS: ConceptStatus = "待验证";

export const isConceptStatus = (value: unknown): value is ConceptStatus =>
  typeof value === "string" &&
  (CONCEPT_STATUSES as readonly string[]).includes(value);

export type ConceptFirst = {
  /** 首次出现的主题（主题名不带空格，见 notes-core 的校验）。 */
  topic: string;
  /** 首次出现的章节号；没有编号的旧主题缺省。 */
  chapter?: number;
  /** `YYYY-MM-DD`。 */
  date: string;
};

export type ConceptRevision = { date: string; text: string };

export type Concept = {
  name: string;
  aliases: string[];
  definition: string;
  why?: string;
  requires: string[];
  source?: string;
  first: ConceptFirst;
  status: ConceptStatus;
  evidence?: string;
  revisions: ConceptRevision[];
};

export type ConceptInput = {
  name: string;
  /** 新概念必需；已存在时可省略（只改状态/前置）。 */
  definition?: string;
  why?: string;
  requires?: string[];
  source?: string;
  aliases?: string[];
  topic: string;
  chapter?: number;
  date: string;
  status?: ConceptStatus;
  evidence?: string;
  /** 显式修订说明：追加到条目末尾的历史块。 */
  revision?: string;
};

// ── 名字 ────────────────────────────────────────────────────────────────

export const CONCEPT_NAME_MAX_LENGTH = 40;

/** 机器行/wikilink 的分隔符：出现在名字里会让索引行无法解析。 */
const CONCEPT_NAME_FORBIDDEN = ["|", "#", "[", "]", "·", "、"];

export type ConceptNameCheck =
  | { ok: true; name: string }
  | { ok: false; reason: string };

/**
 * 术语名允许空格与大小写（`Read View`、`next-key lock`），但禁止分隔符与换行。
 * 与主题/章节名不同：术语就是给人念的，去空格会毁掉它。
 */
export const isValidConceptName = (name: string): ConceptNameCheck => {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  if (/[\n\r]/.test(name)) return { ok: false, reason: "newline" };
  for (const char of CONCEPT_NAME_FORBIDDEN) {
    if (trimmed.includes(char)) {
      return { ok: false, reason: `forbidden-character:${char}` };
    }
  }
  if (trimmed.length > CONCEPT_NAME_MAX_LENGTH) {
    return { ok: false, reason: "too-long" };
  }
  return { ok: true, name: trimmed };
};

/**
 * 匹配键：压空白、去大小写、去掉 `-_·()（）` 这些写法差异——
 * `Read View` / `read view` / `read-view` / `readview` 是同一个概念。
 */
export const normalizeConceptKey = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[\s\-_·()（）]/g, "");

/** 确定性比较：不依赖 locale，测试在任何机器上结果一致。 */
const cmpText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const conceptOrder = (a: Concept, b: Concept): number =>
  cmpText(a.first.topic, b.first.topic) ||
  (a.first.chapter ?? 0) - (b.first.chapter ?? 0) ||
  cmpText(a.name, b.name);

// ── 机器块 ──────────────────────────────────────────────────────────────

export const CONCEPTS_HEADING = "## 概念";
export const CONCEPTS_BEGIN =
  "<!-- tutor:concepts 由工具维护：本行与结束行为定界符，块内概念行由 note_concept 重写 -->";
export const CONCEPTS_END = "<!-- /tutor:concepts -->";
export const CONCEPT_ENTRIES_HEADING = "## 术语";

const STATUS_PATTERN = CONCEPT_STATUSES.join("|");
const INDEX_LINE_RE = new RegExp(
  `^>?\\s*-\\s*\\[\\[#([^\\]|]+)(?:\\|([^\\]]+))?\\]\\]\\s*·\\s*(${STATUS_PATTERN})\\s*·\\s*首次：(.+)$`,
);
const FIRST_REF_RE = /^(.*?)(?:\s+第(\d+)章)?$/;

export type ConceptIndexEntry = {
  name: string;
  status: ConceptStatus;
  first: ConceptFirst;
  line: string;
};

/** `首次：<主题>[ 第N章]` → ConceptFirst（日期不在机器行里，读回来时留空）。 */
const parseFirstRef = (ref: string): ConceptFirst => {
  const match = FIRST_REF_RE.exec(ref.trim());
  const topic = (match?.[1] ?? ref).trim();
  const chapter = match?.[2] ? Number(match[2]) : undefined;
  return chapter === undefined
    ? { topic, date: "" }
    : { topic, chapter, date: "" };
};

export const formatFirstRef = (first: ConceptFirst): string =>
  first.chapter === undefined
    ? first.topic
    : `${first.topic} 第${first.chapter}章`;

export const renderConceptIndexLine = (concept: Concept): string =>
  `- [[#${concept.name}|${concept.name}]] · ${concept.status} · 首次：${formatFirstRef(concept.first)}`;

/** 解析机器块（`<!-- tutor:concepts -->` 之间）里的概念行；不认的行原样忽略。 */
export const parseConceptIndex = (markdown: string): ConceptIndexEntry[] => {
  const lines = markdown.split("\n");
  const begin = lines.findIndex((line) => line.trim() === CONCEPTS_BEGIN);
  const end = lines.findIndex((line) => line.trim() === CONCEPTS_END);
  if (begin === -1) return [];
  const stop = end === -1 ? lines.length : end;
  const entries: ConceptIndexEntry[] = [];
  for (const line of lines.slice(begin + 1, stop)) {
    const match = INDEX_LINE_RE.exec(line.trim());
    if (!match) continue;
    entries.push({
      name: (match[2] ?? match[1]).trim(),
      status: match[3] as ConceptStatus,
      first: parseFirstRef(match[4]),
      line,
    });
  }
  return entries;
};

/** 机器块重建：块 = 概念表的派生物，每次落盘都从 Concept[] 重算，不存在两边不一致。 */
export const upsertConceptIndex = (
  markdown: string,
  concepts: Concept[],
): string => {
  const block = [
    CONCEPTS_BEGIN,
    ...[...concepts].sort(conceptOrder).map(renderConceptIndexLine),
    CONCEPTS_END,
  ].join("\n");

  const lines = markdown.split("\n");
  const begin = lines.findIndex((line) => line.trim() === CONCEPTS_BEGIN);
  const end = lines.findIndex((line) => line.trim() === CONCEPTS_END);
  if (begin !== -1 && end !== -1 && end > begin) {
    return [
      ...lines.slice(0, begin),
      ...block.split("\n"),
      ...lines.slice(end + 1),
    ].join("\n");
  }
  // 没有定界符：块插在标题区（`# …`，说明引用行）之后，正文一字不动。
  const insertAt = headerEnd(lines);
  return [
    ...lines.slice(0, insertAt),
    CONCEPTS_HEADING,
    "",
    ...block.split("\n"),
    ...lines.slice(insertAt),
  ].join("\n");
};

/** 标题区之后的位置：`# 标题` + 紧随的 `> …` 说明行；遇 callout（`> [!…]`）就停。 */
const headerEnd = (lines: string[]): number => {
  let i = 0;
  const skipBlank = (): void => {
    while (i < lines.length && lines[i].trim().length === 0) i++;
  };
  skipBlank();
  if (i < lines.length && lines[i].startsWith("# ")) {
    i++;
    skipBlank();
    while (
      i < lines.length &&
      lines[i].startsWith(">") &&
      !/^>\s*\[!/.test(lines[i])
    ) {
      i++;
    }
    skipBlank();
  }
  // 已经存在 ## 概念 标题但块被删：插在标题之后，避免出现第二个标题。
  if (i < lines.length && lines[i].trim() === CONCEPTS_HEADING) {
    i++;
    skipBlank();
  }
  return i;
};

/** 概念表文件名：一个主题一份，**不是章节**（三处扫描都要跳过它）。 */
export const CONCEPTS_FILE_NAME = "概念.md";

/** wikilink 里不带扩展名（`[[主题/概念#名|名]]`）。 */
export const CONCEPTS_BASENAME = CONCEPTS_FILE_NAME.replace(/\.md$/, "");

export const isConceptTableName = (fileName: string): boolean =>
  fileName === CONCEPTS_FILE_NAME;

export type ConceptPathInput = {
  vaultRoot: string;
  topDir: string;
  topic: string;
};

/** `<vaultRoot>/<topDir>/<主题>/概念.md`（vaultRoot 需已展开 `~`）。 */
export const topicConceptPath = (input: ConceptPathInput): string =>
  [
    input.vaultRoot.replace(/\/+$/, ""),
    input.topDir.replace(/^\/+|\/+$/g, ""),
    input.topic.trim(),
    CONCEPTS_FILE_NAME,
  ]
    .filter((part) => part.length > 0)
    .join("/");

/** 主题名恰好叫「概念」时，索引页 `概念/概念.md` 会和概念表撞路径。 */
export const isReservedTopicName = (topic: string): boolean =>
  topic.trim() === CONCEPTS_FILE_NAME.replace(/\.md$/, "");

// ── 条目 ────────────────────────────────────────────────────────────────

export const formatConceptTableHeader = (topic: string): string =>
  `# 概念表 · ${topic}\n\n> 由 tutor 维持（本主题的概念都住在这里）：\`${CONCEPTS_HEADING}\` 机器块由工具重写；术语条目只增不改，定义与前置的变更会以「修订」追加在条目末尾。`;

export const renderRegistrySkeleton = (topic: string): string =>
  [
    formatConceptTableHeader(topic),
    "",
    CONCEPTS_HEADING,
    "",
    CONCEPTS_BEGIN,
    CONCEPTS_END,
    "",
    CONCEPT_ENTRIES_HEADING,
    "",
  ].join("\n");

const FIELD = {
  status: "状态",
  definition: "一句话定义",
  why: "为什么要它",
  requires: "前置",
  source: "出处",
  first: "首次",
  evidence: "依据",
  aliases: "别名",
} as const;

const fieldLine = (label: string, value: string): string =>
  `- ${label}：${value}`;

const oneLine = (text: string): string => text.trim().replace(/\s*\n\s*/g, " ");

/** 前置渲染成 wikilink：读的人能直接点过去，解析时取别名或目标。 */
export const renderConceptRef = (name: string, home?: string): string =>
  home === undefined
    ? `[[#${name}|${name}]]`
    : `[[${home}/${CONCEPTS_BASENAME}#${name}|${name}]]`;

/** 一个概念的家：名字（含别名）→ 主题。 */
export type ConceptHome = { topic: string; concept: Concept };

export const homeTopicIndex = (homes: ConceptHome[]): Map<string, string> => {
  const index = new Map<string, string>();
  for (const { topic, concept } of homes) {
    index.set(normalizeConceptKey(concept.name), topic);
    for (const alias of concept.aliases) {
      index.set(normalizeConceptKey(alias), topic);
    }
  }
  return index;
};

export const conceptHome = (
  homes: Map<string, string>,
  name: string,
): string | undefined => homes.get(normalizeConceptKey(name));

/**
 * 前置链接：家在**同一个主题**（或不知道家在哪）→ 文件内链接；家在**别的主题** → 带路径的
 * 链接（Obsidian 里四份同名 `概念.md` 靠路径消歧，不会跳错表）。
 */
export const renderConceptEntry = (
  concept: Concept,
  homes?: Map<string, string>,
): string => {
  const ownTopic = concept.first.topic;
  const requiresLink = (name: string): string => {
    const home = homes ? conceptHome(homes, name) : undefined;
    return renderConceptRef(
      name,
      home === undefined || home === ownTopic ? undefined : home,
    );
  };
  const lines = [
    `### ${concept.name}`,
    "",
    fieldLine(FIELD.status, concept.status),
    fieldLine(FIELD.definition, oneLine(concept.definition)),
  ];
  if (concept.why) lines.push(fieldLine(FIELD.why, oneLine(concept.why)));
  if (concept.requires.length > 0) {
    lines.push(
      fieldLine(FIELD.requires, concept.requires.map(requiresLink).join("、")),
    );
  }
  if (concept.source)
    lines.push(fieldLine(FIELD.source, oneLine(concept.source)));
  lines.push(
    fieldLine(
      FIELD.first,
      [
        concept.first.topic,
        concept.first.chapter === undefined
          ? undefined
          : `第${concept.first.chapter}章`,
        concept.first.date,
      ]
        .filter((part): part is string => Boolean(part))
        .join(" · "),
    ),
  );
  if (concept.evidence)
    lines.push(fieldLine(FIELD.evidence, oneLine(concept.evidence)));
  if (concept.aliases.length > 0) {
    lines.push(fieldLine(FIELD.aliases, concept.aliases.join("、")));
  }
  if (concept.revisions.length > 0) {
    lines.push("");
    for (const revision of concept.revisions) {
      lines.push(`> [!note] 修订 ${revision.date}`, `> ${revision.text}`);
    }
  }
  return `${lines.join("\n")}\n`;
};

const parseFieldLine = (
  line: string,
): { label: string; value: string } | undefined => {
  const match = /^-\s*([^：:]{1,10})[：:]\s*(.*)$/.exec(line.trim());
  if (!match) return undefined;
  return { label: match[1].trim(), value: match[2].trim() };
};

/** 前置字段里的 wikilink（`[[#名字|别名]]`）与裸名字都还原成名字。 */
/** 别名优先取 `|` 后面那段；带路径的跨主题链接（`[[主题/概念#名|名]]`）取 `#` 后面的名字。 */
const CONCEPT_LINK_RE = /\[\[(?:[^\][|]*?)#([^\][|]+)(?:\|([^\]]+))?\]\]/;
const PLAIN_LINK_RE = /\[\[(?:[^\][|]*\/)?([^\][|]+)(?:\|([^\]]+))?\]\]/;

const parseConceptRefs = (value: string): string[] =>
  value
    .split("、")
    .map((part) => {
      const link = CONCEPT_LINK_RE.exec(part) ?? PLAIN_LINK_RE.exec(part);
      return (link?.[2] ?? link?.[1] ?? part).trim();
    })
    .filter((part) => part.length > 0);

const parseFirstField = (value: string): ConceptFirst => {
  const parts = value.split(" · ").map((part) => part.trim());
  const date = parts.length > 1 ? parts[parts.length - 1] : "";
  const rest = parts.length > 1 ? parts.slice(0, -1) : parts;
  const chapterPart = rest.length > 1 ? rest[rest.length - 1] : undefined;
  const chapterMatch = chapterPart ? /^第(\d+)章$/.exec(chapterPart) : null;
  const topic = (chapterMatch ? rest.slice(0, -1) : rest).join(" · ");
  if (chapterMatch) {
    return { topic, chapter: Number(chapterMatch[1]), date };
  }
  return { topic, date };
};

type EntrySection = { name: string; startLine: number; endLine: number };

/** 条目段：`### <名字>` 到下一个 `## ` / `### ` 之前。 */
const entrySections = (lines: string[]): EntrySection[] => {
  const heads: number[] = [];
  lines.forEach((line, index) => {
    if (/^###\s+/.test(line)) heads.push(index);
  });
  return heads.map((start, position) => {
    const nextHead = heads[position + 1];
    let end = nextHead ?? lines.length;
    for (let i = start + 1; i < end; i++) {
      if (/^##\s+/.test(lines[i])) {
        end = i;
        break;
      }
    }
    return {
      name: lines[start].replace(/^###\s+/, "").trim(),
      startLine: start,
      endLine: end,
    };
  });
};

/** 解析概念表：条目是唯一真相，机器块只是它的视图。 */
export const parseRegistry = (markdown: string): Concept[] => {
  const lines = markdown.split("\n");
  return entrySections(lines).map((section) => {
    const concept: Concept = {
      name: section.name,
      aliases: [],
      definition: "",
      requires: [],
      first: { topic: "", date: "" },
      status: DEFAULT_CONCEPT_STATUS,
      revisions: [],
    };
    const revisions: ConceptRevision[] = [];
    let revisionDate: string | undefined;
    let revisionText: string[] = [];
    const flushRevision = (): void => {
      if (revisionDate) {
        revisions.push({ date: revisionDate, text: revisionText.join(" ") });
      }
      revisionDate = undefined;
      revisionText = [];
    };
    for (const raw of lines.slice(section.startLine + 1, section.endLine)) {
      const line = raw.trim();
      const revisionHead = /^>\s*\[!note\]\s*修订\s*(\S+)/.exec(line);
      if (revisionHead) {
        flushRevision();
        revisionDate = revisionHead[1];
        continue;
      }
      if (line.startsWith(">")) {
        const text = line.replace(/^>\s?/, "").trim();
        if (revisionDate && text.length > 0) revisionText.push(text);
        continue;
      }
      if (/^\[!note\]/.test(line)) continue;
      const field = parseFieldLine(line);
      if (!field) continue;
      switch (field.label) {
        case FIELD.status:
          if (isConceptStatus(field.value)) concept.status = field.value;
          break;
        case FIELD.definition:
          concept.definition = field.value;
          break;
        case FIELD.why:
          concept.why = field.value;
          break;
        case FIELD.requires:
          concept.requires = parseConceptRefs(field.value);
          break;
        case FIELD.source:
          concept.source = field.value;
          break;
        case FIELD.first:
          concept.first = parseFirstField(field.value);
          break;
        case FIELD.evidence:
          concept.evidence = field.value;
          break;
        case FIELD.aliases:
          concept.aliases = field.value
            .split("、")
            .map((alias) => alias.trim())
            .filter((alias) => alias.length > 0);
          break;
        default:
          break;
      }
    }
    flushRevision();
    concept.revisions = revisions;
    return concept;
  });
};

/** 写一个条目：已存在就整段替换（修订块由 concept.revisions 带过去），否则追加到 `## 术语` 之后。 */
export const upsertConceptEntry = (
  markdown: string,
  concept: Concept,
  homes?: Map<string, string>,
): string => {
  const lines = markdown.split("\n");
  const key = normalizeConceptKey(concept.name);
  const section = entrySections(lines).find(
    (item) => normalizeConceptKey(item.name) === key,
  );
  const rendered = renderConceptEntry(concept, homes).replace(/\n$/, "");
  if (section) {
    return [
      ...lines.slice(0, section.startLine),
      ...rendered.split("\n"),
      ...lines.slice(section.endLine),
    ].join("\n");
  }
  const withHeading = lines.some(
    (line) => line.trim() === CONCEPT_ENTRIES_HEADING,
  )
    ? markdown
    : `${markdown.replace(/\n+$/, "")}\n\n${CONCEPT_ENTRIES_HEADING}\n`;
  return `${withHeading.replace(/\n+$/, "")}\n\n${rendered}\n`;
};

// ── 合并（状态机 + 修订留痕） ────────────────────────────────────────────

export type MergeResult =
  | {
      ok: true;
      concept: Concept;
      created: boolean;
      changed: string[];
      warnings: string[];
    }
  | { ok: false; error: string };

export const findConcept = (
  concepts: Concept[],
  term: string,
): Concept | undefined => {
  const key = normalizeConceptKey(term);
  if (key.length === 0) return undefined;
  return concepts.find(
    (concept) =>
      normalizeConceptKey(concept.name) === key ||
      concept.aliases.some((alias) => normalizeConceptKey(alias) === key),
  );
};

const fieldChanged = (next: string | undefined, current: string | undefined) =>
  next !== undefined && next.trim() !== (current ?? "").trim();

const revisionOf = (date: string, text: string): ConceptRevision => ({
  date,
  text,
});

/**
 * 并入一次 `note_concept`：状态取新值，定义/前置变了就把旧值记成修订。
 * 新概念必须有一句话定义——没有定义的概念表条目等于没记。
 */
export const mergeConcept = (
  existing: Concept | undefined,
  input: ConceptInput,
): MergeResult => {
  const check = isValidConceptName(input.name);
  if (check.ok === false) {
    return { ok: false, error: `concept name invalid (${check.reason})` };
  }
  if (input.status !== undefined && !isConceptStatus(input.status)) {
    return { ok: false, error: `unknown status "${input.status}"` };
  }
  const name = check.name;
  const definition =
    input.definition === undefined ? undefined : oneLine(input.definition);
  const why = input.why === undefined ? undefined : oneLine(input.why);
  const source = input.source === undefined ? undefined : oneLine(input.source);
  const warnings: string[] = [];

  if (!existing) {
    if (!definition) {
      return {
        ok: false,
        error: `concept "${name}" is new — a one-line definition is required`,
      };
    }
    const concept: Concept = {
      name,
      aliases: dedupe(input.aliases ?? []),
      definition,
      why,
      requires: dedupe(input.requires ?? []),
      source,
      first: {
        topic: input.topic.trim(),
        chapter: input.chapter,
        date: input.date,
      },
      status: input.status ?? DEFAULT_CONCEPT_STATUS,
      evidence: input.evidence ? oneLine(input.evidence) : undefined,
      revisions: input.revision
        ? [revisionOf(input.date, oneLine(input.revision))]
        : [],
    };
    return { ok: true, concept, created: true, changed: ["新建"], warnings };
  }

  const changed: string[] = [];
  const revisions = [...existing.revisions];
  const concept: Concept = { ...existing, aliases: [...existing.aliases] };

  if (definition !== undefined) concept.definition = definition;
  if (why !== undefined) concept.why = why;
  if (source !== undefined) concept.source = source;

  if (fieldChanged(definition, existing.definition)) {
    changed.push("定义已更新");
    revisions.push(
      revisionOf(input.date, `定义更新（旧）：${existing.definition}`),
    );
  }
  if (input.requires !== undefined) {
    const next = dedupe(input.requires);
    if (next.join("、") !== existing.requires.join("、")) {
      changed.push("前置已更新");
      revisions.push(
        revisionOf(
          input.date,
          `前置更新（旧）：${existing.requires.length > 0 ? existing.requires.join("、") : "(无)"}`,
        ),
      );
    }
    concept.requires = next;
  }
  if (input.aliases !== undefined) {
    concept.aliases = dedupe([...existing.aliases, ...input.aliases]);
  }

  const status = input.status ?? existing.status;
  if (status !== existing.status) {
    const backslide = existing.status === "已确立" && status === "缺口";
    changed.push(
      backslide
        ? `状态 ${existing.status}→${status}（回退）`
        : `状态 ${existing.status}→${status}`,
    );
    concept.evidence = input.evidence
      ? oneLine(input.evidence)
      : backslide
        ? `回退：曾为已确立（${existing.evidence ?? "无依据记录"}），${input.date} 再次未通过`
        : undefined;
  } else if (input.evidence !== undefined) {
    concept.evidence = oneLine(input.evidence);
  }
  concept.status = status;

  if (input.revision) {
    changed.push("修订已追加");
    revisions.push(revisionOf(input.date, oneLine(input.revision)));
  }
  concept.revisions = revisions;

  if (changed.length === 0) changed.push("无变化");
  return { ok: true, concept, created: false, changed, warnings };
};

const dedupe = (values: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    const key = normalizeConceptKey(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
};

// ── 检查 ────────────────────────────────────────────────────────────────

export type TermKind = "已确立" | "待验证" | "缺口" | "未登记";

export type TermVerdict = {
  /** 调用方给的原始写法。 */
  term: string;
  kind: TermKind;
  concept?: Concept;
};

export const classifyTerms = (
  concepts: Concept[],
  terms: string[],
): TermVerdict[] =>
  terms.map((term) => {
    const concept = findConcept(concepts, term);
    return concept
      ? { term, kind: concept.status, concept }
      : { term, kind: "未登记" };
  });

export type PrereqProblem = {
  /** 用到的概念名。 */
  concept: string;
  /** 前置里根本没登记的名字（阻断）。 */
  missing: string[];
  /** 前置登记了但状态是缺口（阻断）。 */
  gap: string[];
  /** 前置登记了但还没验证（软警告）。 */
  unverified: string[];
};

/** 用到的概念的（传递）前置是否确立；缺失/缺口算阻断，待验证算软警告。 */
export const prereqProblems = (
  concepts: Concept[],
  used: Concept[],
): PrereqProblem[] => {
  const problems: PrereqProblem[] = [];
  for (const concept of used) {
    const missing = new Set<string>();
    const gap = new Set<string>();
    const unverified = new Set<string>();
    const visited = new Set<string>([normalizeConceptKey(concept.name)]);
    const walk = (names: string[]): void => {
      for (const name of names) {
        const key = normalizeConceptKey(name);
        if (visited.has(key)) continue;
        visited.add(key);
        const prereq = findConcept(concepts, name);
        if (!prereq) {
          missing.add(name);
          continue;
        }
        if (prereq.status === "已确立") continue;
        if (prereq.status === "缺口") gap.add(prereq.name);
        else unverified.add(prereq.name);
        // 未验证的前置继续向下看：链上任何一环缺失都要报出来。
        walk(prereq.requires);
      }
    };
    walk(concept.requires);
    if (missing.size === 0 && gap.size === 0 && unverified.size === 0) continue;
    problems.push({
      concept: concept.name,
      missing: [...missing],
      gap: [...gap],
      unverified: [...unverified],
    });
  }
  return problems;
};

export type CheckReport = {
  verdicts: TermVerdict[];
  problems: PrereqProblem[];
};

export const buildCheckReport = (
  concepts: Concept[],
  terms: string[],
): CheckReport => {
  const verdicts = classifyTerms(concepts, terms);
  const used = verdicts.flatMap((verdict) =>
    verdict.concept ? [verdict.concept] : [],
  );
  return { verdicts, problems: prereqProblems(concepts, used) };
};

const byKind = (report: CheckReport, kind: TermKind): TermVerdict[] =>
  report.verdicts.filter((verdict) => verdict.kind === kind);

const origin = (concept: Concept): string => {
  const ref = formatFirstRef(concept.first);
  return ref.length > 0 ? `（${ref}）` : "";
};

export const renderCheckReport = (report: CheckReport): string => {
  const lines = [`概念检查（${report.verdicts.length} 个术语）`];
  const sections: Array<[TermKind, string]> = [
    ["已确立", "可以直接用；笔记里引用时链过去"],
    ["待验证", "讲的时候顺手确认一下（quiz），别当成已知"],
    ["缺口", "先补它，再讲本节点"],
    ["未登记", "用 note_concept 登记，或明确跳过"],
  ];
  for (const [kind, hint] of sections) {
    const bucket = byKind(report, kind);
    if (bucket.length === 0) continue;
    const terms = bucket
      .map((verdict) =>
        kind === "已确立" && verdict.concept
          ? `${verdict.term}${origin(verdict.concept)}`
          : verdict.term,
      )
      .join("、");
    lines.push(`${kind}（${bucket.length}）：${terms} —— ${hint}`);
  }
  for (const problem of report.problems) {
    const parts = [
      ...problem.missing.map((name) => `「${name}」未登记`),
      ...problem.gap.map((name) => `「${name}」是缺口`),
      ...problem.unverified.map((name) => `「${name}」待验证`),
    ];
    lines.push(`前置未满足：${problem.concept} ← ${parts.join("；")}`);
  }
  if (report.verdicts.length === 0) lines.push("（没有需要检查的术语）");
  return lines.join("\n");
};

// ── 候选术语提取 ────────────────────────────────────────────────────────

export type TermMention = {
  term: string;
  /** 在（去掉代码围栏后的）正文里出现的次数。 */
  count: number;
  /** 至少有一次被 `` ` `` / `**` / 「」包起来——标记即高信号。 */
  marked: boolean;
  /** 长得像代码符号（`func()`、`a_b`、`file.cc:12`、SQL 关键字）——不算术语。 */
  code: boolean;
  /** 从哪里看到的：代码跨度 / 强调跨度 / 已登记术语的明文。 */
  source: TermSource;
};

/** SQL / 通用大写词：出现在正文里不代表学习者需要把它当概念。 */
const CODE_STOPLIST = new Set(
  [
    "SELECT",
    "UPDATE",
    "INSERT",
    "DELETE",
    "BEGIN",
    "COMMIT",
    "ROLLBACK",
    "WHERE",
    "FROM",
    "JOIN",
    "TABLE",
    "INDEX",
    "NULL",
    "TRUE",
    "FALSE",
    "AND",
    "OR",
    "NOT",
    "SET",
    "INTO",
  ].map((word) => normalizeConceptKey(word)),
);

/** 命令行工具名：它们是操作对象，不是学习者要建立的概念。 */
const TOOL_STOPLIST = new Set(
  [
    "ip",
    "iptables",
    "docker",
    "mydocker",
    "busybox",
    "nsenter",
    "sh",
    "bash",
    "go",
    "make",
    "git",
  ].map((word) => normalizeConceptKey(word)),
);

const isCodeLike = (term: string): boolean => {
  // 运算符/标点一出现就是表达式（`age > 20`、`SELECT * FROM t`），不是术语。
  if (/[()_./:#=\\><*,;+%"?{}!~|]/.test(term)) return true;
  // 前后带连字符 = 命令行选项（`-p`、`--entrypoint`）或残缺 token。
  if (/^-|-$/.test(term)) return true;
  if (/^[\d.]+$/.test(term)) return true;
  if (CODE_STOPLIST.has(normalizeConceptKey(term))) return true;
  if (TOOL_STOPLIST.has(normalizeConceptKey(term))) return true;
  return false;
};

/** 例子里出现的占位标识符（`age`、`t1`、`orders`）不是学习者的概念。 */
const PLACEHOLDER_STOPLIST = new Set(
  [
    "age",
    "id",
    "order",
    "orders",
    "name",
    "email",
    "price",
    "amount",
    "count",
    "user",
    "users",
    "foo",
    "bar",
    "baz",
    "x",
    "y",
    "z",
    "a",
    "b",
    "c",
    "t",
  ].map((word) => normalizeConceptKey(word)),
);

/** 中文虚词：带这些小字的跨度多半是句子/强调，不是术语（`没有`、`可能`、`已经提交`）。 */
const CJK_PARTICLES =
  "的了是和与或就都也才会没能很太吗呢只但而把被让从对向在已未之其并且则由于等以及这那什么怎么要";

/** 整词黑名单：看着像术语、实际是动词/状态词的常见词（按整词比对，不影响「快照读」这类真术语）。 */
const PHRASE_STOPLIST = new Set(
  [
    "提交",
    "回滚",
    "加锁",
    "插入",
    "修改",
    "检查",
    "清理",
    "更新",
    "跳过",
    "排队",
    "撤销",
    "恢复",
    "进入",
    "正确",
    "内容",
    "场景",
    "动机",
    "实战",
    "前提",
    "位置",
    "成员",
    "之前",
    "然后",
    "现在",
    "别人",
    "完好",
    "可能",
    "没有",
    "需要",
    "不能",
    "不在",
    "提交了",
    "没提交",
    "已提交",
    "未提交",
    "不完整",
    "还在",
    "不存在",
  ].map((word) => normalizeConceptKey(word)),
);

const isPlaceholder = (term: string): boolean => {
  const key = normalizeConceptKey(term);
  return PLACEHOLDER_STOPLIST.has(key) || /^t\d+$/.test(key);
};

/**
 * 术语形状：英文 1–4 个词、中文 2–8 字、中英混排 2–20 字符。
 * 这一步专门干掉「**没有**」「**还在干活**」这种强调用法——它们靠数量堆出来的排序会淹没真术语。
 */
export const isTermShape = (term: string): boolean => {
  if (PHRASE_STOPLIST.has(normalizeConceptKey(term)) || isPlaceholder(term)) {
    return false;
  }
  if (/^[A-Za-z][A-Za-z0-9 '-]*$/.test(term)) {
    return term.split(/\s+/).length <= 4 && term.length <= 30;
  }
  if (/^[\u4e00-\u9fff]{2,8}$/.test(term)) {
    return [...term].every((char) => !CJK_PARTICLES.includes(char));
  }
  if (/^[\u4e00-\u9fffA-Za-z0-9 -]{2,20}$/.test(term)) {
    const hasCjk = /[\u4e00-\u9fff]/.test(term);
    const hasLatin = /[A-Za-z]/.test(term);
    return (
      hasCjk &&
      hasLatin &&
      [...term].every((char) => !CJK_PARTICLES.includes(char))
    );
  }
  return false;
};

/** 去掉 ``` / ~~~ 围栏里的内容：代码不是教学内容。 */
const stripFences = (markdown: string): string => {
  const out: string[] = [];
  let fence: string | undefined;
  for (const line of markdown.split("\n")) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      fence = fence === marker ? undefined : marker;
      continue;
    }
    if (fence === undefined) out.push(line);
  }
  return out.join("\n");
};

/** 三种来源：`` ` ` ``（代码跨度，精度最高）、`**`/「」（强调/引用跨度，需要形状与次数过滤）、已登记术语的明文。 */
export type TermSource = "code" | "quote" | "registry";

const MARKED_PATTERNS: Array<{ pattern: RegExp; source: TermSource }> = [
  { pattern: /`([^`\n]+)`/g, source: "code" },
  { pattern: /\*\*([^*\n]+)\*\*/g, source: "quote" },
  { pattern: /「([^」\n]+)」/g, source: "quote" },
];

const cleanToken = (token: string): string =>
  token
    .trim()
    .replace(/^[（(【[]+/, "")
    .replace(/[）)】\]。，,；;：:、]+$/, "")
    .trim();

const isLatinTerm = (term: string): boolean => /^[A-Za-z][\w -]*$/.test(term);

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 计数：拉丁词按词边界（`undo` 不数进 `undo_page`），中日韩按子串。 */
export const countOccurrences = (text: string, term: string): number => {
  if (term.length === 0) return 0;
  const body = isLatinTerm(term)
    ? `(?<![A-Za-z0-9_])${escapeRegExp(term)}(?![A-Za-z0-9_])`
    : escapeRegExp(term);
  return text.match(new RegExp(body, "gi"))?.length ?? 0;
};

/**
 * 提取候选术语：`` ` `` 里的代码跨度 + `**`/「」里的术语形状跨度 + 已登记术语的明文出现。
 * 三种来源分开记（`source`），因为它们的精度不同：audit 里代码跨度出现即报，
 * 强调跨度要过形状测试且出现 ≥ 2 次，明文只用于识别已登记术语的状态。
 */
export const extractTermMentions = (
  markdown: string,
  concepts: Concept[] = [],
): TermMention[] => {
  const text = stripFences(markdown);
  const found = new Map<string, TermMention>();
  const remember = (raw: string, source: TermSource): void => {
    const term = cleanToken(raw);
    if (term.length < 2 || term.length > CONCEPT_NAME_MAX_LENGTH) return;
    const key = normalizeConceptKey(term);
    if (key.length === 0) return;
    if (isPlaceholder(term)) return;
    const code = isCodeLike(term);
    // 强调/引用跨度只在形状像术语时才要（这一条把噪音砍掉一个数量级）。
    if (source === "quote" && (code || !isTermShape(term))) return;
    const count = countOccurrences(text, term);
    // 已登记术语也要真的出现在正文里才算提到——否则概念表越大，报告越假。
    if (source === "registry" && count === 0) return;
    const existing = found.get(key);
    if (existing) {
      existing.marked = existing.marked || source !== "registry";
      if (existing.source === "code" || source === "code") {
        existing.source = "code";
      }
      return;
    }
    found.set(key, {
      term,
      count,
      marked: source !== "registry",
      code,
      source,
    });
  };

  for (const { pattern, source } of MARKED_PATTERNS) {
    for (const match of text.matchAll(pattern)) remember(match[1], source);
  }
  for (const concept of concepts) {
    for (const name of [concept.name, ...concept.aliases]) {
      remember(name, "registry");
    }
  }
  return [...found.values()];
};

export type AuditReport = {
  unregistered: TermMention[];
  pending: Array<{ mention: TermMention; concept: Concept }>;
  established: Array<{ mention: TermMention; concept: Concept }>;
  skipped: TermMention[];
  /** 因为 limit 被折叠掉的候选数。 */
  truncatedCount: number;
};

/**
 * 收章扫全章：只报高信号候选（标记符术语，或出现 ≥ 2 次的标记符术语），
 * 并顺带把「已登记但还没确立」的概念挑出来——那正是下一课要先补的。
 */
export const auditConcepts = (input: {
  markdown: string;
  concepts: Concept[];
  limit?: number;
}): AuditReport => {
  const limit = input.limit ?? 30;
  const mentions = extractTermMentions(input.markdown, input.concepts);
  const report: AuditReport = {
    unregistered: [],
    pending: [],
    established: [],
    skipped: [],
    truncatedCount: 0,
  };
  // 一个概念的多个写法（别名、大小写、连字符）只报一次，用规范名说话。
  const known = new Map<string, { mention: TermMention; concept: Concept }>();
  for (const mention of mentions) {
    const concept = findConcept(input.concepts, mention.term);
    if (concept) {
      const key = normalizeConceptKey(concept.name);
      const previous = known.get(key);
      const merged = {
        mention: { ...mention, term: concept.name },
        concept,
      };
      if (!previous || mention.count > previous.mention.count) {
        known.set(key, merged);
      }
      continue;
    }
    if (mention.code) {
      report.skipped.push(mention);
      continue;
    }
    if (mention.source === "quote" && mention.count < 2) continue;
    report.unregistered.push(mention);
  }
  for (const item of known.values()) {
    const bucket =
      item.concept.status === "已确立" ? report.established : report.pending;
    bucket.push(item);
  }
  const byCount = (a: TermMention, b: TermMention) =>
    b.count - a.count || cmpText(a.term, b.term);
  report.unregistered.sort(byCount);
  report.established.sort((a, b) => byCount(a.mention, b.mention));
  report.pending.sort((a, b) => byCount(a.mention, b.mention));
  report.skipped.sort(byCount);
  if (report.unregistered.length > limit) {
    report.truncatedCount = report.unregistered.length - limit;
    report.unregistered = report.unregistered.slice(0, limit);
  }
  return report;
};

const mentionLabel = (mention: TermMention): string =>
  mention.count > 1 ? `${mention.term}（${mention.count} 次）` : mention.term;

export const renderAuditReport = (
  report: AuditReport,
  label: string,
): string => {
  const total =
    report.unregistered.length +
    report.pending.length +
    report.established.length;
  const lines = [
    `${label}：候选术语 ${total} 个（标记符里的术语 + 已登记术语）`,
  ];
  if (report.unregistered.length > 0) {
    const tail =
      report.truncatedCount > 0
        ? `，另有 ${report.truncatedCount} 个未列出`
        : "";
    lines.push(
      `未登记（${report.unregistered.length}）：${report.unregistered.map(mentionLabel).join("、")}${tail} —— 登记，或明确跳过`,
    );
  }
  if (report.pending.length > 0) {
    lines.push(
      `未确立（${report.pending.length}）：${report.pending
        .map((item) => `${item.mention.term}（${item.concept.status}）`)
        .join("、")} —— 下一课先补`,
    );
  }
  if (report.established.length > 0) {
    lines.push(
      `已确立（${report.established.length}）：${report.established
        .map((item) => item.mention.term)
        .join("、")}`,
    );
  }
  if (report.skipped.length > 0) {
    lines.push(
      `跳过（代码符号 ${report.skipped.length}）：${report.skipped.map((mention) => mention.term).join("、")}`,
    );
  }
  if (total === 0 && report.skipped.length === 0) {
    lines.push("没有发现候选术语。");
  }
  return lines.join("\n");
};

export type ChapterRefInput = { number?: number; name: string };

/**
 * 章节引用的匹配：`第3章` / `03-调度与唤醒` / `调度与唤醒` 都能落到同一个章节。
 * 数字优先（编号是权威），其次精确名字，最后去空白比对。
 */
export const matchChapter = <T extends ChapterRefInput>(
  chapters: T[],
  ref: { number?: number; name?: string },
): T | undefined => {
  if (ref.number !== undefined) {
    return chapters.find((chapter) => chapter.number === ref.number);
  }
  const name = ref.name?.trim();
  if (!name) return undefined;
  const exact = chapters.find((chapter) => chapter.name === name);
  if (exact) return exact;
  const key = normalizeConceptKey(name);
  return chapters.find((chapter) => normalizeConceptKey(chapter.name) === key);
};

/** `note_concept` 的回报：登记了什么 + 前置现在是什么状态 + 下一步。 */
export const renderConceptResult = (
  result: { concept: Concept; created: boolean; changed: string[] },
  registry: Concept[],
): string => {
  const { concept } = result;
  const lines = [
    `${result.created ? "已登记" : "已更新"}概念「${concept.name}」（${concept.status}）· 首次：${formatFirstRef(concept.first)} · ${result.changed.join("；")}`,
  ];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  const note = (name: string, label: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    unresolved.push(label);
  };
  if (concept.requires.length > 0) {
    lines.push(
      `前置：${concept.requires
        .map((name) => {
          const prereq = findConcept(registry, name);
          if (!prereq) {
            note(name, `${name}（未登记）`);
            return `${name}（未登记）`;
          }
          if (prereq.status !== "已确立") {
            note(prereq.name, `${prereq.name}（${prereq.status}）`);
          }
          return `${prereq.name}（${prereq.status}${prereq.status === "已确立" ? " ✓" : ""}）`;
        })
        .join("、")}`,
    );
  }
  // 传递前置：链上任何一环没确立都要报出来（缺失/缺口算阻断，待验证也算警告）。
  for (const problem of prereqProblems(registry, [concept])) {
    for (const name of problem.missing) note(name, `${name}（未登记）`);
    for (const name of problem.gap) note(name, `${name}（缺口）`);
    for (const name of problem.unverified) {
      note(name, `${name}（待验证）`);
    }
  }
  if (unresolved.length > 0) {
    lines.push(
      `⚠️ 前置未确立：${unresolved.join("、")} —— 先补这些，再讲用它的节点。`,
    );
  }
  return lines.join("\n");
};

export type ConceptRegistrySummary = {
  total: number;
  established: number;
  unverified: number;
  gaps: string[];
};

export const summarizeRegistry = (
  concepts: Concept[],
): ConceptRegistrySummary => ({
  total: concepts.length,
  established: concepts.filter((concept) => concept.status === "已确立").length,
  unverified: concepts.filter((concept) => concept.status === "待验证").length,
  gaps: concepts
    .filter((concept) => concept.status === "缺口")
    .map((concept) => concept.name)
    .sort(cmpText),
});

/** 本地日期（`YYYY-MM-DD`）：教学笔记里的日期用的是本地日历。 */
export const formatLocalDate = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;

// ── bind_notes 用的主题视图 ─────────────────────────────────────────────

export type TopicConceptState = {
  total: number;
  established: number;
  unverified: string[];
  gaps: string[];
  /** 本主题概念的前置里，登记了但没确立 / 根本没登记的名字。 */
  missingPrereqs: string[];
};

export const topicConceptState = (
  concepts: Concept[],
  topic: string,
): TopicConceptState => {
  const own = concepts.filter((concept) => concept.first.topic === topic);
  const unverified = own
    .filter((concept) => concept.status === "待验证")
    .map((concept) => concept.name);
  const gaps = own
    .filter((concept) => concept.status === "缺口")
    .map((concept) => concept.name);
  const missing = new Set<string>();
  for (const concept of own) {
    for (const problem of prereqProblems(concepts, [concept])) {
      for (const name of [...problem.missing, ...problem.gap]) {
        if (normalizeConceptKey(name) === normalizeConceptKey(concept.name)) {
          continue;
        }
        missing.add(findConcept(concepts, name)?.name ?? name);
      }
    }
  }
  return {
    total: own.length,
    established: own.length - unverified.length - gaps.length,
    unverified,
    gaps,
    missingPrereqs: [...missing].sort(cmpText),
  };
};

/** bind_notes 回报里的那一行：缺口优先，其次是待验证与前置未确立。 */
export const renderTopicConceptLine = (state: TopicConceptState): string => {
  if (state.total === 0) {
    return "概念缺口：无（概念表里还没有本主题的术语，讲到即登记）";
  }
  const parts: string[] = [];
  if (state.gaps.length > 0) parts.push(`缺口 ${state.gaps.join("、")}`);
  if (state.unverified.length > 0) {
    parts.push(`待验证 ${state.unverified.join("、")}`);
  }
  if (state.missingPrereqs.length > 0) {
    parts.push(`前置未确立 ${state.missingPrereqs.join("、")}`);
  }
  if (parts.length === 0) parts.push("无");
  return `概念缺口：${parts.join("｜")}（已确立 ${state.established} / ${state.total}）`;
};
