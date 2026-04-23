import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-ai", () => ({
  complete: vi.fn(),
}));

import { complete } from "@mariozechner/pi-ai";

import { generateKebabCaseIdFromDescription } from "./ai.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(complete).mockReset();
});

describe("shared ai", () => {
  it("generates a kebab-case id from the active model", async () => {
    vi.mocked(complete).mockResolvedValue({
      content: [{ type: "text", text: "status-banner-fix" }],
    } as never);

    const result = await generateKebabCaseIdFromDescription(
      {
        model: {
          id: "test-model",
          provider: "openai",
          api: "openai-responses",
          reasoning: true,
        },
        modelRegistry: {
          getApiKeyAndHeaders: vi.fn(async () => ({
            ok: true,
            apiKey: "test-key",
            headers: { "x-test": "1" },
          })),
        },
      } as never,
      "Fix status banner",
    );

    expect(result).toBe("status-banner-fix");
    expect(complete).toHaveBeenCalled();
  });

  it("returns null when there is no active model", async () => {
    const result = await generateKebabCaseIdFromDescription(
      {
        model: null,
        modelRegistry: {
          getApiKeyAndHeaders: vi.fn(),
        },
      } as never,
      "Fix status banner",
    );

    expect(result).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });
});
