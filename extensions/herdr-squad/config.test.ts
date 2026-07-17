import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfiguredModel } from "./config.ts";

const mockLoadSettings = vi.hoisted(() => vi.fn());

vi.mock("../shared/settings.ts", () => ({
  loadSettings: mockLoadSettings,
}));

describe("resolveConfiguredModel", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns project model when project is trusted and has config", () => {
    mockLoadSettings.mockReturnValue({
      global: {},
      project: { herdrSquad: { defaultModel: "project-model" } },
    });
    const result = resolveConfiguredModel("/some/cwd", true);
    expect(result.model).toBe("project-model");
    expect(result.source).toBe("project");
  });

  it("returns pi-default when project explicitly sets null", () => {
    mockLoadSettings.mockReturnValue({
      global: { herdrSquad: { defaultModel: "global-model" } },
      project: { herdrSquad: { defaultModel: null } },
    });
    const result = resolveConfiguredModel("/some/cwd", true);
    expect(result.model).toBeUndefined();
    expect(result.source).toBe("pi-default");
  });

  it("ignores project config when project is not trusted", () => {
    mockLoadSettings.mockReturnValue({
      global: { herdrSquad: { defaultModel: "global-model" } },
      project: { herdrSquad: { defaultModel: "project-model" } },
    });
    const result = resolveConfiguredModel("/some/cwd", false);
    expect(result.model).toBe("global-model");
    expect(result.source).toBe("global");
  });

  it("returns global model when no project config", () => {
    mockLoadSettings.mockReturnValue({
      global: { herdrSquad: { defaultModel: "global-model" } },
      project: {},
    });
    const result = resolveConfiguredModel("/some/cwd", true);
    expect(result.model).toBe("global-model");
    expect(result.source).toBe("global");
  });

  it("returns pi-default when no config exists", () => {
    mockLoadSettings.mockReturnValue({
      global: {},
      project: {},
    });
    const result = resolveConfiguredModel("/some/cwd", true);
    expect(result.model).toBeUndefined();
    expect(result.source).toBe("pi-default");
  });

  it("ignores empty string model", () => {
    mockLoadSettings.mockReturnValue({
      global: { herdrSquad: { defaultModel: "   " } },
      project: {},
    });
    const result = resolveConfiguredModel("/some/cwd", true);
    expect(result.model).toBeUndefined();
    expect(result.source).toBe("pi-default");
  });
});
