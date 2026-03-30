import { describe, expect, it, vi } from "vitest";
import {
  computeDirtySummary,
  DEFAULT_COMMIT_MESSAGE,
  runCommitPipeline,
  type StatusOutput,
  selectCommitMessage,
  shouldPromptForDirtyRepo,
} from "./index.js";

const ok = (stdout = ""): StatusOutput => ({
  exitCode: 0,
  stdout,
  stderr: "",
});

const fail = (stderr: string): StatusOutput => ({
  exitCode: 1,
  stdout: "",
  stderr,
});

describe("computeDirtySummary", () => {
  it("counts staged, unstaged and untracked files", () => {
    const summary = computeDirtySummary(
      ["M  staged.ts", " M unstaged.ts", "MM both.ts", "?? new.ts"].join("\n"),
    );

    expect(summary).toEqual({
      staged: 2,
      unstaged: 2,
      untracked: 1,
      dirty: true,
    });
  });

  it("is clean when porcelain output is empty", () => {
    expect(computeDirtySummary("\n")).toEqual({
      staged: 0,
      unstaged: 0,
      untracked: 0,
      dirty: false,
    });
  });
});

describe("shouldPromptForDirtyRepo", () => {
  it("prompts once while dirty and resets once clean", () => {
    const first = shouldPromptForDirtyRepo({
      porcelain: " M file.ts",
      alreadyPrompted: false,
    });
    expect(first).toEqual({ shouldPrompt: true, nextPrompted: true });

    const second = shouldPromptForDirtyRepo({
      porcelain: " M file.ts",
      alreadyPrompted: true,
    });
    expect(second).toEqual({ shouldPrompt: false, nextPrompted: true });

    const cleaned = shouldPromptForDirtyRepo({
      porcelain: "",
      alreadyPrompted: true,
    });
    expect(cleaned).toEqual({ shouldPrompt: false, nextPrompted: false });
  });
});

describe("selectCommitMessage", () => {
  it("uses default message in auto mode", () => {
    expect(
      selectCommitMessage({
        mode: "auto",
        hasUI: true,
        defaultMessage: DEFAULT_COMMIT_MESSAGE,
        userInput: "feat: ignored",
      }),
    ).toEqual({
      message: DEFAULT_COMMIT_MESSAGE,
      usedDefault: true,
      cancelled: false,
    });
  });

  it("prefers user message in auto_with_override mode", () => {
    expect(
      selectCommitMessage({
        mode: "auto_with_override",
        hasUI: true,
        defaultMessage: DEFAULT_COMMIT_MESSAGE,
        userInput: "fix: apply patch",
      }),
    ).toEqual({
      message: "fix: apply patch",
      usedDefault: false,
      cancelled: false,
    });
  });

  it("returns cancelled when ask mode has no UI input", () => {
    expect(
      selectCommitMessage({
        mode: "ask",
        hasUI: true,
        defaultMessage: DEFAULT_COMMIT_MESSAGE,
        userInput: "   ",
      }),
    ).toEqual({
      message: null,
      usedDefault: false,
      cancelled: true,
    });
  });

  it("falls back to default in ask mode when no UI", () => {
    expect(
      selectCommitMessage({
        mode: "ask",
        hasUI: false,
        defaultMessage: DEFAULT_COMMIT_MESSAGE,
        userInput: null,
      }),
    ).toEqual({
      message: DEFAULT_COMMIT_MESSAGE,
      usedDefault: true,
      cancelled: false,
    });
  });
});

describe("runCommitPipeline", () => {
  it("runs add and commit when confirmed", async () => {
    const commands: string[] = [];
    const runGit = vi.fn((args: string[]) => {
      commands.push(args.join(" "));
      if (args[0] === "add") return ok();
      if (args[0] === "diff") return ok("file.ts\n");
      if (args[0] === "commit") return ok("[master 123] chore: auto\n");
      return fail("unexpected command");
    });

    const notifications: Array<{ message: string; level: string }> = [];

    const result = await runCommitPipeline({
      runGit,
      hasUI: true,
      confirmCommit: vi.fn(async () => true),
      askCommitMessage: vi.fn(async () => "chore: auto"),
      notify: (message, level) => {
        notifications.push({ message, level });
      },
      mode: "auto_with_override",
      defaultMessage: DEFAULT_COMMIT_MESSAGE,
      requireConfirm: true,
    });

    expect(result).toEqual({
      committed: true,
      reason: "committed",
      message: "chore: auto",
    });
    expect(commands).toEqual([
      "add -A",
      "diff --cached --name-only",
      "commit -m chore: auto",
    ]);
    expect(notifications.at(-1)?.level).toBe("success");
  });

  it("aborts when user declines confirmation", async () => {
    const runGit = vi.fn(() => ok());

    const result = await runCommitPipeline({
      runGit,
      hasUI: true,
      confirmCommit: vi.fn(async () => false),
      askCommitMessage: vi.fn(async () => "chore: auto"),
      notify: vi.fn(),
      mode: "auto",
      defaultMessage: DEFAULT_COMMIT_MESSAGE,
      requireConfirm: true,
    });

    expect(result).toEqual({
      committed: false,
      reason: "cancelled",
      message: null,
    });
    expect(runGit).not.toHaveBeenCalled();
  });

  it("returns no_staged_changes when add produced nothing", async () => {
    const runGit = vi.fn((args: string[]) => {
      if (args[0] === "add") return ok();
      if (args[0] === "diff") return ok("");
      return fail("unexpected");
    });

    const result = await runCommitPipeline({
      runGit,
      hasUI: true,
      confirmCommit: vi.fn(async () => true),
      askCommitMessage: vi.fn(async () => "chore: auto"),
      notify: vi.fn(),
      mode: "auto",
      defaultMessage: DEFAULT_COMMIT_MESSAGE,
      requireConfirm: true,
    });

    expect(result).toEqual({
      committed: false,
      reason: "no_staged_changes",
      message: null,
    });
  });

  it("classifies nothing to commit failures", async () => {
    const runGit = vi.fn((args: string[]) => {
      if (args[0] === "add") return ok();
      if (args[0] === "diff") return ok("file.ts\n");
      if (args[0] === "commit") {
        return fail("nothing to commit, working tree clean");
      }
      return fail("unexpected");
    });

    const result = await runCommitPipeline({
      runGit,
      hasUI: false,
      confirmCommit: vi.fn(async () => true),
      askCommitMessage: vi.fn(async () => null),
      notify: vi.fn(),
      mode: "auto",
      defaultMessage: DEFAULT_COMMIT_MESSAGE,
      requireConfirm: false,
    });

    expect(result).toEqual({
      committed: false,
      reason: "nothing_to_commit",
      message: null,
    });
  });

  it("can generate a default commit message for auto mode", async () => {
    const commands: string[] = [];
    const runGit = vi.fn((args: string[]) => {
      commands.push(args.join(" "));
      if (args[0] === "add") return ok();
      if (args[0] === "diff" && args[1] === "--cached") return ok("file.ts\n");
      if (args[0] === "commit") return ok("[master 123] feat: ai\n");
      return fail("unexpected");
    });

    const getDefaultMessage = vi.fn(async () => "feat: ai");

    const result = await runCommitPipeline({
      runGit,
      hasUI: false,
      confirmCommit: vi.fn(async () => true),
      askCommitMessage: vi.fn(async () => null),
      notify: vi.fn(),
      mode: "auto",
      defaultMessage: DEFAULT_COMMIT_MESSAGE,
      requireConfirm: false,
      getDefaultMessage,
    });

    expect(result).toEqual({
      committed: true,
      reason: "committed",
      message: "feat: ai",
    });
    expect(getDefaultMessage).toHaveBeenCalledWith({
      stagedFiles: ["file.ts"],
      defaultMessage: DEFAULT_COMMIT_MESSAGE,
    });
    expect(commands).toEqual([
      "add -A",
      "diff --cached --name-only",
      "commit -m feat: ai",
    ]);
  });

  it("passes generated default message as UI prefill", async () => {
    const commands: string[] = [];
    const runGit = vi.fn((args: string[]) => {
      commands.push(args.join(" "));
      if (args[0] === "add") return ok();
      if (args[0] === "diff") return ok("file.ts\n");
      if (args[0] === "commit") return ok("[master 123] feat: ai\n");
      return fail("unexpected");
    });

    const askCommitMessage = vi.fn(async (_default: string) => "   ");

    const result = await runCommitPipeline({
      runGit,
      hasUI: true,
      confirmCommit: vi.fn(async () => true),
      askCommitMessage,
      notify: vi.fn(),
      mode: "auto_with_override",
      defaultMessage: DEFAULT_COMMIT_MESSAGE,
      requireConfirm: false,
      getDefaultMessage: async () => "feat: ai",
    });

    expect(result).toEqual({
      committed: true,
      reason: "committed",
      message: "feat: ai",
    });
    expect(askCommitMessage).toHaveBeenCalledWith("feat: ai");
    expect(commands).toEqual([
      "add -A",
      "diff --cached --name-only",
      "commit -m feat: ai",
    ]);
  });
});
