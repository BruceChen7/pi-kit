import { describe, expect, it } from "vitest";
import {
  checkReceipts,
  classifyTestCommand,
  extractTestClaim,
  parseTestCounts,
  type Receipt,
} from "./parse.js";

const receipt = (overrides: Partial<Receipt> = {}): Receipt => ({
  command: "npx vitest run",
  passed: 12,
  failed: 0,
  exitCode: 0,
  at: "T0",
  ...overrides,
});

describe("classifyTestCommand", () => {
  it("recognises the runners this repo and its neighbours use", () => {
    for (const command of [
      "npx vitest run extensions/loop",
      "npm test",
      "npm run test:unit",
      "pnpm test",
      "yarn test",
      "make test",
      "go test ./...",
      "pytest -q",
      "cargo test",
      "npx jest --ci",
    ]) {
      expect(classifyTestCommand(command)).toBe(true);
    }
  });

  it("ignores commands that are not test runs", () => {
    for (const command of [
      "ls -la",
      "git status",
      "npx tsc --noEmit",
      "npm run build",
      "cat test.txt",
    ]) {
      expect(classifyTestCommand(command)).toBe(false);
    }
  });
});

describe("parseTestCounts", () => {
  it("reads the vitest summary", () => {
    expect(parseTestCounts(" Tests  12 passed (12)\n")).toEqual({
      passed: 12,
      failed: 0,
    });
  });

  it("reads a mixed vitest/jest summary", () => {
    expect(
      parseTestCounts("Tests:       1 failed, 11 passed, 12 total"),
    ).toEqual({ passed: 11, failed: 1 });
  });

  it("reads a pytest summary", () => {
    expect(parseTestCounts("3 passed in 0.12s")).toEqual({
      passed: 3,
      failed: 0,
    });
  });

  it("returns null when there is nothing to count", () => {
    expect(parseTestCounts("ok  \texample.com/pkg\t0.02s")).toBeNull();
    expect(parseTestCounts("")).toBeNull();
  });
});

describe("extractTestClaim", () => {
  it("accepts the three explicit shapes", () => {
    expect(extractTestClaim("Tests: 12")?.count).toBe(12);
    expect(extractTestClaim("all 12 tests passed")?.count).toBe(12);
    expect(extractTestClaim("12 passed")?.count).toBe(12);
  });

  it("ignores prose that is not a count claim", () => {
    expect(extractTestClaim("adds a test for the parser")).toBeNull();
    expect(extractTestClaim("refactor only, no behaviour change")).toBeNull();
    expect(extractTestClaim("")).toBeNull();
  });
});

describe("checkReceipts", () => {
  it("accepts a claim that matches a recorded run", () => {
    expect(
      checkReceipts({ count: 12, matched: "Tests: 12" }, [receipt()]),
    ).toEqual({
      ok: true,
    });
  });

  it("refuses when nothing was recorded", () => {
    const verdict = checkReceipts({ count: 12, matched: "Tests: 12" }, []);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain(
      "No test run recorded",
    );
  });

  it("refuses a number that no run produced, and quotes the latest", () => {
    const verdict = checkReceipts({ count: 999, matched: "Tests: 999" }, [
      receipt({ passed: 30 }),
      receipt(),
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("12 passed");
  });
});
