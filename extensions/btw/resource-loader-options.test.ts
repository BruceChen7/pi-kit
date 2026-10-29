import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 边界测试：btw 子会话的资源加载器。Core（options 组装）与 Shell（构造 loader）
 * 分开验证 —— Core 是 value in / value out，Shell 只断言接线结果。
 */

const loaderInstances = vi.hoisted(
  () => [] as Array<{ options: Record<string, unknown> }>,
);

vi.mock("@earendil-works/pi-coding-agent", () => ({
  DefaultResourceLoader: class {
    reload = vi.fn(async () => {});
    constructor(options: Record<string, unknown>) {
      loaderInstances.push({ options });
    }
  },
  getAgentDir: () => "/tmp/agent-dir",
}));

import {
  BTW_SYSTEM_PROMPT,
  btwResourceLoaderOptions,
  createBtwResourceLoader,
} from "./session.js";

describe("btwResourceLoaderOptions", () => {
  it("keeps MCP and codemode out of the read-only side session", () => {
    const options = btwResourceLoaderOptions({
      cwd: "/repo",
      agentDir: "/tmp/agent-dir",
      customPrompt: "custom prompt",
      appendSystemPrompt: "appended prompt",
      providerRegistrations: [],
    });

    expect(options.disabledBuiltinExtensions).toEqual(["mcp", "codemode"]);
    expect(options.noExtensions).toBe(true);
    expect(options.noPromptTemplates).toBe(true);
    expect(options.noThemes).toBe(true);
    expect(options.extensionFactories).toEqual([]);
    expect(options.cwd).toBe("/repo");
    expect(options.agentDir).toBe("/tmp/agent-dir");
    expect(options.systemPrompt).toBe("custom prompt");
    expect(options.appendSystemPrompt).toEqual([
      "appended prompt",
      BTW_SYSTEM_PROMPT,
    ]);
  });

  it("omits a missing append prompt but keeps the btw role prompt", () => {
    const options = btwResourceLoaderOptions({
      cwd: "/repo",
      agentDir: "/tmp/agent-dir",
      providerRegistrations: [],
    });

    expect(options.appendSystemPrompt).toEqual([BTW_SYSTEM_PROMPT]);
    expect(options.systemPrompt).toBeUndefined();
  });

  it("forwards a parent-registered provider the side session inherits", () => {
    const config = { apiKey: "PROXY_MANAGED" };
    const options = btwResourceLoaderOptions({
      cwd: "/repo",
      agentDir: "/tmp/agent-dir",
      providerRegistrations: [{ name: "cc-switch-gateway", config }],
    });
    const registerProvider = vi.fn();
    for (const factory of options.extensionFactories ?? []) {
      (factory as (pi: unknown) => void)({ registerProvider });
    }

    expect(registerProvider).toHaveBeenCalledWith("cc-switch-gateway", config);
  });
});

describe("createBtwResourceLoader", () => {
  beforeEach(() => {
    loaderInstances.length = 0;
  });

  it("wires the isolation flags into the loader it constructs", async () => {
    const ctx = {
      cwd: "/repo",
      model: { provider: "cc-switch-gateway" },
      modelRegistry: {
        getRegisteredProviderConfig: (provider: string) =>
          provider === "cc-switch-gateway"
            ? { apiKey: "PROXY_MANAGED" }
            : undefined,
      },
      getSystemPromptOptions: () => ({
        cwd: "/repo",
        customPrompt: "custom prompt",
        appendSystemPrompt: "appended prompt",
      }),
    } as never;

    await createBtwResourceLoader(ctx);

    expect(loaderInstances).toHaveLength(1);
    expect(loaderInstances[0]?.options).toMatchObject({
      cwd: "/repo",
      agentDir: "/tmp/agent-dir",
      disabledBuiltinExtensions: ["mcp", "codemode"],
      noExtensions: true,
      systemPrompt: "custom prompt",
    });
    const registerProvider = vi.fn();
    for (const factory of (loaderInstances[0]?.options.extensionFactories ??
      []) as Array<(pi: unknown) => void>) {
      factory({ registerProvider });
    }
    expect(registerProvider).toHaveBeenCalledWith("cc-switch-gateway", {
      apiKey: "PROXY_MANAGED",
    });
  });
});
