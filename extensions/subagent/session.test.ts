/* biome-ignore-all lint/suspicious/noExplicitAny: pi session/loader 的测试替身必须是 any。 */
import type { Model } from "@earendil-works/pi-ai";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { AgentProfile } from "./agents.js";
import {
  bootChildSession,
  childResourceLoaderOptions,
  resolveAgentModel,
  splitModelRef,
} from "./session.js";

/** 子会话只关心「注册了哪些 provider」，不真的连网 —— 这里记下 loader 拿到什么。 */
type RecordedLoaderOptions = {
  noExtensions?: boolean;
  disabledBuiltinExtensions?: string[];
  extensionFactories?: unknown[];
  appendSystemPrompt?: string[];
  systemPrompt?: string;
};

const loaderOptions: RecordedLoaderOptions[] = [];

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: vi.fn(async () => ({ session: { kind: "child" } })),
  createCodemodeExtension: () => ({ name: "codemode" }),
  createMcpExtension: () => ({ name: "mcp" }),
  DefaultResourceLoader: class {
    options: RecordedLoaderOptions;
    constructor(options: RecordedLoaderOptions) {
      this.options = options;
      loaderOptions.push(options);
    }
    async reload(): Promise<void> {}
  },
  getAgentDir: () => "/agent",
  SessionManager: { inMemory: () => ({ kind: "in-memory" }) },
}));

const profile = (over: Partial<AgentProfile> = {}): AgentProfile => ({
  name: "reviewer",
  description: "",
  tools: ["read", "grep"],
  promptMode: "append",
  prompt: "review carefully",
  mcp: "inherit",
  source: "builtin",
  ...over,
});

const fakeModel = (id: string) => ({ id }) as unknown as Model<any>;

describe("splitModelRef", () => {
  it("splits provider and model id", () => {
    expect(splitModelRef("deepseek/deepseek-v4-flash")).toEqual({
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
    });
  });

  it("keeps the remainder when the model id contains slashes", () => {
    expect(splitModelRef("openrouter/z-ai/glm-5.3")).toEqual({
      provider: "openrouter",
      modelId: "z-ai/glm-5.3",
    });
  });

  it("rejects a ref without a usable provider", () => {
    expect(splitModelRef("bare-model")).toBeNull();
    expect(splitModelRef("/leading")).toBeNull();
    expect(splitModelRef("trailing/")).toBeNull();
  });
});

describe("resolveAgentModel", () => {
  const parent = fakeModel("parent");

  it("inherits the parent when the profile names no model", () => {
    expect(resolveAgentModel({ ref: undefined, parentModel: parent })).toEqual({
      model: parent,
    });
  });

  it("resolves through the registry", () => {
    const target = fakeModel("target");
    const result = resolveAgentModel({
      ref: "deepseek/deepseek-v4-flash",
      parentModel: parent,
      modelRegistry: {
        find: (provider, id) =>
          provider === "deepseek" && id === "deepseek-v4-flash"
            ? target
            : undefined,
      },
    });

    expect(result.model).toBe(target);
    expect(result.warning).toBeUndefined();
  });

  it("falls back with a warning when the registry has no such model", () => {
    const result = resolveAgentModel({
      ref: "nope/missing",
      parentModel: parent,
      modelRegistry: { find: () => undefined },
    });

    expect(result.model).toBe(parent);
    expect(result.warning).toContain("not found in the registry");
  });

  it("falls back with a warning when the ref has no provider segment", () => {
    const result = resolveAgentModel({
      ref: "bare-model",
      parentModel: parent,
    });

    expect(result.model).toBe(parent);
    expect(result.warning).toContain("is not provider/modelId");
  });
});

const childLoaderOptions = (
  over: Partial<Parameters<typeof childResourceLoaderOptions>[0]> = {},
) =>
  childResourceLoaderOptions({
    cwd: "/repo",
    agentDir: "/agent",
    profile: profile(),
    capabilities: { codemode: false, mcp: false },
    providerRegistrations: [],
    ...over,
  });

describe("childResourceLoaderOptions", () => {
  it("hard-disables extensions, MCP and codemode", () => {
    const options = childLoaderOptions();

    expect(options.noExtensions).toBe(true);
    expect(options.disabledBuiltinExtensions).toEqual(["mcp", "codemode"]);
  });

  it("adds no extra extension when both capabilities are off", () => {
    const options = childLoaderOptions();

    expect(options.extensionFactories).toEqual([]);
  });

  it("adds the codemode extension when the parent had it", () => {
    const options = childLoaderOptions({
      capabilities: { codemode: true, mcp: false },
    });

    expect(options.extensionFactories).toHaveLength(1);
  });

  it("adds both extensions when the parent had MCP", () => {
    const options = childLoaderOptions({
      capabilities: { codemode: true, mcp: true },
    });

    expect(options.extensionFactories).toHaveLength(2);
  });

  it("appends the profile prompt in append mode", () => {
    const options = childLoaderOptions({
      profile: profile({ promptMode: "append", prompt: "be terse" }),
    });

    expect(options.appendSystemPrompt).toEqual(["be terse"]);
    expect(options.systemPrompt).toBeUndefined();
  });

  it("replaces the system prompt in replace mode", () => {
    const options = childLoaderOptions({
      profile: profile({ promptMode: "replace", prompt: "you are a scout" }),
    });

    expect(options.systemPrompt).toBe("you are a scout");
    expect(options.appendSystemPrompt).toBeUndefined();
  });
});

describe("bootChildSession", () => {
  const gatewayConfig = {
    baseUrl: "http://127.0.0.1:8231",
    apiKey: "PROXY_MANAGED",
  } as ProviderConfig;
  const gatewayModel = {
    id: "llm-gateway--gpt-5.6-sol",
    provider: "cc-switch-gateway",
  } as unknown as Model<any>;

  const bootWithConfig = async (
    resolveProviderConfig?: (provider: string) => ProviderConfig | undefined,
  ) => {
    loaderOptions.length = 0;
    await bootChildSession({
      profile: profile(),
      cwd: "/repo",
      parentModel: gatewayModel,
      parentThinking: undefined,
      capabilities: { codemode: false, mcp: false },
      resolveProviderConfig,
    });
    return loaderOptions.at(-1);
  };

  const replayFactories = async (options: RecordedLoaderOptions) => {
    const registerProvider = vi.fn();
    for (const factory of options.extensionFactories ?? []) {
      await (factory as (pi: unknown) => void)({ registerProvider });
    }
    return registerProvider;
  };

  it("forwards the parent registration for the model the child inherits", async () => {
    const options = await bootWithConfig((provider) =>
      provider === "cc-switch-gateway" ? gatewayConfig : undefined,
    );
    const registerProvider = await replayFactories(options ?? {});

    expect(options?.noExtensions).toBe(true);
    expect(registerProvider).toHaveBeenCalledWith(
      "cc-switch-gateway",
      gatewayConfig,
    );
  });

  it("registers nothing when the provider came from models.json", async () => {
    const options = await bootWithConfig(() => undefined);

    expect(await replayFactories(options ?? {})).not.toHaveBeenCalled();
  });
});
