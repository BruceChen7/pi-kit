import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import gitRead from "./index.js";

const tempDirs: string[] = [];

type Tool = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: unknown,
    onUpdate: unknown,
    ctx: { cwd: string },
  ) => Promise<{ content: Array<{ text: string }> }>;
};

const build = () => {
  const tools: Tool[] = [];
  const pi = {
    registerTool: (tool: Tool) => {
      tools.push(tool);
    },
  };
  gitRead(pi as unknown as ExtensionAPI);
  if (tools.length !== 1) {
    throw new Error(`expected one tool, got ${tools.length}`);
  }
  return tools[0];
};

const call = async (
  tool: Tool,
  command: unknown,
  cwd: string,
): Promise<string> => {
  const result = await tool.execute(
    "call-1",
    { command },
    undefined,
    undefined,
    {
      cwd,
    },
  );
  return result.content[0]?.text ?? "";
};

const makeRepo = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-git-read-"));
  tempDirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  git("add", ".");
  git("commit", "-qm", "first commit");
  return dir;
};

beforeEach(() => {
  tempDirs.length = 0;
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("git_read tool", () => {
  it("registers under the name the reviewer profile grants", () => {
    expect(build().name).toBe("git_read");
  });

  it("runs an accepted command and returns its output", async () => {
    const repo = makeRepo();
    const text = await call(build(), "git log --oneline -n 1", repo);
    expect(text).toContain("first commit");
  });

  it("reports a refusal without touching git", async () => {
    const repo = makeRepo();
    const text = await call(build(), "git push origin main", repo);
    expect(text.startsWith("REFUSED:")).toBe(true);
    expect(text).toContain("Only git diff, git show, git log");
  });

  it("surfaces a real git failure as a refusal", async () => {
    const repo = makeRepo();
    const text = await call(build(), "git show does-not-exist", repo);
    expect(text.startsWith("REFUSED:")).toBe(true);
    expect(text).toContain("failed");
  });

  it("falls back to HEAD when the default range does not exist", async () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
    const text = await call(build(), "git diff", repo);
    expect(text).toContain("changed");
  });
});
