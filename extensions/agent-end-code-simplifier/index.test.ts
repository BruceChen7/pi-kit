import { describe, expect, it } from "vitest";
import {
  buildCodeSimplifierPrompt,
  collectSupportedPaths,
  DEFAULT_PROMPT_TEMPLATE,
  DEFAULT_SUPPORTED_EXTENSIONS,
  isSupportedCodePath,
  normalizeConfig,
} from "./index.js";

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
