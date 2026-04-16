import { describe, expect, it } from "vitest";
import {
  applyCommandRegistryAction,
  type CommandRegistry,
  parseCommandRegistryArgs,
  shouldSkipRewriteForBuildTestCommand,
} from "./index.js";

describe("parseCommandRegistryArgs", () => {
  it("parses add command with multi-word pattern", () => {
    expect(parseCommandRegistryArgs("build add turbo build")).toEqual({
      ok: true,
      value: {
        scope: "build",
        action: "add",
        pattern: "turbo build",
      },
    });
  });

  it("parses clear and list without pattern", () => {
    expect(parseCommandRegistryArgs("test clear")).toEqual({
      ok: true,
      value: {
        scope: "test",
        action: "clear",
      },
    });

    expect(parseCommandRegistryArgs("build list")).toEqual({
      ok: true,
      value: {
        scope: "build",
        action: "list",
      },
    });
  });

  it("returns error for invalid scope", () => {
    expect(parseCommandRegistryArgs("all add npm run build")).toEqual({
      ok: false,
      error: "Scope must be build or test.",
    });
  });

  it("returns error for add/remove without pattern", () => {
    expect(parseCommandRegistryArgs("build add")).toEqual({
      ok: false,
      error: "Pattern is required for add/remove.",
    });

    expect(parseCommandRegistryArgs("test remove")).toEqual({
      ok: false,
      error: "Pattern is required for add/remove.",
    });
  });
});

describe("applyCommandRegistryAction", () => {
  const initialRegistry: CommandRegistry = {
    build: ["cargo build"],
    test: ["vitest"],
  };

  it("adds normalized command entries", () => {
    const result = applyCommandRegistryAction(initialRegistry, {
      scope: "build",
      action: "add",
      pattern: "  Turbo Build  ",
    });

    expect(result.changed).toBe(true);
    expect(result.registry.build).toEqual(["cargo build", "turbo build"]);
    expect(result.registry.test).toEqual(["vitest"]);
  });

  it("removes command entries", () => {
    const result = applyCommandRegistryAction(initialRegistry, {
      scope: "test",
      action: "remove",
      pattern: "VITEST",
    });

    expect(result.changed).toBe(true);
    expect(result.registry).toEqual({
      build: ["cargo build"],
      test: [],
    });
  });

  it("clears a scoped list", () => {
    const result = applyCommandRegistryAction(initialRegistry, {
      scope: "build",
      action: "clear",
    });

    expect(result.changed).toBe(true);
    expect(result.registry).toEqual({
      build: [],
      test: ["vitest"],
    });
  });

  it("does not change registry for list action", () => {
    const result = applyCommandRegistryAction(initialRegistry, {
      scope: "build",
      action: "list",
    });

    expect(result.changed).toBe(false);
    expect(result.registry).toEqual(initialRegistry);
  });
});

describe("shouldSkipRewriteForBuildTestCommand", () => {
  const registry: CommandRegistry = {
    build: ["npm run build", "cargo build"],
    test: ["vitest", "cargo test"],
  };

  it("returns false when the switch is enabled", () => {
    expect(
      shouldSkipRewriteForBuildTestCommand("npm run build", {
        rewriteMatchedBuildTestCommands: true,
        commandRegistry: registry,
      }),
    ).toBe(false);
  });

  it("returns true for matched commands when switch is disabled", () => {
    expect(
      shouldSkipRewriteForBuildTestCommand("npm run build", {
        rewriteMatchedBuildTestCommands: false,
        commandRegistry: registry,
      }),
    ).toBe(true);

    expect(
      shouldSkipRewriteForBuildTestCommand("vitest run", {
        rewriteMatchedBuildTestCommands: false,
        commandRegistry: registry,
      }),
    ).toBe(true);
  });

  it("returns false for unmatched commands when switch is disabled", () => {
    expect(
      shouldSkipRewriteForBuildTestCommand("git status", {
        rewriteMatchedBuildTestCommands: false,
        commandRegistry: registry,
      }),
    ).toBe(false);
  });
});
