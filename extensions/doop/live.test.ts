import { describe, expect, it } from "vitest";
import { getComments } from "./client.js";
import type { DoopConfig } from "./config.js";
import { defaultConfigPath, readConfig } from "./index.js";
import { toWorklist } from "./worklist.js";

/**
 * Opt-in proof against a running doop:
 * `DOOP_AGENT_KEY=dpk_… DOOP_CANVAS_ID=<canvas> npx vitest run extensions/doop/live.test.ts`.
 * Both tests skip without a key or a canvas, so CI stays hermetic.
 */
const envKey = process.env.DOOP_AGENT_KEY?.trim();
const loaded = readConfig(defaultConfigPath());
const base: DoopConfig = loaded.ok
  ? loaded.config
  : {
      baseUrl: "http://localhost:4300",
      agentKey: "",
      agentName: "pi",
      watch: false,
      cards: false,
    };
const canvasId = process.env.DOOP_CANVAS_ID?.trim() || base.canvasId || "";
const config = {
  ...base,
  agentKey: envKey ?? base.agentKey,
  baseUrl: process.env.DOOP_BASE_URL?.trim() || base.baseUrl,
};

describe("live doop instance", () => {
  it.skipIf(!envKey || !canvasId)(
    "reads a real canvas and every worklist item carries an anchor",
    async () => {
      const result = await getComments(config, canvasId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const list = toWorklist({
        canvasId,
        comments: result.value,
        agentName: config.agentName,
      });
      expect(Array.isArray(list.items)).toBe(true);
      for (const item of list.items) {
        expect(typeof item.id).toBe("string");
        expect(["element", "frame", "canvas"]).toContain(item.anchor.kind);
      }
    },
  );

  it.skipIf(!envKey)(
    "maps a canvas the agent cannot see to a canvas error, not a protocol one",
    async () => {
      const result = await getComments(config, "not-a-canvas");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("canvas");
    },
  );
});
