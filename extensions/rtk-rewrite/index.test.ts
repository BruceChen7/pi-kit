import { describe, expect, it } from "vitest";
import {
  applyCommandRegistryAction,
  parseCommandRegistryArgs,
  shouldSkipRewriteForRegisteredCommand,
} from "./index.js";

describe("parseCommandRegistryArgs", () => {
  it("parses add command with multi-word pattern", () => {
    expect(parseCommandRegistryArgs("add turbo build")).toEqual({
      ok: true,
      value: {
        action: "add",
        pattern: "turbo build",
      },
    });
  });

  it("parses clear and list without pattern", () => {
    expect(parseCommandRegistryArgs("clear")).toEqual({
      ok: true,
      value: {
        action: "clear",
      },
    });

    expect(parseCommandRegistryArgs("list")).toEqual({
      ok: true,
      value: {
        action: "list",
      },
    });
  });

  it("returns error for invalid action", () => {
    expect(parseCommandRegistryArgs("build add npm run build")).toEqual({
      ok: false,
      error: "Action must be add, remove, clear, or list.",
    });
  });

  it("returns error for add/remove without pattern", () => {
    expect(parseCommandRegistryArgs("add")).toEqual({
      ok: false,
      error: "Pattern is required for add/remove.",
    });

    expect(parseCommandRegistryArgs("remove")).toEqual({
      ok: false,
      error: "Pattern is required for add/remove.",
    });
  });
});

describe("applyCommandRegistryAction", () => {
  const initialCommands = ["cargo build", "vitest"];

  it("adds normalized command entries", () => {
    const result = applyCommandRegistryAction(initialCommands, {
      action: "add",
      pattern: "  Turbo Build  ",
    });

    expect(result.changed).toBe(true);
    expect(result.commands).toEqual(["cargo build", "vitest", "turbo build"]);
  });

  it("removes command entries", () => {
    const result = applyCommandRegistryAction(initialCommands, {
      action: "remove",
      pattern: "VITEST",
    });

    expect(result.changed).toBe(true);
    expect(result.commands).toEqual(["cargo build"]);
  });

  it("clears command list", () => {
    const result = applyCommandRegistryAction(initialCommands, {
      action: "clear",
    });

    expect(result.changed).toBe(true);
    expect(result.commands).toEqual([]);
  });

  it("does not change list for list action", () => {
    const result = applyCommandRegistryAction(initialCommands, {
      action: "list",
    });

    expect(result.changed).toBe(false);
    expect(result.commands).toEqual(initialCommands);
  });
});

describe("shouldSkipRewriteForRegisteredCommand", () => {
  const commands = ["npm run build", "vitest"];

  it("returns false when the switch is enabled", () => {
    expect(
      shouldSkipRewriteForRegisteredCommand("npm run build", {
        rewriteMatchedRegisteredCommands: true,
        commands,
      }),
    ).toBe(false);
  });

  it("returns true for matched commands when switch is disabled", () => {
    expect(
      shouldSkipRewriteForRegisteredCommand("npm run build", {
        rewriteMatchedRegisteredCommands: false,
        commands,
      }),
    ).toBe(true);

    expect(
      shouldSkipRewriteForRegisteredCommand("vitest run", {
        rewriteMatchedRegisteredCommands: false,
        commands,
      }),
    ).toBe(true);
  });

  it("returns false for unmatched commands when switch is disabled", () => {
    expect(
      shouldSkipRewriteForRegisteredCommand("git status", {
        rewriteMatchedRegisteredCommands: false,
        commands,
      }),
    ).toBe(false);
  });
});
