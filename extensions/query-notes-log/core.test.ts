// biome-ignore-all lint/style/noNonNullAssertion: tests use ! for brevity
import { describe, expect, it, vi } from "vitest";
import {
  bigramJaccard,
  buildDedupPrompt,
  classifySimilarity,
  decideDuplicate,
  formatEntry,
  makeEntry,
  normalize,
  parseDisplayCount,
  parseLlmVerdict,
  parseQueryNotesInput,
  type QueryLogEntry,
  withRepeat,
} from "./core.ts";

describe("parseQueryNotesInput", () => {
  it.each([
    ["/query-notes malloc 怎么实现", "malloc 怎么实现"],
    ["/query-notes   eBPF 观测   ", "eBPF 观测"],
    ["/query-notes 查找 malloc 实现的笔记", "查找 malloc 实现的笔记"],
  ])("extracts query text: %s", (input, expected) => {
    expect(parseQueryNotesInput(input)).toBe(expected);
  });

  it.each([
    ["/query-notes", null],
    ["/query-notes ", null],
    ["/query-notes   ", null],
    ["hello world", null],
    ["/query-notesx malloc", null],
    ["/query_notes malloc", null],
    ["some /query-notes in middle", null],
  ])("returns null for non-matching input: %j", (input, expected) => {
    expect(parseQueryNotesInput(input as string)).toBe(expected);
  });
});

describe("normalize", () => {
  it.each([
    ["malloc 怎么实现", "malloc怎么实现"],
    ["  Malloc  怎么实现！？ ", "malloc怎么实现"],
    ["eBPF 观测有哪些方案", "ebpf观测有哪些方案"],
    ["（Redis）内存模型 - 2026", "redis内存模型2026"],
    ["", ""],
  ])("normalizes %j -> %j", (input, expected) => {
    expect(normalize(input)).toBe(expected);
  });
});

describe("bigramJaccard", () => {
  it("identical strings have similarity 1", () => {
    expect(bigramJaccard("malloc 怎么实现", "malloc 怎么实现")).toBe(1);
  });

  it("identical modulo punctuation/space has similarity 1", () => {
    expect(bigramJaccard("malloc 怎么实现", "malloc怎么实现")).toBe(1);
  });

  it("unrelated strings have low similarity", () => {
    expect(bigramJaccard("malloc 怎么实现", "eBPF 观测方案")).toBeLessThan(0.3);
  });

  it("short strings still compare with boundary padding", () => {
    expect(bigramJaccard("ab", "ab")).toBe(1);
    expect(bigramJaccard("ab", "ac")).toBeGreaterThan(0);
    expect(bigramJaccard("ab", "xy")).toBe(0);
  });

  it("returns 0 when either side is empty after normalize", () => {
    expect(bigramJaccard("", "malloc")).toBe(0);
    expect(bigramJaccard("!!!", "")).toBe(0);
  });
});

describe("classifySimilarity", () => {
  it("maps >= high to dup", () => {
    expect(classifySimilarity(0.95)).toBe("dup");
    expect(classifySimilarity(0.8)).toBe("dup");
  });

  it("maps <= low to no", () => {
    expect(classifySimilarity(0.1)).toBe("no");
    expect(classifySimilarity(0.45)).toBe("no");
  });

  it("maps the ambiguous middle band to maybe", () => {
    expect(classifySimilarity(0.6)).toBe("maybe");
    expect(classifySimilarity(0.47)).toBe("maybe");
    expect(classifySimilarity(0.79)).toBe("maybe");
  });

  it("honors custom thresholds", () => {
    expect(classifySimilarity(0.7, 0.9, 0.5)).toBe("maybe");
    expect(classifySimilarity(0.95, 0.9, 0.5)).toBe("dup");
  });
});

describe("buildDedupPrompt", () => {
  it("produces systemPrompt and user pair with A/B labels", () => {
    const { systemPrompt, user } = buildDedupPrompt(
      "malloc 怎么实现",
      "malloc 实现原理",
    );
    expect(systemPrompt).toContain('{"duplicate": true}');
    expect(systemPrompt).toContain('{"duplicate": false}');
    expect(user).toContain("A: malloc 怎么实现");
    expect(user).toContain("B: malloc 实现原理");
  });
});

describe("parseLlmVerdict", () => {
  it.each([
    ['{"duplicate": true}', true],
    ['{"duplicate": false}', false],
    [' {"duplicate": true} ', true],
    ['```json\n{"duplicate": true}\n```', true],
    ['判断：{"duplicate": true}', true],
    ['{"duplicate": false} 补充说明', false],
  ])("parses %j -> %j", (input, expected) => {
    expect(parseLlmVerdict(input)).toBe(expected);
  });

  it.each([
    ["maybe"],
    ["yes"],
    ["no"],
    ['{"duplicate": "true"}'],
    ['{"duplicate": True}'],
    ['{"dup": true}'],
    ["{}"],
    ["[]"],
    ["{broken json"],
    [""],
    ["no braces"],
  ])("returns null for unparseable %j", (input) => {
    expect(parseLlmVerdict(input)).toBeNull();
  });
});

describe("makeEntry / withRepeat", () => {
  it("makeEntry creates entry with repeats=1 and matching fields", () => {
    const entry = makeEntry("malloc 怎么实现", 1757328000000);
    expect(entry.q).toBe("malloc 怎么实现");
    expect(entry.ts).toBe(1757328000000);
    expect(entry.repeats).toBe(1);
    expect(entry.id).toMatch(/^1757328000000-[a-z0-9]{4}$/);
  });

  it("makeEntry accepts an injectable id generator", () => {
    const entry = makeEntry("q", 1757328000000, () => "ab12");
    expect(entry.id).toBe("1757328000000-ab12");
  });

  it("withRepeat increments repeats without mutating the original", () => {
    const entry: QueryLogEntry = {
      id: "x",
      ts: 1,
      q: "q",
      repeats: 2,
    };
    const next = withRepeat(entry);
    expect(next.repeats).toBe(3);
    expect(entry.repeats).toBe(2);
  });
});

describe("decideDuplicate", () => {
  // 真实 bigramJaccard：identical→1.0（dup），"malloc 怎么实现" vs
  // "malloc 是怎么实现的呢"→0.563（maybe），"malloc 怎么实现" vs "eBPF 观测方案"→0.0（no）
  const same = "malloc 怎么实现";
  const maybeVariant = "malloc 是怎么实现的呢";
  const unrelated = "eBPF 观测方案";

  it("returns the candidate directly in the dup band without asking LLM", async () => {
    const candidate = makeEntry(same, 1);
    const askLlm = vi.fn(async () => true);

    const result = await decideDuplicate(same, [candidate], askLlm);
    expect(result?.id).toBe(candidate.id);
    expect(askLlm).not.toHaveBeenCalled();
  });

  it("returns null in the no band without asking LLM", async () => {
    const candidate = makeEntry(unrelated, 1);
    const askLlm = vi.fn(async () => true);

    const result = await decideDuplicate(same, [candidate], askLlm);
    expect(result).toBeNull();
    expect(askLlm).not.toHaveBeenCalled();
  });

  it("picks the most similar candidate", async () => {
    const far = makeEntry(unrelated, 1);
    const near = makeEntry(same, 1);
    const askLlm = vi.fn(async () => true);

    const result = await decideDuplicate(same, [far, near], askLlm);
    expect(result?.id).toBe(near.id);
  });

  it("asks LLM in the maybe band and honors a yes verdict", async () => {
    const candidate = makeEntry(same, 1);
    const askLlm = vi.fn(async () => true);

    const result = await decideDuplicate(maybeVariant, [candidate], askLlm);
    expect(result?.id).toBe(candidate.id);
    expect(askLlm).toHaveBeenCalledWith(maybeVariant, same);
  });

  it("returns null on a no verdict from LLM", async () => {
    const candidate = makeEntry(same, 1);
    const askLlm = vi.fn(async () => false);

    expect(await decideDuplicate(maybeVariant, [candidate], askLlm)).toBeNull();
  });

  it("returns null when LLM is unavailable (null verdict)", async () => {
    const candidate = makeEntry(same, 1);
    const askLlm = vi.fn(async () => null);

    expect(await decideDuplicate(maybeVariant, [candidate], askLlm)).toBeNull();
  });

  it("returns null when there are no recent entries", async () => {
    const askLlm = vi.fn(async () => true);
    expect(await decideDuplicate(same, [], askLlm)).toBeNull();
    expect(askLlm).not.toHaveBeenCalled();
  });
});

describe("formatEntry / parseDisplayCount", () => {
  it("formats entries with and without repeat counts", () => {
    const single = formatEntry({
      id: "1",
      ts: Date.parse("2026-09-08T10:30:00"),
      q: "malloc",
      repeats: 1,
    });
    expect(single).toBe("09-08 10:30 malloc");

    const repeated = formatEntry({
      id: "2",
      ts: Date.parse("2026-09-08T10:30:00"),
      q: "malloc",
      repeats: 3,
    });
    expect(repeated).toBe("09-08 10:30 [x3] malloc");
  });

  it("parseDisplayCount defaults, clamps, and rejects junk", () => {
    expect(parseDisplayCount(undefined)).toBe(20);
    expect(parseDisplayCount("")).toBe(20);
    expect(parseDisplayCount("5")).toBe(5);
    expect(parseDisplayCount("0")).toBe(20);
    expect(parseDisplayCount("-3")).toBe(20);
    expect(parseDisplayCount("abc")).toBe(20);
    expect(parseDisplayCount("500")).toBe(100);
  });
});
