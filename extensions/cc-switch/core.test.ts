import { describe, expect, it } from "vitest";

import { type CodexModel, catalogModelsToPiModels } from "./core.ts";

const ALL_LEVELS_NULL = {
  off: null,
  minimal: null,
  low: null,
  medium: null,
  high: null,
  xhigh: null,
  max: null,
};

function makeModel(overrides: Partial<CodexModel> = {}): CodexModel {
  return {
    slug: "llm-gateway--deepseek-v4-flash",
    display_name: "deepseek-v4-flash (LLM Gateway)",
    context_window: 131072,
    max_context_window: 1048576,
    input_modalities: ["text"],
    supported_reasoning_levels: [
      { effort: "low", description: "Fast responses" },
      { effort: "medium", description: "Balanced" },
      { effort: "high", description: "Deep" },
      { effort: "xhigh", description: "Extra deep" },
    ],
    ...overrides,
  };
}

describe("catalogModelsToPiModels", () => {
  it("maps catalog reasoning levels into an exact thinkingLevelMap", () => {
    const [model] = catalogModelsToPiModels([
      makeModel({
        supported_reasoning_levels: [
          { effort: "low", description: "" },
          { effort: "high", description: "" },
          { effort: "max", description: "" },
          { effort: "ultra", description: "" }, // pi has no such level
        ],
      }),
    ]);

    expect(model.thinkingLevelMap).toEqual({
      ...ALL_LEVELS_NULL,
      low: "low",
      high: "high",
      max: "max",
    });
  });

  it("hides levels the catalog does not list (max stays unselectable)", () => {
    const [model] = catalogModelsToPiModels([makeModel()]);

    expect(model.thinkingLevelMap).toEqual({
      ...ALL_LEVELS_NULL,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    });
  });

  it("survives a model without reasoning levels (all levels hidden)", () => {
    const [model] = catalogModelsToPiModels([
      makeModel({ supported_reasoning_levels: [] }),
    ]);

    expect(model.thinkingLevelMap).toEqual(ALL_LEVELS_NULL);
    expect(model.reasoning).toBe(true);
  });

  it("drops entries without a usable slug instead of failing registration", () => {
    const models = catalogModelsToPiModels([
      makeModel(),
      makeModel({ slug: "" }),
      makeModel({ slug: "   " }),
      {} as CodexModel,
    ]);

    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("llm-gateway--deepseek-v4-flash");
  });

  it("falls back to the slug as display name when display_name is missing", () => {
    const [model] = catalogModelsToPiModels([
      makeModel({ display_name: undefined }),
    ]);

    expect(model.name).toBe("llm-gateway--deepseek-v4-flash");
  });

  it("derives image input from input_modalities", () => {
    const [textOnly] = catalogModelsToPiModels([makeModel()]);
    const [withImage] = catalogModelsToPiModels([
      makeModel({ input_modalities: ["text", "image"] }),
    ]);

    expect(textOnly.input).toEqual(["text"]);
    expect(withImage.input).toEqual(["text", "image"]);
  });

  it("prefers max_context_window, then context_window, then the default", () => {
    const [preferred] = catalogModelsToPiModels([makeModel()]);
    const [fallback] = catalogModelsToPiModels([
      makeModel({ max_context_window: 0 }),
    ]);
    const [defaulted] = catalogModelsToPiModels([
      makeModel({ max_context_window: 0, context_window: 0 }),
    ]);

    expect(preferred.contextWindow).toBe(1048576);
    expect(fallback.contextWindow).toBe(131072);
    expect(defaulted.contextWindow).toBe(1048576);
  });

  it("produces a complete registerable pi model config", () => {
    const [model] = catalogModelsToPiModels([makeModel()]);

    expect(model).toMatchObject({
      id: "llm-gateway--deepseek-v4-flash",
      name: "deepseek-v4-flash (LLM Gateway)",
      reasoning: true,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      maxTokens: 131072,
      compat: {
        supportsDeveloperRole: false,
        requiresAssistantAfterToolResult: false,
      },
    });
  });
});
