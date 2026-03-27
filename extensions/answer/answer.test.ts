import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";

describe("selectExtractionModel", () => {
  it("prefers codex when getApiKeyAndHeaders resolves auth", async () => {
    const mod = (await import("./answer.js")) as {
      selectExtractionModel?: (
        currentModel: Model<Api>,
        modelRegistry: {
          find: (provider: string, modelId: string) => Model<Api> | undefined;
          getApiKeyAndHeaders: (
            model: Model<Api>,
          ) => Promise<
            | { ok: true; apiKey?: string; headers?: Record<string, string> }
            | { ok: false; error: string }
          >;
        },
      ) => Promise<Model<Api>>;
    };

    const selectExtractionModel = mod.selectExtractionModel;
    expect(selectExtractionModel).toBeDefined();
    if (!selectExtractionModel) {
      throw new Error("selectExtractionModel not exported");
    }

    const codexModel = {
      id: "gpt-5.1-codex-mini",
      provider: "openai-codex",
    } as Model<Api>;

    const currentModel = {
      id: "current-model",
      provider: "openai",
    } as Model<Api>;

    const modelRegistry = {
      find: (provider: string, modelId: string) =>
        provider === "openai-codex" && modelId === "gpt-5.1-codex-mini"
          ? codexModel
          : undefined,
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "test-key",
        headers: { "x-test": "1" },
      }),
    };

    const selected = await selectExtractionModel(currentModel, modelRegistry);

    expect(selected).toBe(codexModel);
  });
});
