import { describe, expect, it } from "vitest";
import {
  checkRoutes,
  evaluateRows,
  extractRouteRefs,
  formatMatrix,
  parseMap,
  tally,
} from "./poteto-kernel-gap.mjs";

type Finding = { upstream?: string; rule: string; detail: string };

const row = (overrides: Record<string, unknown>) => ({
  upstream: "playbooks/x.md",
  verdict: "缺",
  tier: "P0",
  landing: "skills/poteto-playbooks/playbooks/x.md",
  note: "reason",
  ...overrides,
});

const parse = (rows: unknown[]) => parseMap(JSON.stringify({ rows }));

describe("parseMap", () => {
  it("rejects an empty row set", () => {
    expect(() => parse([])).toThrow(/rows 为空/);
  });

  it("rejects a verdict outside the three states", () => {
    expect(() => parse([row({ verdict: "maybe" })])).toThrow(/不在三态内/);
  });

  it("rejects a bad tier", () => {
    expect(() => parse([row({ tier: "P9" })])).toThrow(/tier=P9/);
  });

  it("rejects a row without a reason", () => {
    expect(() => parse([row({ note: "  " })])).toThrow(/note 为空/);
  });

  it("rejects a duplicate upstream path", () => {
    expect(() => parse([row({}), row({})])).toThrow(/重复行/);
  });

  it("rejects a row that forgets the landing key", () => {
    const bare = { upstream: "x", verdict: "不搬", tier: "n/a", note: "why" };
    expect(() => parse([bare])).toThrow(/缺 landing 键/);
  });

  it("rejects an unknown landingKind", () => {
    expect(() => parse([row({ landing: null, landingKind: "cloud" })])).toThrow(
      /landingKind=cloud/,
    );
  });
});

describe("evaluateRows", () => {
  const existsNothing = () => false;

  it("requires a landing for an imported row", () => {
    const findings = evaluateRows(
      [row({ verdict: "已有替代", landing: null })],
      existsNothing,
    );
    expect(findings).toEqual([
      {
        upstream: "playbooks/x.md",
        rule: "landing-required",
        detail: "已有替代/P0",
      },
    ]);
  });

  it("flags a P0 landing whose file is absent", () => {
    const findings = evaluateRows([row({})], existsNothing);
    expect(findings.map((f: Finding) => f.rule)).toEqual(["landing-missing"]);
  });

  it("accepts a P0 row once its landing exists", () => {
    const findings = evaluateRows([row({})], (p: string) => p.endsWith("x.md"));
    expect(findings).toEqual([]);
  });

  it("lets an unimplemented P1 gap carry no landing", () => {
    const findings = evaluateRows(
      [row({ tier: "P1", landing: null })],
      existsNothing,
    );
    expect(findings).toEqual([]);
  });

  it("still checks a P1 landing when one is declared", () => {
    const findings = evaluateRows([row({ tier: "P1" })], existsNothing);
    expect(findings.map((f: Finding) => f.rule)).toEqual(["landing-missing"]);
  });

  it("skips the disk check for an env landing", () => {
    const findings = evaluateRows(
      [row({ verdict: "已有替代", landing: null, landingKind: "env" })],
      () => false,
    );
    expect(findings).toEqual([]);
  });

  it("rejects an env row that still names a path", () => {
    const findings = evaluateRows(
      [
        row({
          verdict: "已有替代",
          landing: "skills/x/SKILL.md",
          landingKind: "env",
        }),
      ],
      () => true,
    );
    expect(findings.map((f: Finding) => f.rule)).toEqual(["env-has-landing"]);
  });

  it("rejects a landing on a row marked as not moved", () => {
    const findings = evaluateRows(
      [row({ verdict: "不搬", landing: "somewhere.md" })],
      existsNothing,
    );
    expect(findings.map((f: Finding) => f.rule)).toEqual([
      "unmoved-has-landing",
    ]);
  });
});

describe("tally", () => {
  it("counts verdicts and tiers", () => {
    const rows = [
      row({ verdict: "已有替代" }),
      row({ upstream: "a", verdict: "缺", tier: "P1" }),
      row({ upstream: "b", verdict: "不搬", tier: "n/a" }),
    ];
    expect(tally(rows)).toEqual({
      counts: { 已有替代: 1, 缺: 1, 不搬: 1 },
      byTier: { P0: 1, P1: 1, P2: 0, "n/a": 1 },
    });
  });
});

describe("formatMatrix", () => {
  it("prints one tab-separated line per row and a totals line", () => {
    const lines = formatMatrix([row({})]).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0].split("\t")).toHaveLength(5);
    expect(lines[1]).toContain("缺=1");
  });
});

describe("extractRouteRefs", () => {
  it("finds playbook references and dedupes them", () => {
    const prompt =
      "| 新功能 | playbook: `feature` |\n| 收尾 | playbook: `feature`, playbook: `shipping` |";
    expect(extractRouteRefs(prompt)).toEqual(["feature", "shipping"]);
  });

  it("returns nothing when the entry names no playbook", () => {
    expect(extractRouteRefs("| 调查 | /skill:research |")).toEqual([]);
  });
});

describe("checkRoutes", () => {
  it("flags a route that names a missing playbook", () => {
    const findings = checkRoutes(["ghost"], ["feature"]);
    expect(findings).toEqual([
      { rule: "route-dangling", detail: "ghost" },
      { rule: "playbook-orphan", detail: "feature" },
    ]);
  });

  it("passes when every route resolves and every playbook is routed", () => {
    expect(checkRoutes(["feature"], ["feature"])).toEqual([]);
  });
});
