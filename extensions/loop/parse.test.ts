import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_TURNS, parseLoopArgs } from "./parse.js";

describe("parseLoopArgs", () => {
  it("defaults an empty argument to status", () => {
    expect(parseLoopArgs("")).toEqual({ action: "status" });
    expect(parseLoopArgs(undefined)).toEqual({ action: "status" });
  });

  it("stops without arguments", () => {
    expect(parseLoopArgs("stop")).toEqual({
      action: "stop",
      reason: "operator-stopped",
    });
  });

  it("resumes with an optional budget", () => {
    expect(parseLoopArgs("resume")).toEqual({
      action: "resume",
      maxTurns: undefined,
    });
    expect(parseLoopArgs("resume --max-turns 3")).toEqual({
      action: "resume",
      maxTurns: 3,
    });
  });

  it("runs with a bare goal", () => {
    expect(parseLoopArgs("run fix the parser")).toEqual({
      action: "run",
      goal: "fix the parser",
      maxTurns: DEFAULT_MAX_TURNS,
      until: null,
      allowDirty: false,
    });
  });

  it("keeps a quoted goal as one word", () => {
    const parsed = parseLoopArgs('run "fix the parser"');
    expect(parsed).toMatchObject({ action: "run", goal: "fix the parser" });
  });

  it("reads the predicate and its timeout", () => {
    const parsed = parseLoopArgs(
      'run --max-turns 2 --until "npm test" --until-timeout 5 tidy the docs',
    );
    expect(parsed).toMatchObject({
      action: "run",
      goal: "tidy the docs",
      maxTurns: 2,
      until: { command: "npm test", timeoutSec: 5 },
    });
  });

  it("honours --allow-dirty and the -- terminator", () => {
    const parsed = parseLoopArgs("run --allow-dirty -- --not-an-option");
    expect(parsed).toMatchObject({
      action: "run",
      goal: "--not-an-option",
      allowDirty: true,
    });
  });

  it("refuses unknown options and missing values", () => {
    expect(() => parseLoopArgs("run --until")).toThrow("--until needs a value");
    expect(() => parseLoopArgs("run --nope goal")).toThrow("Unknown option");
    expect(() => parseLoopArgs("run --until '  ' goal")).toThrow(
      "--until needs a non-empty command",
    );
  });

  it("bounds the budget and the timeout", () => {
    expect(() => parseLoopArgs("run --max-turns 0 goal")).toThrow(
      "--max-turns",
    );
    expect(() => parseLoopArgs("run --max-turns 101 goal")).toThrow(
      "--max-turns",
    );
    expect(() => parseLoopArgs("run --until x --until-timeout 0 goal")).toThrow(
      "--until-timeout",
    );
  });

  it("requires a goal", () => {
    expect(() => parseLoopArgs("run")).toThrow("A goal is required");
    expect(() => parseLoopArgs("run --max-turns 2")).toThrow(
      "A goal is required",
    );
  });

  it("reports a syntax error instead of guessing", () => {
    expect(() => parseLoopArgs('run "unclosed')).toThrow("Unclosed quote");
    expect(() => parseLoopArgs("status extra")).toThrow(
      "status takes no arguments",
    );
    expect(() => parseLoopArgs("nonsense")).toThrow("Usage: /loop");
  });
});
