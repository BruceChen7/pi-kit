import { describe, expect, it } from "vitest";

import {
  catalogProfilesBySlug,
  proxyModelsToPiModels,
  thinkingLevelMapFor,
} from "./core.ts";

describe("proxyModelsToPiModels", () => {
  it("maps provider metadata into a safe selectable pi model", () => {
    const [model] = proxyModelsToPiModels([
      {
        id: "proxy-model",
        object: "model",
        owned_by: "MaaS",
        cc_switch: { provider_name: "LLM Gateway" },
      },
    ]);

    expect(model).toMatchObject({
      id: "proxy-model",
      name: "LLM Gateway · proxy-model",
      reasoning: false,
      contextWindow: 1048576,
      maxTokens: 131072,
      input: ["text"],
    });
    expect(model.thinkingLevelMap).toBeUndefined();
  });

  it("preserves explicit model metadata and supports image input", () => {
    const [model] = proxyModelsToPiModels([
      {
        id: "  vision-model ",
        name: "Vision Model",
        context_window: 131072,
        max_context_window: 0,
        input_modalities: ["text", "image"],
      },
    ]);

    expect(model).toMatchObject({
      id: "vision-model",
      name: "Vision Model",
      reasoning: false,
      contextWindow: 131072,
      input: ["text", "image"],
    });
  });

  it("fills thinking levels, context window and image input from the catalog", () => {
    const catalog = catalogProfilesBySlug({
      models: [
        {
          slug: "gpt-5.6-luna",
          context_window: 270000,
          max_context_window: 272000,
          input_modalities: ["text", "image"],
          supported_reasoning_levels: [
            { effort: "low", description: "Fast responses" },
            { effort: "high", description: "Greater reasoning depth" },
            { effort: "ultra", description: "Not a pi thinking level" },
          ],
        },
      ],
    });

    const [model] = proxyModelsToPiModels([{ id: "gpt-5.6-luna" }], catalog);

    expect(model).toMatchObject({
      reasoning: true,
      contextWindow: 272000,
      input: ["text", "image"],
    });
    expect(model.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: null,
    });
  });

  it("prefers live proxy metadata over the catalog", () => {
    const catalog = catalogProfilesBySlug({
      models: [
        {
          slug: "proxy-model",
          context_window: 272000,
          input_modalities: ["text", "image"],
        },
      ],
    });

    const [model] = proxyModelsToPiModels(
      [
        {
          id: "proxy-model",
          context_window: 8192,
          input_modalities: ["text"],
        },
      ],
      catalog,
    );

    expect(model).toMatchObject({ contextWindow: 8192, input: ["text"] });
  });

  it("drops entries without a usable model id", () => {
    expect(
      proxyModelsToPiModels([
        null,
        {},
        { id: "" },
        { id: "   " },
        { id: "usable-model" },
      ]),
    ).toHaveLength(1);
  });
});

describe("catalogProfilesBySlug", () => {
  it("indexes normalized metadata by trimmed slug", () => {
    const profiles = catalogProfilesBySlug({
      models: [
        {
          slug: "  glm-5.3  ",
          supported_reasoning_levels: [
            { effort: "LOW", description: "low" },
            { effort: " max ", description: "max" },
          ],
          input_modalities: [" TEXT ", "Image"],
          context_window: 1_000_000,
        },
      ],
    });

    expect(profiles.get("glm-5.3")).toEqual({
      supportedEfforts: ["low", "max"],
      inputModalities: ["text", "image"],
      contextWindow: 1_000_000,
    });
  });

  it("keeps entries with an unknown context window or reasoning levels", () => {
    const profiles = catalogProfilesBySlug({
      models: [{ slug: "catalog-model" }],
    });

    expect(profiles.get("catalog-model")).toEqual({
      supportedEfforts: [],
      inputModalities: [],
    });
  });

  it("ignores entries without a usable slug and malformed fields", () => {
    const profiles = catalogProfilesBySlug({
      models: [
        null,
        { supported_reasoning_levels: [{ effort: "low" }] },
        { slug: "   " },
        {
          slug: "bad-fields",
          supported_reasoning_levels: "low",
          input_modalities: "image",
          context_window: -1,
          max_context_window: Number.NaN,
        },
      ],
    });

    expect([...profiles.keys()]).toEqual(["bad-fields"]);
    expect(profiles.get("bad-fields")).toEqual({
      supportedEfforts: [],
      inputModalities: [],
    });
  });

  it("returns an empty index for unexpected catalog shapes", () => {
    expect(catalogProfilesBySlug(null).size).toBe(0);
    expect(catalogProfilesBySlug({ models: {} }).size).toBe(0);
    expect(catalogProfilesBySlug("<html>").size).toBe(0);
  });
});

describe("thinkingLevelMapFor", () => {
  it("keeps only the levels the upstream advertises", () => {
    expect(thinkingLevelMapFor(["low", "high", "xhigh"])).toEqual({
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: "xhigh",
      max: null,
    });
  });

  it("uses the upstream no-reasoning effort for off when advertised", () => {
    expect(thinkingLevelMapFor(["none", "low"])?.off).toBe("none");
  });

  it("returns null when the model cannot reason", () => {
    expect(thinkingLevelMapFor([])).toBeNull();
    expect(thinkingLevelMapFor(["none"])).toBeNull();
    expect(thinkingLevelMapFor(["ultra"])).toBeNull();
  });
});
