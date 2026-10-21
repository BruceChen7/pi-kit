/* biome-ignore-all lint/suspicious/noExplicitAny: pi session/loader 的测试替身必须是 any。 */
import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { AgentProfile } from "./agents.js";
import {
  childResourceLoaderOptions,
  resolveAgentModel,
  splitModelRef,
} from "./session.js";

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

describe("childResourceLoaderOptions", () => {
  it("hard-disables extensions, MCP and codemode", () => {
    const options = childResourceLoaderOptions({
      cwd: "/repo",
      agentDir: "/agent",
      profile: profile(),
      capabilities: { codemode: false, mcp: false },
    });

    expect(options.noExtensions).toBe(true);
    expect(options.disabledBuiltinExtensions).toEqual(["mcp", "codemode"]);
  });

  it("adds no extra extension when both capabilities are off", () => {
    const options = childResourceLoaderOptions({
      cwd: "/repo",
      agentDir: "/agent",
      profile: profile(),
      capabilities: { codemode: false, mcp: false },
    });

    expect(options.extensionFactories).toEqual([]);
  });

  it("adds the codemode extension when the parent had it", () => {
    const options = childResourceLoaderOptions({
      cwd: "/repo",
      agentDir: "/agent",
      profile: profile(),
      capabilities: { codemode: true, mcp: false },
    });

    expect(options.extensionFactories).toHaveLength(1);
  });

  it("adds both extensions when the parent had MCP", () => {
    const options = childResourceLoaderOptions({
      cwd: "/repo",
      agentDir: "/agent",
      profile: profile(),
      capabilities: { codemode: true, mcp: true },
    });

    expect(options.extensionFactories).toHaveLength(2);
  });

  it("appends the profile prompt in append mode", () => {
    const options = childResourceLoaderOptions({
      cwd: "/repo",
      agentDir: "/agent",
      profile: profile({ promptMode: "append", prompt: "be terse" }),
      capabilities: { codemode: false, mcp: false },
    });

    expect(options.appendSystemPrompt).toEqual(["be terse"]);
    expect(options.systemPrompt).toBeUndefined();
  });

  it("replaces the system prompt in replace mode", () => {
    const options = childResourceLoaderOptions({
      cwd: "/repo",
      agentDir: "/agent",
      profile: profile({ promptMode: "replace", prompt: "you are a scout" }),
      capabilities: { codemode: false, mcp: false },
    });

    expect(options.systemPrompt).toBe("you are a scout");
    expect(options.appendSystemPrompt).toBeUndefined();
  });
});
