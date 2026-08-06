import { describe, expect, it } from "vitest";
import { resolveConfiguredModel } from "./config.ts";

describe("resolveConfiguredModel (forkPanel)", () => {
  it("项目可信且有配置时返回项目模型", () => {
    const result = resolveConfiguredModel(
      {},
      { forkPanel: { defaultModel: "project-model" } },
      true,
    );
    expect(result.model).toBe("project-model");
    expect(result.source).toBe("project");
  });

  it("项目显式设 null 时回退 pi-default", () => {
    const result = resolveConfiguredModel(
      { forkPanel: { defaultModel: "global-model" } },
      { forkPanel: { defaultModel: null } },
      true,
    );
    expect(result.model).toBeUndefined();
    expect(result.source).toBe("pi-default");
  });

  it("项目不可信时忽略项目配置", () => {
    const result = resolveConfiguredModel(
      { forkPanel: { defaultModel: "global-model" } },
      { forkPanel: { defaultModel: "project-model" } },
      false,
    );
    expect(result.model).toBe("global-model");
    expect(result.source).toBe("global");
  });

  it("无项目配置时返回全局模型", () => {
    const result = resolveConfiguredModel(
      { forkPanel: { defaultModel: "global-model" } },
      {},
      true,
    );
    expect(result.model).toBe("global-model");
    expect(result.source).toBe("global");
  });

  it("无任何配置时返回 pi-default", () => {
    const result = resolveConfiguredModel({}, {}, true);
    expect(result.model).toBeUndefined();
    expect(result.source).toBe("pi-default");
  });

  it("忽略空字符串模型", () => {
    const result = resolveConfiguredModel(
      { forkPanel: { defaultModel: "   " } },
      {},
      true,
    );
    expect(result.model).toBeUndefined();
    expect(result.source).toBe("pi-default");
  });

  it("不读取 herdrSquad 配置（独立键）", () => {
    const result = resolveConfiguredModel(
      { herdrSquad: { defaultModel: "squad-model" } },
      {},
      true,
    );
    expect(result.model).toBeUndefined();
    expect(result.source).toBe("pi-default");
  });
});
