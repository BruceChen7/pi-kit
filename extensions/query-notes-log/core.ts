/**
 * query-notes-log — Functional Core（纯函数，value in / value out）
 *
 * 无 IO、无 Pi API、无副作用：命令解析、文本归一化、bigram Jaccard、
 * 相似度带分类、去重决策、LLM prompt 构造与 verdict 解析、条目构造、呈现。
 */

export const QUERY_NOTES_CMD_RE = /^\/query-notes(?=\s|$)/;

/** 去重判定阈值：`>= high` → dup，`<= low` → no，中间 → maybe */
export const DEFAULT_HIGH = 0.8;
export const DEFAULT_LOW = 0.45;
/** /query-recent-notes-log 默认显示条数 */
export const DEFAULT_DISPLAY = 20;

/** 日志条目（JSONL 每行一个） */
export type QueryLogEntry = {
  /** `${ts}-${rand4}`，如 "1757328000000-a1b2" */
  id: string;
  /** 落盘时间戳（epoch ms） */
  ts: number;
  /** 查询问题文本（/query-notes 参数，trim 后） */
  q: string;
  /** 语义重复累计次数，首次=1，命中重复 +1 */
  repeats: number;
};

/** 相似度带分类结果 */
export type SimBand = "dup" | "maybe" | "no";

/**
 * 解析 /query-notes 输入，提取查询文本。
 * 命中返回命令 token 后 trim 的查询文本；无参/空/未命中返回 null。
 */
export function parseQueryNotesInput(text: string): string | null {
  const match = QUERY_NOTES_CMD_RE.exec(text);
  if (match === null) return null;
  const q = text.slice(match[0].length).trim();
  return q.length > 0 ? q : null;
}

/**
 * 归一化：NFKC、转小写、去空白与标点符号、trim。
 * 用于 bigram Jaccard 前的可比形态。
 */
export function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "")
    .trim();
}

/** 字符 bigram（#+文本+# 边界填充）集合的 Jaccard 相似度，0..1 */
export function bigramJaccard(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na.length === 0 || nb.length === 0) return 0;

  const bigrams = (s: string): Set<string> => {
    const padded = `#${s}#`;
    const set = new Set<string>();
    for (let i = 0; i < padded.length - 1; i++) {
      set.add(padded.slice(i, i + 2));
    }
    return set;
  };

  const sa = bigrams(na);
  const sb = bigrams(nb);
  let intersection = 0;
  for (const gram of sa) {
    if (sb.has(gram)) intersection++;
  }
  const union = sa.size + sb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 相似度带分类：`>= high` → dup，`<= low` → no，中间 → maybe（需 LLM 确认）。
 */
export function classifySimilarity(
  sim: number,
  high = DEFAULT_HIGH,
  low = DEFAULT_LOW,
): SimBand {
  if (sim >= high) return "dup";
  if (sim <= low) return "no";
  return "maybe";
}

/** 注入式 LLM 判定接缝：返回是否语义重复；不可用/失败返回 null */
export type AskLlm = (q: string, candidate: string) => Promise<boolean | null>;

/**
 * 去重判定（组合）：文本粗筛取最相似候选 → 相似度带分类 →
 * dup/no 直接定，maybe 走注入式 LLM 确认。LLM 失败按不重复处理。
 */
export async function decideDuplicate(
  q: string,
  recent: QueryLogEntry[],
  askLlm: AskLlm,
): Promise<QueryLogEntry | null> {
  const nq = normalize(q);
  let best: { sim: number; entry: QueryLogEntry } | null = null;
  for (const entry of recent) {
    const sim = bigramJaccard(nq, entry.q);
    if (best === null || sim > best.sim) best = { sim, entry };
  }
  if (best === null) return null;
  const band = classifySimilarity(best.sim, DEFAULT_HIGH, DEFAULT_LOW);
  if (band === "dup") return best.entry;
  if (band === "no") return null;
  const verdict = await askLlm(q, best.entry.q);
  return verdict === true ? best.entry : null;
}

/** 构造去重确认用的 LLM prompt（system + user 两条纯数据） */
export function buildDedupPrompt(
  a: string,
  b: string,
): { systemPrompt: string; user: string } {
  return {
    systemPrompt:
      '判断两个查询问题是否语义相同（意图相同即算重复，允许不同措辞）。只返回 JSON 对象 {"duplicate": true} 或 {"duplicate": false}，不要输出任何其他内容。',
    user: `A: ${a}\nB: ${b}`,
  };
}

/**
 * 解析 LLM verdict JSON：提取首个 `{…}` 块（容忍代码围栏/前后说明文字），
 * 要求含布尔 duplicate 字段；未命中/解析失败/类型不符 → null。
 */
export function parseLlmVerdict(out: string): boolean | null {
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(out.slice(start, end + 1));
    const duplicate = (parsed as { duplicate?: unknown } | null)?.duplicate;
    if (duplicate === true) return true;
    if (duplicate === false) return false;
  } catch {
    return null;
  }
  return null;
}

/** 构造新日志条目，repeats 初始为 1；id 后缀随机源可注入（默认 Math.random） */
export function makeEntry(
  q: string,
  ts = Date.now(),
  rand: () => string = () => Math.random().toString(36).slice(2, 6),
): QueryLogEntry {
  return { id: `${ts}-${rand()}`, ts, q, repeats: 1 };
}

/** 返回 repeats+1 的新条目（不原地修改） */
export function withRepeat(entry: QueryLogEntry): QueryLogEntry {
  return { ...entry, repeats: entry.repeats + 1 };
}

/** 渲染单条：MM-DD HH:mm [xN] q（repeats>1 才显示 [xN]） */
export function formatEntry(entry: QueryLogEntry): string {
  const d = new Date(entry.ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const repeats = entry.repeats > 1 ? ` [x${entry.repeats}]` : "";
  return `${mm}-${dd} ${hh}:${mi}${repeats} ${entry.q}`;
}

/** 解析 /query-recent-notes-log 参数：正整数 N，默认 20，上限 100 */
export function parseDisplayCount(args: string | undefined): number {
  const raw = Number.parseInt((args ?? "").trim(), 10);
  if (Number.isNaN(raw) || raw <= 0) return DEFAULT_DISPLAY;
  return Math.min(raw, 100);
}
