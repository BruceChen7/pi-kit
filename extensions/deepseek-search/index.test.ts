import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/settings.ts", () => ({
  getGlobalSettingsPath: vi.fn(
    () => "/test/.pi/agent/third_extension_settings.json",
  ),
  loadGlobalSettings: vi.fn(() => ({
    globalPath: "/test/.pi/agent/third_extension_settings.json",
    global: {},
  })),
  writeSettingsFile: vi.fn(),
}));

import { loadGlobalSettings, writeSettingsFile } from "../shared/settings.ts";
import {
  formatDeepSeekSearchStatus,
  loadDeepSeekSearchSettings,
  saveDeepSeekSearchSettings,
} from "./index.ts";

const mockLoadGlobalSettings = vi.mocked(loadGlobalSettings);
const mockWriteSettingsFile = vi.mocked(writeSettingsFile);

const MODEL = "deepseek-v4-flash";

// ---------------------------------------------------------------------------
// Pure function — no mocking needed
// ---------------------------------------------------------------------------
describe("formatDeepSeekSearchStatus", () => {
  it("shows enabled with model when active (regardless of saved state)", () => {
    const r1 = formatDeepSeekSearchStatus(true, true, MODEL);
    expect(r1.message).toBe(`DeepSeek search: enabled | Model: ${MODEL}`);
    expect(r1.severity).toBe("info");

    const r2 = formatDeepSeekSearchStatus(true, false, MODEL);
    expect(r2.message).toBe(`DeepSeek search: enabled | Model: ${MODEL}`);
    expect(r2.severity).toBe("info");
  });

  it("shows disabled when inactive and not saved", () => {
    const { message, severity } = formatDeepSeekSearchStatus(
      false,
      false,
      MODEL,
    );
    expect(message).toBe("DeepSeek search: disabled");
    expect(severity).toBe("warning");
  });

  it("shows disabled with saved-hint when inactive but saved-on", () => {
    const { message, severity } = formatDeepSeekSearchStatus(
      false,
      true,
      MODEL,
    );
    expect(message).toMatch(/disabled/);
    expect(message).toMatch(/saved: enabled/);
    expect(message).toMatch(/run `on` to activate/);
    expect(severity).toBe("warning");
  });
});

// ---------------------------------------------------------------------------
// Settings IO wrappers
// ---------------------------------------------------------------------------
describe("loadDeepSeekSearchSettings", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns enabled=true when stored as true", () => {
    mockLoadGlobalSettings.mockReturnValue({
      globalPath: "/test/.pi/agent/third_extension_settings.json",
      global: { deepseekSearch: { enabled: true } },
    });
    expect(loadDeepSeekSearchSettings()).toEqual({ enabled: true });
  });

  it("returns enabled=false when stored as false", () => {
    mockLoadGlobalSettings.mockReturnValue({
      globalPath: "/test/.pi/agent/third_extension_settings.json",
      global: { deepseekSearch: { enabled: false } },
    });
    expect(loadDeepSeekSearchSettings()).toEqual({ enabled: false });
  });

  it("returns enabled=false when key is absent", () => {
    mockLoadGlobalSettings.mockReturnValue({
      globalPath: "/test/.pi/agent/third_extension_settings.json",
      global: {},
    });
    expect(loadDeepSeekSearchSettings()).toEqual({ enabled: false });
  });

  it("returns enabled=false for malformed value (non-object)", () => {
    mockLoadGlobalSettings.mockReturnValue({
      globalPath: "/test/.pi/agent/third_extension_settings.json",
      global: { deepseekSearch: "not-an-object" },
    });
    expect(loadDeepSeekSearchSettings()).toEqual({ enabled: false });
  });
});

describe("saveDeepSeekSearchSettings", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("writes enabled=true under the correct key", () => {
    mockLoadGlobalSettings.mockReturnValue({
      globalPath: "/test/.pi/agent/third_extension_settings.json",
      global: {},
    });

    saveDeepSeekSearchSettings({ enabled: true });

    expect(mockWriteSettingsFile).toHaveBeenCalledWith(
      "/test/.pi/agent/third_extension_settings.json",
      { deepseekSearch: { enabled: true } },
    );
  });

  it("preserves other keys in the global settings", () => {
    mockLoadGlobalSettings.mockReturnValue({
      globalPath: "/test/.pi/agent/third_extension_settings.json",
      global: { otherExt: { foo: 1 } },
    });

    saveDeepSeekSearchSettings({ enabled: false });

    expect(mockWriteSettingsFile).toHaveBeenCalledWith(
      "/test/.pi/agent/third_extension_settings.json",
      { otherExt: { foo: 1 }, deepseekSearch: { enabled: false } },
    );
  });
});
