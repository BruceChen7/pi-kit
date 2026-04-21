import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";

type ExtractionRegistry = {
  find: (provider: string, modelId: string) => Model<Api> | undefined;
  getApiKeyAndHeaders: (
    model: Model<Api>,
  ) => Promise<
    | { ok: true; apiKey?: string; headers?: Record<string, string> }
    | { ok: false; error: string }
  >;
  isUsingOAuth?: (model: Model<Api>) => boolean;
};

async function loadSelectExtractionModel(): Promise<
  (
    currentModel: Model<Api>,
    modelRegistry: ExtractionRegistry,
  ) => Promise<Model<Api>>
> {
  const mod = (await import("./answer.js")) as {
    selectExtractionModel?: (
      currentModel: Model<Api>,
      modelRegistry: ExtractionRegistry,
    ) => Promise<Model<Api>>;
  };

  const selectExtractionModel = mod.selectExtractionModel;
  expect(selectExtractionModel).toBeDefined();
  if (!selectExtractionModel) {
    throw new Error("selectExtractionModel not exported");
  }

  return selectExtractionModel;
}

describe("selectExtractionModel", () => {
  it("prefers codex when getApiKeyAndHeaders resolves auth", async () => {
    const selectExtractionModel = await loadSelectExtractionModel();

    const codexModel = {
      id: "gpt-5.1-codex-mini",
      provider: "openai-codex",
    } as Model<Api>;

    const currentModel = {
      id: "current-model",
      provider: "openai",
    } as Model<Api>;

    const modelRegistry: ExtractionRegistry = {
      find: (provider: string, modelId: string) =>
        provider === "openai-codex" && modelId === "gpt-5.1-codex-mini"
          ? codexModel
          : undefined,
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "test-key",
        headers: { "x-test": "1" },
      }),
      isUsingOAuth: () => false,
    };

    const selected = await selectExtractionModel(currentModel, modelRegistry);

    expect(selected).toBe(codexModel);
  });

  it("uses the current codex model for OAuth accounts instead of the hard-coded codex mini", async () => {
    const selectExtractionModel = await loadSelectExtractionModel();

    const codexMiniModel = {
      id: "gpt-5.1-codex-mini",
      provider: "openai-codex",
    } as Model<Api>;

    const currentModel = {
      id: "codex-pro",
      provider: "openai-codex",
    } as Model<Api>;

    const modelRegistry: ExtractionRegistry = {
      find: (provider: string, modelId: string) =>
        provider === "openai-codex" && modelId === "gpt-5.1-codex-mini"
          ? codexMiniModel
          : undefined,
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "oauth-token",
      }),
      isUsingOAuth: (model: Model<Api>) => model.provider === "openai-codex",
    };

    const selected = await selectExtractionModel(currentModel, modelRegistry);

    expect(selected).toBe(currentModel);
  });

  it("falls back to haiku when codex mini is only available through OAuth and the current model is not codex", async () => {
    const selectExtractionModel = await loadSelectExtractionModel();

    const codexMiniModel = {
      id: "gpt-5.1-codex-mini",
      provider: "openai-codex",
    } as Model<Api>;
    const haikuModel = {
      id: "claude-haiku-4-5",
      provider: "anthropic",
    } as Model<Api>;
    const currentModel = {
      id: "gpt-4.1",
      provider: "openai",
    } as Model<Api>;

    const modelRegistry: ExtractionRegistry = {
      find: (provider: string, modelId: string) => {
        if (provider === "openai-codex" && modelId === "gpt-5.1-codex-mini") {
          return codexMiniModel;
        }
        if (provider === "anthropic" && modelId === "claude-haiku-4-5") {
          return haikuModel;
        }
        return undefined;
      },
      getApiKeyAndHeaders: async (model: Model<Api>) => {
        if (model === haikuModel) {
          return { ok: true, apiKey: "haiku-key" };
        }
        return { ok: true, apiKey: "oauth-token" };
      },
      isUsingOAuth: (model: Model<Api>) => model.provider === "openai-codex",
    };

    const selected = await selectExtractionModel(currentModel, modelRegistry);

    expect(selected).toBe(haikuModel);
  });
});
