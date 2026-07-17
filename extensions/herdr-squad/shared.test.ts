import { describe, expect, it } from "vitest";
import type { SquadReport } from "./shared.ts";
import {
  buildChildPrompt,
  normalizeDisplayText,
  readSquadReport,
  reportFileName,
  shellQuote,
  validateStartParams,
} from "./shared.ts";

// ─── normalizeDisplayText ────────────────────────────────────────────

describe("normalizeDisplayText", () => {
  it("trims and truncates to maxLength", () => {
    expect(normalizeDisplayText("  hello world  ", 5)).toBe("hello");
  });

  it("replaces control characters with spaces", () => {
    expect(normalizeDisplayText("abc\u0000def\u001fghi", 20)).toBe(
      "abc def ghi",
    );
  });

  it("collapses whitespace", () => {
    expect(normalizeDisplayText("a   b\t\tc", 10)).toBe("a b c");
  });

  it("handles empty string", () => {
    expect(normalizeDisplayText("", 10)).toBe("");
  });

  it("handles maxLength shorter than string", () => {
    expect(normalizeDisplayText("abcdefghij", 3)).toBe("abc");
  });

  it("handles multi-byte characters", () => {
    expect(normalizeDisplayText("你好世界", 2)).toBe("你好");
  });
});

// ─── shellQuote ──────────────────────────────────────────────────────

describe("shellQuote", () => {
  it("wraps simple string in single quotes", () => {
    expect(shellQuote("hello")).toBe("'hello'");
  });

  it("handles single quotes inside string", () => {
    expect(shellQuote("it's")).toBe(`'it'"'"'s'`);
  });

  it("handles empty string", () => {
    expect(shellQuote("")).toBe("''");
  });
});

// ─── reportFileName ──────────────────────────────────────────────────

describe("reportFileName", () => {
  it("generates correct filename", () => {
    expect(reportFileName("abc-1")).toBe("report-abc-1.json");
  });
});

// ─── buildChildPrompt ────────────────────────────────────────────────

describe("buildChildPrompt", () => {
  it("includes task, label, scope, instructions", () => {
    const result = buildChildPrompt(
      "Investigate auth failure",
      "Agent A",
      "auth module",
      "Check login flow",
    );
    expect(result).toContain("Investigate auth failure");
    expect(result).toContain("Agent A");
    expect(result).toContain("auth module");
    expect(result).toContain("Check login flow");
  });

  it("includes non-negotiable boundaries", () => {
    const result = buildChildPrompt("t", "l", "s", "i");
    expect(result).toContain("read-only");
    expect(result).toContain("herdr_squad_report");
    expect(result).toContain("Do not edit");
  });
});

// ─── validateStartParams ─────────────────────────────────────────────

function fakeCrypto() {
  let counter = 0;
  return {
    randomUUID: () => {
      counter++;
      return `00000000-0000-4000-a000-${String(counter).padStart(12, "0")}`;
    },
    randomBytes: () =>
      Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef", "hex"),
  };
}

describe("validateStartParams", () => {
  const validParams = {
    task: "Investigate checkout failure",
    count: 2,
    assignments: [
      { label: "Frontend", scope: "checkout page", prompt: "Check UI flow" },
      { label: "Backend", scope: "order API", prompt: "Check API logic" },
    ],
    title: "Checkout Investigation",
  };

  const validEnv = { HERDR_ENV: "1", HERDR_PANE_ID: "pane-42" };
  const crypto = fakeCrypto();

  it("returns validated params for valid input", () => {
    const result = validateStartParams(validParams, validEnv, crypto, () => ({
      source: "pi-default" as const,
    }));

    expect(result.task).toBe("Investigate checkout failure");
    expect(result.normalizedAssignments).toHaveLength(2);
    expect(result.parentPaneId).toBe("pane-42");
    expect(result.squadId).toBeTruthy();
    expect(result.shortId).toBeTruthy();
    expect(result.title).toBe("Checkout Investigation");
    expect(result.tabLabel).toContain("Checkout Investigation");
    expect(result.manifestAgents).toHaveLength(2);
    expect(result.agents).toHaveLength(2);
  });

  it("throws when HERDR_ENV is not set", () => {
    expect(() =>
      validateStartParams(validParams, {}, crypto, () => ({
        source: "pi-default" as const,
      })),
    ).toThrow("Herdr squads are available only inside a Herdr-managed Pi pane");
  });

  it("throws when count is out of range", () => {
    expect(() =>
      validateStartParams(
        { ...validParams, count: 0 },
        validEnv,
        crypto,
        () => ({ source: "pi-default" as const }),
      ),
    ).toThrow("count must be an integer from 1 through 4");
  });

  it("throws when count does not match assignments length", () => {
    expect(() =>
      validateStartParams(
        { ...validParams, count: 3 },
        validEnv,
        crypto,
        () => ({ source: "pi-default" as const }),
      ),
    ).toThrow("Expected exactly 3 assignments");
  });

  it("throws when task is empty", () => {
    expect(() =>
      validateStartParams(
        { ...validParams, task: "" },
        validEnv,
        crypto,
        () => ({ source: "pi-default" as const }),
      ),
    ).toThrow("task must not be empty");
  });

  it("throws when labels have duplicates", () => {
    expect(() =>
      validateStartParams(
        {
          ...validParams,
          assignments: [
            { label: "Same", scope: "area1", prompt: "p1" },
            { label: "Same", scope: "area2", prompt: "p2" },
          ],
        },
        validEnv,
        crypto,
        () => ({ source: "pi-default" as const }),
      ),
    ).toThrow("Assignment labels must be unique");
  });

  it("throws when scopes have duplicates", () => {
    expect(() =>
      validateStartParams(
        {
          ...validParams,
          assignments: [
            { label: "A", scope: "same scope", prompt: "p1" },
            { label: "B", scope: "same scope", prompt: "p2" },
          ],
        },
        validEnv,
        crypto,
        () => ({ source: "pi-default" as const }),
      ),
    ).toThrow("Assignment scopes must not be exact duplicates");
  });

  it("throws when HERDR_PANE_ID is missing", () => {
    expect(() =>
      validateStartParams(validParams, { HERDR_ENV: "1" }, crypto, () => ({
        source: "pi-default" as const,
      })),
    ).toThrow("HERDR_PANE_ID is unavailable");
  });

  it("resolves model from explicit param", () => {
    const result = validateStartParams(
      { ...validParams, model: "openai-codex/gpt-5.6-terra" },
      validEnv,
      crypto,
      () => ({ source: "pi-default" as const }),
    );
    expect(result.model).toBe("openai-codex/gpt-5.6-terra");
    expect(result.modelSource).toBe("explicit");
  });

  it("resolves model from config when no explicit model", () => {
    const result = validateStartParams(validParams, validEnv, crypto, () => ({
      model: "claude-sonnet-4",
      source: "global" as const,
    }));
    expect(result.model).toBe("claude-sonnet-4");
    expect(result.modelSource).toBe("global");
  });

  it("falls back to pi-default when no model configured", () => {
    const result = validateStartParams(validParams, validEnv, crypto, () => ({
      source: "pi-default" as const,
    }));
    expect(result.model).toBeUndefined();
    expect(result.modelSource).toBe("pi-default");
  });
});

// ─── readSquadReport ─────────────────────────────────────────────────

describe("readSquadReport", () => {
  it("returns undefined when file does not exist", async () => {
    const result = await readSquadReport("/nonexistent/path.json");
    expect(result).toBeUndefined();
  });

  it("returns undefined for invalid JSON content", async () => {
    const { writeFile, rm, mkdtemp } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "test-herdr-"));
    const file = join(dir, "test.json");
    await writeFile(file, "not-json");
    const result = await readSquadReport(file);
    expect(result).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });

  it("returns report for valid JSON", async () => {
    const { writeFile, rm, mkdtemp } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "test-herdr-"));
    const file = join(dir, "test.json");
    const report: SquadReport = {
      version: 1,
      squadId: "sq-1",
      agentId: "ag-1",
      label: "Agent A",
      scope: "test",
      createdAt: new Date().toISOString(),
      findings: "Found nothing",
      evidence: ["file.ts"],
      risksOrUnknowns: ["risk1"],
      recommendedNextStep: "Stop",
    };
    await writeFile(file, JSON.stringify(report));
    const result = await readSquadReport(file);
    expect(result).toBeDefined();
    expect(result?.squadId).toBe("sq-1");
    await rm(dir, { recursive: true, force: true });
  });
});
