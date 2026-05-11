import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearBashHooks, runBashHooks } from "../shared/bash-hook.js";
import { clearSettingsCache, getSettingsPaths } from "../shared/settings.js";
import rtkRewriteExtension, {
  applyCommandRegistryAction,
  buildStatusMessage,
  parseCommandRegistryArgs,
  shouldSkipRewriteForRegisteredCommand,
} from "./index.js";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;

const registerTempDir = (dir: string): string => {
  tempDirs.push(dir);
  return dir;
};

const createTempDir = (prefix: string): string =>
  registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

const createTempHome = (): string => {
  const dir = createTempDir("pi-kit-rtk-rewrite-home-");
  process.env.HOME = dir;
  return dir;
};

const restoreHome = (): void => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
};

const writeGlobalRtkConfig = (
  cwd: string,
  rtkRewrite: Record<string, unknown>,
): void => {
  const { globalPath } = getSettingsPaths(cwd);
  fs.mkdirSync(path.dirname(globalPath), { recursive: true });
  fs.writeFileSync(
    globalPath,
    JSON.stringify({ rtkRewrite }, null, 2),
    "utf-8",
  );
};

const createContext = (
  cwd: string,
): ExtensionContext & ExtensionCommandContext =>
  ({
    cwd,
    hasUI: true,
    ui: {
      notify: vi.fn(),
    },
  }) as unknown as ExtensionContext & ExtensionCommandContext;

afterEach(() => {
  clearBashHooks();
  clearSettingsCache();
  restoreHome();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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

describe("buildStatusMessage", () => {
  const baseConfig = {
    enabled: true,
    mode: "rewrite" as const,
    notify: true,
    exclude: ["git"],
    outputFiltering: true,
    rewriteMatchedRegisteredCommands: false,
    commands: ["npm run build", "vitest"],
    outputTailMaxLines: 30,
    outputTailMaxChars: 4000,
  };

  it("includes explicit enabled/disabled state with config snapshot", () => {
    const message = buildStatusMessage(
      {
        ...baseConfig,
        enabled: false,
      },
      "RTK rewrite disabled.",
      999,
    );

    expect(message).toContain("RTK rewrite disabled.");
    expect(message).toContain("RTK rewrite disabled");
    expect(message).toContain("mode rewrite");
    expect(message).toContain("notify on");
    expect(message).toContain("exclude: git");
    expect(message).toContain("matched command rewrite off");
    expect(message).toContain("output filter on");
    expect(message).toContain("tail caps: lines 30, chars 4000");
  });

  it("truncates long status message with ellipsis", () => {
    const message = buildStatusMessage(
      {
        ...baseConfig,
        exclude: ["a".repeat(120)],
      },
      "RTK rewrite enabled.",
      90,
    );

    expect(message.length).toBe(90);
    expect(message.endsWith("...")).toBe(true);
  });
});

type TestCommandRegistration = {
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
};

describe("suggest mode", () => {
  it("notifies with the rewritten command without changing the executed command", async () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-rtk-rewrite-cwd-");
    writeGlobalRtkConfig(cwd, {
      enabled: true,
      mode: "suggest",
      notify: true,
    });

    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "rtk git status\n",
      stderr: "",
    });
    rtkRewriteExtension({
      exec,
      on: vi.fn(),
      registerCommand: vi.fn(),
    } as unknown as ExtensionAPI);

    const ctx = createContext(cwd);
    const result = await runBashHooks({
      command: "git status",
      cwd,
      ctx,
      source: "tool",
    });

    expect(result.command).toBe("git status");
    expect(result.applied).toEqual([]);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "RTK suggestion: git status → rtk git status",
      "info",
    );
  });

  it("registers a command that switches the rewrite mode", async () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-rtk-rewrite-cwd-");
    writeGlobalRtkConfig(cwd, {
      enabled: true,
      mode: "rewrite",
      notify: true,
    });

    const commands = new Map<string, TestCommandRegistration>();
    rtkRewriteExtension({
      exec: vi.fn(),
      on: vi.fn(),
      registerCommand: vi.fn((name, registration) => {
        commands.set(name, registration as TestCommandRegistration);
      }),
    } as unknown as ExtensionAPI);

    const ctx = createContext(cwd);
    const modeCommand = commands.get("rtk-rewrite-mode");
    expect(modeCommand).toBeDefined();
    await modeCommand?.handler("suggest", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("RTK rewrite mode set to suggest."),
      "info",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("mode suggest"),
      "info",
    );
  });
});
