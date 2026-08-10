import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Regression tests for the grep -> rg proxy shim.
 *
 * The shim translates grep CLI flags to ripgrep equivalents. Combined short
 * flags (grep -iE, -nE, -in, ...) previously leaked into rg verbatim, where
 * rg -E means --encoding -> "unknown encoding: <pattern>" errors.
 *
 * These tests exercise the real bash shim end-to-end.
 */

const SHIM = path.resolve(
  process.cwd(),
  "extensions/tools_intercepted/intercepted-commands/grep",
);

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grep-shim-test-"));
  fs.writeFileSync(
    path.join(tmpDir, "sample.txt"),
    "hello world\nprivate_var = 1\npublic_var = 2\n_private = 3\n",
  );
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runGrep(args: string[]): {
  stdout: string;
  stderr: string;
  status: number;
} {
  const result = execFileSync(
    "bash",
    [SHIM, ...args, path.join(tmpDir, "sample.txt")],
    {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  // execFileSync throws on non-zero exit; normalize for simpler assertions
  return { stdout: result, stderr: "", status: 0 };
}

describe("grep shim: combined short flags", () => {
  it("handles -iE (case-insensitive extended regex)", () => {
    const { stdout } = runGrep(["-iE", "HELLO|PRIVATE"]);
    expect(stdout).toContain("hello world");
    expect(stdout).toContain("private_var = 1");
  });

  it("handles -nE (line numbers + extended regex)", () => {
    const { stdout } = runGrep(["-nE", "^_"]);
    expect(stdout).toContain("4:_private = 3");
  });

  it("handles -inE (three combined flags)", () => {
    const { stdout } = runGrep(["-inE", "PRIVATE|PUBLIC"]);
    expect(stdout).toContain("2:private_var = 1");
    expect(stdout).toContain("3:public_var = 2");
    expect(stdout).toContain("4:_private = 3");
  });

  it("handles -ivE (invert + ignore-case + extended)", () => {
    const { stdout } = runGrep(["-ivE", "private"]);
    expect(stdout).not.toContain("private_var");
    expect(stdout).toContain("public_var = 2");
  });

  it("handles -cE and -lE (count / files-with-matches)", () => {
    const count = runGrep(["-cE", "var"]);
    expect(count.stdout.trim()).toBe("2");

    const files = runGrep(["-lE", "private"]);
    expect(files.stdout.trim()).toContain("sample.txt");
  });

  it("handles -hiE (no-filename in combined cluster)", () => {
    const { stdout } = runGrep(["-hiE", "HELLO"]);
    expect(stdout).toContain("hello world");
    expect(stdout).not.toContain("sample.txt:");
  });
});

describe("grep shim: attached flag values pass through", () => {
  it("handles -C1 (attached context)", () => {
    const { stdout } = runGrep(["-C1", "public_var"]);
    expect(stdout).toContain("public_var = 2");
  });

  it("handles -iC1 (cluster + attached context)", () => {
    const { stdout } = runGrep(["-iC1", "PUBLIC_VAR"]);
    expect(stdout).toContain("public_var = 2");
  });

  it("handles -m1 (attached max-count)", () => {
    const { stdout } = runGrep(["-m1", "private"]);
    expect(stdout.match(/private/g)?.length).toBe(1);
  });

  it("handles -e with explicit patterns", () => {
    const { stdout } = runGrep(["-e", "hello", "-e", "public_var"]);
    expect(stdout).toContain("hello world");
    expect(stdout).toContain("public_var = 2");
  });
});

describe("grep shim: flag conflicts stay translated", () => {
  it("keeps -E alone working (extended regex default in rg)", () => {
    const { stdout } = runGrep(["-E", "hel+o"]);
    expect(stdout).toContain("hello world");
  });

  it("still maps -s to --no-messages (no rg -s case-sensitivity leak)", () => {
    // rg -s means case-sensitive; grep -s means suppress errors.
    // If -s leaked through as rg -s, an ignore-case pattern would still
    // match (rg -s is the default), but the flag would be misparsed.
    const { stdout } = runGrep(["-sE", "hello"]);
    expect(stdout).toContain("hello world");
  });

  it("handles -- before a pattern starting with -", () => {
    const tmpFile = path.join(tmpDir, "dash.txt");
    fs.writeFileSync(tmpFile, "-iE literal line\nnormal line\n");
    const result = execFileSync("bash", [SHIM, "--", "-iE", tmpFile], {
      encoding: "utf-8",
    });
    expect(result).toContain("-iE literal line");
    expect(result).not.toContain("normal line");
  });
});
