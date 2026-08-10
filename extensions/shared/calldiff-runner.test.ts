import { describe, expect, it } from "vitest";
import {
  buildCalldiffArgs,
  resolveCalldiffCommand,
} from "./calldiff-runner.ts";

describe("buildCalldiffArgs", () => {
  it("builds a plain diff with no refs (HEAD vs worktree)", () => {
    expect(buildCalldiffArgs({ cwd: "/x" })).toEqual([
      "diff",
      "--format",
      "json",
    ]);
  });

  it("adds from/to refs for diff mode", () => {
    expect(
      buildCalldiffArgs({ cwd: "/x", from: "main", to: "feature" }),
    ).toEqual(["diff", "main", "feature", "--format", "json"]);
  });

  it("adds entries, maxDepth and trailing path filters", () => {
    const args = buildCalldiffArgs({
      cwd: "/x",
      from: "main",
      entries: ["createAgentSession", "boot"],
      paths: ["src/lib", "examples/checkout"],
      maxDepth: 8,
    });
    expect(args).toEqual([
      "diff",
      "main",
      "--format",
      "json",
      "--max-depth",
      "8",
      "--entry",
      "createAgentSession",
      "--entry",
      "boot",
      "src/lib",
      "examples/checkout",
    ]);
  });

  it("uses the single ref slot for tree mode", () => {
    expect(
      buildCalldiffArgs({
        cwd: "/x",
        mode: "tree",
        from: "HEAD",
        entries: ["boot"],
      }),
    ).toEqual(["tree", "HEAD", "--format", "json", "--entry", "boot"]);
  });

  it("adds the reach target after the entry", () => {
    const args = buildCalldiffArgs({
      cwd: "/x",
      mode: "reach",
      from: "HEAD",
      entries: ["runCheckout"],
      target: "sendEmail",
    });
    expect(args).toEqual([
      "reach",
      "HEAD",
      "--format",
      "json",
      "--entry",
      "runCheckout",
      "--to",
      "sendEmail",
    ]);
  });
});

describe("resolveCalldiffCommand", () => {
  it("prefers an explicit configured bin", () => {
    expect(resolveCalldiffCommand({ bin: "/opt/calldiff" })).toEqual([
      "/opt/calldiff",
    ]);
    expect(
      resolveCalldiffCommand({ bin: "/opt/calldiff", preferNpxFallback: true }),
    ).toEqual(["/opt/calldiff"]);
  });

  it("defaults to calldiff on PATH", () => {
    expect(resolveCalldiffCommand({})).toEqual(["calldiff"]);
  });

  it("falls back to npx only when asked", () => {
    expect(resolveCalldiffCommand({ preferNpxFallback: true })).toEqual([
      "npx",
      "--yes",
      "calldiff@latest",
    ]);
  });
});
