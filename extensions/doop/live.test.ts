import { describe, expect, it } from "vitest";
import { getComments } from "./client.js";
import { defaultConfigPath, readConfig } from "./index.js";

/**
 * Opt-in proof against a running doop: `DOOP_AGENT_KEY=dpk_… npx vitest run
 * extensions/doop/live.test.ts`. Skipped without a key so CI stays hermetic.
 */
const envKey = process.env.DOOP_AGENT_KEY?.trim();
const suite = envKey ? describe : describe.skip;

function liveConfig() {
  const loaded = readConfig(defaultConfigPath());
  const base = loaded.ok
    ? loaded.config
    : {
        baseUrl: "http://localhost:4300",
        agentName: "pi",
        canvasId: undefined,
        agentKey: "",
      };
  const canvasId = process.env.DOOP_CANVAS_ID?.trim() || base.canvasId || "";
  return {
    config: {
      ...base,
      agentKey: envKey ?? base.agentKey,
      baseUrl: process.env.DOOP_BASE_URL?.trim() || base.baseUrl,
    },
    canvasId,
  };
}

suite("live doop instance", () => {
  it("reads the bound canvas's open comments over the real MCP endpoint", async () => {
    const { config, canvasId } = liveConfig();
    expect(
      envKey,
      "DOOP_AGENT_KEY is required for the live suite",
    ).toBeTruthy();
    if (!canvasId) {
      // No binding yet: a bogus id still proves auth, wire format and error mapping.
      const result = await getComments(config, "not-a-canvas");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("canvas");
      return;
    }
    const result = await getComments(config, canvasId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.isArray(result.value)).toBe(true);
    for (const comment of result.value) {
      expect(typeof comment.id).toBe("string");
      expect(typeof comment.at).toBe("number");
    }
  });
});
