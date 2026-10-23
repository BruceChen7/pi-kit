import { describe, expect, it } from "vitest";
import { DEFAULT_RANGE, parseGitReadCommand } from "./parse.js";

const argvOf = (command: string): string[] => {
  const parsed = parseGitReadCommand(command);
  if (!parsed.ok) {
    throw new Error(`expected acceptance, got refusal: ${parsed.reason}`);
  }
  return parsed.argv;
};

const reasonOf = (command: string): string => {
  const parsed = parseGitReadCommand(command);
  if (parsed.ok) {
    throw new Error(
      `expected refusal, got acceptance: ${parsed.argv.join(" ")}`,
    );
  }
  return parsed.reason;
};

describe("accepts read-only inspection", () => {
  it("defaults diff and log to the branch point", () => {
    expect(argvOf("git diff")).toEqual(["diff", DEFAULT_RANGE]);
    expect(argvOf("git log")).toEqual(["log", DEFAULT_RANGE]);
  });

  it("shows HEAD when no object is given", () => {
    expect(argvOf("git show")).toEqual(["show", "HEAD"]);
  });

  it("keeps an explicit revision and the whitelisted options", () => {
    expect(argvOf("git diff --stat main...HEAD")).toEqual([
      "diff",
      "--stat",
      "main...HEAD",
    ]);
    expect(argvOf("git log --oneline -n20")).toEqual([
      "log",
      DEFAULT_RANGE,
      "--oneline",
      "-n20",
    ]);
    expect(argvOf("git diff -U3 --unified=5")).toEqual([
      "diff",
      DEFAULT_RANGE,
      "-U3",
      "--unified=5",
    ]);
  });

  it("accepts paths only after a separator", () => {
    expect(argvOf("git diff -- src/app.ts")).toEqual([
      "diff",
      DEFAULT_RANGE,
      "--",
      "src/app.ts",
    ]);
  });

  it("does not mark an explicit revision as defaulted", () => {
    const parsed = parseGitReadCommand("git diff main..HEAD");
    expect(parsed.ok && parsed.defaultedRange).toBe(false);
  });
});

describe("refuses anything that could write or execute", () => {
  const refusals: Array<[string, string]> = [
    ["git push", "Only git diff, git show, git log"],
    ["git checkout main", "Only git diff, git show, git log"],
    ["git --exec-path", "Only git diff, git show, git log"],
    ["git diff --output=/tmp/x", "not in the read-only whitelist"],
    ["git diff -c core.pager=less", "not in the read-only whitelist"],
    ["git log --ext-diff", "not in the read-only whitelist"],
    ["git diff main; rm -rf /", "Unsafe revision argument"],
    ["git diff `whoami`", "Unsafe revision argument"],
    ["git diff -- x y;z", "Unsafe path argument"],
    ["git diff --", "`--` must be followed by a path"],
    ["git diff -- --", "Only one `--` separator"],
    ["   ", "The command is empty"],
  ];

  for (const [command, expected] of refusals) {
    it(`refuses ${JSON.stringify(command)}`, () => {
      expect(reasonOf(command)).toContain(expected);
    });
  }

  it("refuses non-strings", () => {
    expect(reasonOf(42 as unknown as string)).toContain("must be a string");
  });
});
