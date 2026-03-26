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
  it("summarizes successful builds", () => {
    const output = ["Compiling app v0.1.0", "Finished"].join("\n");
    const result = filterBuildOutput(output, "cargo build");
    expect(result).toBe("✓ Build successful (1 units compiled)");
  });

  it("summarizes build errors and warnings", () => {
    const output = [
      "Compiling app v0.1.0",
      "error: missing value",
      "  --> src/main.rs:1:1",
      "warning: unused variable",
    ].join("\n");

    const result = filterBuildOutput(output, "cargo build");
    expect(result).toContain("❌ 1 error(s):");
    expect(result).toContain("error: missing value");
    expect(result).toContain("⚠️  1 warning(s)");
  });

  it("returns null when command is not a build", () => {
    const result = filterBuildOutput("output", "echo hello");
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
  it("summarizes results and failures", () => {
    const output = [
      "running 3 tests",
      "test alpha ... ok",
      "test beta ... FAILED",
      "FAIL beta",
      "  AssertionError: expected 1",
      "",
      "2 passed, 1 failed",
    ].join("\n");

    const result = aggregateTestOutput(output, "cargo test");
    expect(result).toContain("📋 Test Results:");
    expect(result).toContain("✅ 2 passed");
    expect(result).toContain("❌ 1 failed");
    expect(result).toContain("Failures:");
    expect(result).toContain("FAIL beta");
  });

  it("returns null when command is not a test", () => {
    const result = aggregateTestOutput("output", "echo hello");
    expect(result).toBeNull();
  });
});
