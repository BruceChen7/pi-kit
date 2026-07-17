import { describe, expect, it } from "vitest";
import { resolveConfiguredModel } from "./config.ts";

describe("resolveConfiguredModel", () => {
  it("returns project model when project is trusted and has config", () => {
    const result = resolveConfiguredModel(
      {},
      { herdrSquad: { defaultModel: "project-model" } },
      true,
    );
    expect(result.model).toBe("project-model");
    expect(result.source).toBe("project");
  });

  it("returns pi-default when project explicitly sets null", () => {
    const result = resolveConfiguredModel(
      { herdrSquad: { defaultModel: "global-model" } },
      { herdrSquad: { defaultModel: null } },
      true,
    );
    expect(result.model).toBeUndefined();
    expect(result.source).toBe("pi-default");
  });

  it("ignores project config when project is not trusted", () => {
    const result = resolveConfiguredModel(
      { herdrSquad: { defaultModel: "global-model" } },
      { herdrSquad: { defaultModel: "project-model" } },
      false,
    );
    expect(result.model).toBe("global-model");
    expect(result.source).toBe("global");
  });

  it("returns global model when no project config", () => {
    const result = resolveConfiguredModel(
      { herdrSquad: { defaultModel: "global-model" } },
      {},
      true,
    );
    expect(result.model).toBe("global-model");
    expect(result.source).toBe("global");
  });

  it("returns pi-default when no config exists", () => {
    const result = resolveConfiguredModel({}, {}, true);
    expect(result.model).toBeUndefined();
    expect(result.source).toBe("pi-default");
  });

  it("ignores empty string model", () => {
    const result = resolveConfiguredModel(
      { herdrSquad: { defaultModel: "   " } },
      {},
      true,
    );
    expect(result.model).toBeUndefined();
    expect(result.source).toBe("pi-default");
  });
});
