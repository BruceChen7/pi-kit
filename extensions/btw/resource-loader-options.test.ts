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
    });

    expect(options.disabledBuiltinExtensions).toEqual(["mcp", "codemode"]);
    expect(options.noExtensions).toBe(true);
    expect(options.noPromptTemplates).toBe(true);
    expect(options.noThemes).toBe(true);
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
    });

    expect(options.appendSystemPrompt).toEqual([BTW_SYSTEM_PROMPT]);
    expect(options.systemPrompt).toBeUndefined();
  });
});

describe("createBtwResourceLoader", () => {
  beforeEach(() => {
    loaderInstances.length = 0;
  });

  it("wires the isolation flags into the loader it constructs", async () => {
    const ctx = {
      cwd: "/repo",
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
  });
});
