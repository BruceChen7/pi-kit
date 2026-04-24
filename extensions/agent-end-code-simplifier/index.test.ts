import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCodeSimplifierPrompt,
  collectSupportedPaths,
  DEFAULT_PROMPT_TEMPLATE,
  DEFAULT_SUPPORTED_EXTENSIONS,
  isSupportedCodePath,
  normalizeConfig,
} from "./index.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("../shared/logger.ts");
  vi.doUnmock("../shared/settings.ts");
});

describe("normalizeConfig", () => {
  it("uses defaults when settings are missing", () => {
    expect(normalizeConfig({})).toEqual({
      enabled: true,
      extensions: [...DEFAULT_SUPPORTED_EXTENSIONS],
      promptTemplate: DEFAULT_PROMPT_TEMPLATE,
    });
  });

  it("merges base and extra extensions", () => {
    const config = normalizeConfig({
      agentEndCodeSimplifier: {
        enabled: false,
        extensions: ["ts", ".py"],
        extraExtensions: [".rb", "ts"],
        promptTemplate: "custom {{files}}",
      },
    });

    expect(config).toEqual({
      enabled: false,
      extensions: [".ts", ".py", ".rb"],
      promptTemplate: "custom {{files}}",
    });
  });
});

describe("isSupportedCodePath", () => {
  it("matches supported extensions case-insensitively", () => {
    expect(isSupportedCodePath("src/App.TS", { extensions: [".ts"] })).toBe(
      true,
    );
    expect(isSupportedCodePath("src/App.md", { extensions: [".ts"] })).toBe(
      false,
    );
  });
});

describe("collectSupportedPaths", () => {
  it("filters non-code files and de-duplicates paths", () => {
    expect(
      collectSupportedPaths(["a.ts", "b.py", "README.md", "a.ts"], {
        extensions: [".ts", ".py"],
      }),
    ).toEqual(["a.ts", "b.py"]);
  });
});

describe("buildCodeSimplifierPrompt", () => {
  it("injects changed file paths into the prompt template", () => {
    expect(
      buildCodeSimplifierPrompt(["a.ts", "b.py"], "files:\n{{files}}"),
    ).toBe("files:\n- a.ts\n- b.py");
  });
});

describe("extension diagnostics", () => {
  it("logs why agent_end skips when UI is unavailable", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    vi.doMock("../shared/logger.ts", () => ({
      createLogger: () => logger,
    }));
    vi.doMock("../shared/settings.ts", () => ({
      loadSettings: () => ({ merged: {} }),
    }));

    const extension = (await import("./index.ts")).default;
    const handlers = new Map<
      string,
      (event: unknown, ctx: unknown) => unknown
    >();
    extension({
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        handlers.set(name, handler);
      },
      sendUserMessage: vi.fn(),
    } as never);

    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      ui: { confirm: vi.fn() },
    };
    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("tool_result")?.(
      {
        isError: false,
        toolName: "edit",
        input: { path: "extensions/demo.ts" },
      },
      ctx,
    );
    await handlers.get("agent_end")?.({ messages: [] }, ctx);

    expect(logger.debug).toHaveBeenCalledWith(
      "agent_end_skipped_no_ui",
      expect.objectContaining({
        cwd: process.cwd(),
        modifiedPaths: ["extensions/demo.ts"],
      }),
    );
  });
});
