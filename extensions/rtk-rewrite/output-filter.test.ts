import { describe, expect, it } from "vitest";
import {
  aggregateTestOutput,
  filterBuildOutput,
  isBuildCommand,
  isTestCommand,
} from "./output-filter.js";

describe("isBuildCommand", () => {
  it("does not match when build command list is empty", () => {
    expect(isBuildCommand("npm run build")).toBe(false);
    expect(isBuildCommand("cargo build --release")).toBe(false);
  });

  it("matches configured build command entries", () => {
    const commands = ["turbo build", "bazel build"];
    expect(isBuildCommand("turbo build", commands)).toBe(true);
    expect(isBuildCommand("bazel build //...", commands)).toBe(true);
    expect(isBuildCommand("npm run build", commands)).toBe(false);
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

    const result = filterBuildOutput(output, "cargo build", ["cargo build"], {
      maxLines: 3,
      maxChars: 1_000,
    });

    expect(result).toBe("line 4\nline 5\nline 6");
  });

  it("drops trailing blank lines before taking the tail", () => {
    const output = ["alpha", "beta", "gamma", "", "", ""].join("\n");

    const result = filterBuildOutput(
      output,
      "npm run build",
      ["npm run build"],
      {
        maxLines: 2,
        maxChars: 1_000,
      },
    );

    expect(result).toBe("beta\ngamma");
  });

  it("applies maxChars after maxLines and keeps tail-most characters", () => {
    const output = ["first-line-12345", "second-line-ABCDE"].join("\n");

    const result = filterBuildOutput(output, "go build", ["go build"], {
      maxLines: 2,
      maxChars: 20,
    });

    expect(result).toBe("...[truncated]\nABCDE");
  });

  it("returns null when command is not in the configured build list", () => {
    const result = filterBuildOutput(
      "output",
      "npm run build",
      ["cargo build"],
      {
        maxLines: 3,
        maxChars: 50,
      },
    );
    expect(result).toBeNull();
  });
});

describe("isTestCommand", () => {
  it("does not match when test command list is empty", () => {
    expect(isTestCommand("pytest -q")).toBe(false);
    expect(isTestCommand("xgo test ./...")).toBe(false);
  });

  it("matches configured test command entries", () => {
    const commands = ["turbo test", "bazel test"];
    expect(isTestCommand("turbo test", commands)).toBe(true);
    expect(isTestCommand("bazel test //...", commands)).toBe(true);
    expect(isTestCommand("npm test", commands)).toBe(false);
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

    const result = aggregateTestOutput(output, "cargo test", ["cargo test"], {
      maxLines: 2,
      maxChars: 1_000,
    });

    expect(result).toBe("AssertionError: expected 1\nat src/math.test.ts:12:5");
  });

  it("applies char cap for configured test commands", () => {
    const output = ["log-1", "log-2", "final-failure-line-XYZ"].join("\n");

    const result = aggregateTestOutput(output, "xgo test ./...", ["xgo test"], {
      maxLines: 3,
      maxChars: 23,
    });

    expect(result).toBe("...[truncated]\nline-XYZ");
  });

  it("returns null when command is not in configured test list", () => {
    const output = ["log-1", "log-2", "final-failure-line-XYZ"].join("\n");

    const result = aggregateTestOutput(output, "cargo test", ["vitest"], {
      maxLines: 3,
      maxChars: 23,
    });

    expect(result).toBeNull();
  });
});
