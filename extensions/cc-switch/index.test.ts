import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

function createTempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-switch-home-"));
  tempDirs.push(home);
  vi.stubEnv("HOME", home);
  return home;
}

function writeCatalog(home: string, content: string): void {
  const dir = path.join(home, ".codex");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ais-switch-model-catalog.json"), content);
}

function stubProxyModels(models: unknown[]): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: models }),
  }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function createApi(): {
  api: ExtensionAPI;
  registerProvider: ReturnType<typeof vi.fn>;
} {
  const registerProvider = vi.fn();
  const api = {
    registerProvider,
    registerCommand: vi.fn(),
  } as unknown as ExtensionAPI;
  return { api, registerProvider };
}

function registeredModels(registerProvider: ReturnType<typeof vi.fn>) {
  return registerProvider.mock.calls[0]?.[1]?.models ?? [];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("cc-switch extension bootstrap", () => {
  it("uses the live proxy model list", async () => {
    const fetch = stubProxyModels([
      { id: "proxy-model", object: "model", owned_by: "test" },
    ]);
    createTempHome();

    const { default: extension } = await import("./index.ts");
    const { api, registerProvider } = createApi();

    await extension(api);

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:15721/v1/models",
      expect.objectContaining({
        headers: { Authorization: "Bearer PROXY_MANAGED" },
      }),
    );
    expect(registeredModels(registerProvider)).toEqual([
      expect.objectContaining({ id: "proxy-model", reasoning: false }),
    ]);
  });

  it("adds thinking levels for models listed in the cc_switch catalog", async () => {
    stubProxyModels([{ id: "proxy-model" }, { id: "catalog-less-model" }]);
    const home = createTempHome();
    writeCatalog(
      home,
      JSON.stringify({
        models: [
          {
            slug: "proxy-model",
            context_window: 272000,
            input_modalities: ["text", "image"],
            supported_reasoning_levels: [
              { effort: "low", description: "Fast responses" },
              { effort: "high", description: "Greater reasoning depth" },
            ],
          },
        ],
      }),
    );

    const { default: extension } = await import("./index.ts");
    const { api, registerProvider } = createApi();

    await extension(api);

    expect(registeredModels(registerProvider)).toEqual([
      expect.objectContaining({
        id: "proxy-model",
        reasoning: true,
        contextWindow: 272000,
        input: ["text", "image"],
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: "low",
          medium: null,
          high: "high",
          xhigh: null,
          max: null,
        },
      }),
      expect.objectContaining({
        id: "catalog-less-model",
        reasoning: false,
        contextWindow: 1048576,
        input: ["text"],
      }),
    ]);
  });

  it("registers non-reasoning models when the catalog is unreadable", async () => {
    stubProxyModels([{ id: "proxy-model" }]);
    const home = createTempHome();
    writeCatalog(home, "{ not json");

    const { default: extension } = await import("./index.ts");
    const { api, registerProvider } = createApi();

    await extension(api);

    expect(registeredModels(registerProvider)).toEqual([
      expect.objectContaining({ id: "proxy-model", reasoning: false }),
    ]);
  });
});
