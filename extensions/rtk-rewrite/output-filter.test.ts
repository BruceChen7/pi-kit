import { describe, expect, it } from "vitest";
import {
  aggregateTestOutput,
  filterBuildOutput,
  isBuildCommand,
  isTestCommand,
} from "./output-filter.js";

describe("isBuildCommand", () => {
  it("matches known build commands", () => {
    expect(isBuildCommand("npm run build")).toBe(true);
    expect(isBuildCommand("cargo build --release")).toBe(true);
    expect(isBuildCommand("echo build")).toBe(false);
  });

  it("accepts additional build command entries", () => {
    const extraCommands = ["turbo build", "bazel build"];
    expect(isBuildCommand("turbo build", extraCommands)).toBe(true);
    expect(isBuildCommand("bazel build //...", extraCommands)).toBe(true);
  });
});

describe("filterBuildOutput", () => {
  it("returns last N lines for matching build commands", () => {
    const output = [
      "line 1",
      "line 2",
      "line 3",
      "line 4",
      "line 5",
      "line 6",
    ].join("\n");

    const result = filterBuildOutput(output, "cargo build", undefined, {
      maxLines: 3,
      maxChars: 1_000,
    });

    expect(result).toBe("line 4\nline 5\nline 6");
  });

  it("drops trailing blank lines before taking the tail", () => {
    const output = ["alpha", "beta", "gamma", "", "", ""].join("\n");

    const result = filterBuildOutput(output, "npm run build", undefined, {
      maxLines: 2,
      maxChars: 1_000,
    });

    expect(result).toBe("beta\ngamma");
  });

  it("applies maxChars after maxLines and keeps tail-most characters", () => {
    const output = ["first-line-12345", "second-line-ABCDE"].join("\n");

    const result = filterBuildOutput(output, "go build", undefined, {
      maxLines: 2,
      maxChars: 20,
    });

    expect(result).toBe("...[truncated]\nABCDE");
  });

  it("returns null when command is not a build command", () => {
    const result = filterBuildOutput("output", "echo hello", undefined, {
      maxLines: 3,
      maxChars: 50,
    });
    expect(result).toBeNull();
  });
});

describe("isTestCommand", () => {
  it("matches known test commands", () => {
    expect(isTestCommand("npm test")).toBe(true);
    expect(isTestCommand("pytest -q")).toBe(true);
    expect(isTestCommand("latest")).toBe(false);
  });

  it("accepts additional test command entries", () => {
    const extraCommands = ["turbo test", "bazel test"];
    expect(isTestCommand("turbo test", extraCommands)).toBe(true);
    expect(isTestCommand("bazel test //...", extraCommands)).toBe(true);
  });
});

describe("aggregateTestOutput", () => {
  it("returns last N lines for matching test commands", () => {
    const output = [
      "test a ... ok",
      "test b ... ok",
      "test c ... FAILED",
      "AssertionError: expected 1",
      "at src/math.test.ts:12:5",
    ].join("\n");

    const result = aggregateTestOutput(output, "cargo test", undefined, {
      maxLines: 2,
      maxChars: 1_000,
    });

    expect(result).toBe("AssertionError: expected 1\nat src/math.test.ts:12:5");
  });

  it("applies char cap for test output", () => {
    const output = ["log-1", "log-2", "final-failure-line-XYZ"].join("\n");

    const result = aggregateTestOutput(output, "npm test", undefined, {
      maxLines: 3,
      maxChars: 23,
    });

    expect(result).toBe("...[truncated]\nline-XYZ");
  });

  it("returns null when command is not a test command", () => {
    const result = aggregateTestOutput("output", "echo hello", undefined, {
      maxLines: 3,
      maxChars: 50,
    });
    expect(result).toBeNull();
  });
});
