import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearSettingsCache, getSettingsPaths } from "../shared/settings.js";
import {
  DEFAULT_REVIEW_MODEL,
  extractModelOverride,
  getReviewModel,
  parseModelId,
  resolveReviewModel,
} from "./review-config.js";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;

const registerTempDir = (dir: string): string => {
  tempDirs.push(dir);
  return dir;
};

const createTempDir = (prefix: string): string =>
  registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

const createTempHome = (): string => {
  const dir = createTempDir("pi-kit-review-home-");
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

const writeSettings = (
  cwd: string,
  record: unknown,
  scope: "global" | "project",
): void => {
  const { globalPath, projectPath } = getSettingsPaths(cwd);
  const file = scope === "global" ? globalPath : projectPath;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record), "utf-8");
};

afterEach(() => {
  clearSettingsCache();
  restoreHome();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveReviewModel (pure decision)", () => {
  it("defaults to kimi-k3 when nothing is configured", () => {
    expect(resolveReviewModel(undefined, undefined)).toBe(
      "cc-switch-gateway/llm-gateway--kimi-k3",
    );
    expect(resolveReviewModel({}, undefined)).toBe(
      "cc-switch-gateway/llm-gateway--kimi-k3",
    );
  });

  it("uses the configured model when present", () => {
    expect(resolveReviewModel({ model: "opencode-go/deepseek-v4-pro" })).toBe(
      "opencode-go/deepseek-v4-pro",
    );
  });

  it('returns undefined (disabled) when configured as "off"', () => {
    expect(resolveReviewModel({ model: "off" })).toBeUndefined();
  });

  it("treats an empty config value as unset (falls back to default)", () => {
    expect(resolveReviewModel({ model: "" })).toBe(DEFAULT_REVIEW_MODEL);
    expect(resolveReviewModel({ model: "   " })).toBe(DEFAULT_REVIEW_MODEL);
  });

  it("ignores a whitespace-only --model override", () => {
    expect(resolveReviewModel(undefined, "   ")).toBe(DEFAULT_REVIEW_MODEL);
  });

  it("lets --model override even an explicit off for one call", () => {
    expect(
      resolveReviewModel({ model: "off" }, "opencode-go/deepseek-v4-pro"),
    ).toBe("opencode-go/deepseek-v4-pro");
  });
});

describe("getReviewModel (settings shell)", () => {
  it("defaults to kimi-k3 when nothing is configured", () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-review-cwd-");
    expect(getReviewModel(cwd)).toBe("cc-switch-gateway/llm-gateway--kimi-k3");
  });

  it("reads the configured model from the global settings file", () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-review-cwd-");
    writeSettings(
      cwd,
      {
        third_extensions: { review: { model: "opencode-go/deepseek-v4-pro" } },
      },
      "global",
    );
    expect(getReviewModel(cwd)).toBe("opencode-go/deepseek-v4-pro");
  });

  it('returns undefined (disabled) when configured as "off"', () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-review-cwd-");
    writeSettings(
      cwd,
      {
        third_extensions: { review: { model: "off" } },
      },
      "global",
    );
    expect(getReviewModel(cwd)).toBeUndefined();
  });

  it("lets the project file override the global one", () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-review-cwd-");
    writeSettings(
      cwd,
      {
        third_extensions: {
          review: { model: "cc-switch-gateway/llm-gateway--kimi-k3" },
        },
      },
      "global",
    );
    writeSettings(
      cwd,
      {
        third_extensions: { review: { model: "deepseek/deepseek-v4-pro" } },
      },
      "project",
    );
    expect(getReviewModel(cwd)).toBe("deepseek/deepseek-v4-pro");
  });

  it("lets /review --model override the config for one call", () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-review-cwd-");
    writeSettings(
      cwd,
      {
        third_extensions: { review: { model: "off" } },
      },
      "global",
    );
    expect(getReviewModel(cwd, "opencode-go/deepseek-v4-pro")).toBe(
      "opencode-go/deepseek-v4-pro",
    );
  });
});

describe("parseModelId", () => {
  it("splits provider/id on the first slash", () => {
    expect(parseModelId("cc-switch-gateway/llm-gateway--kimi-k3")).toEqual({
      provider: "cc-switch-gateway",
      id: "llm-gateway--kimi-k3",
    });
    expect(parseModelId("opencode-go/deepseek-v4-flash")).toEqual({
      provider: "opencode-go",
      id: "deepseek-v4-flash",
    });
  });

  it("returns null for inputs without a valid slash", () => {
    expect(parseModelId("no-slash")).toBeNull();
    expect(parseModelId("")).toBeNull();
    expect(parseModelId("/leading-slash")).toBeNull();
    expect(parseModelId("provider/")).toBeNull();
  });
});

describe("extractModelOverride", () => {
  it("strips a leading --model <id>", () => {
    expect(extractModelOverride("--model X uncommitted")).toEqual({
      model: "X",
      rest: "uncommitted",
    });
    expect(extractModelOverride("--model X")).toEqual({
      model: "X",
      rest: "",
    });
  });

  it("leaves args without an override untouched", () => {
    expect(extractModelOverride("uncommitted")).toEqual({
      model: undefined,
      rest: "uncommitted",
    });
    expect(extractModelOverride("branch main")).toEqual({
      model: undefined,
      rest: "branch main",
    });
    expect(extractModelOverride(undefined)).toEqual({
      model: undefined,
      rest: "",
    });
  });
});
