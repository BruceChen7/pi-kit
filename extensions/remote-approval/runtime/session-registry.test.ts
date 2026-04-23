import { describe, expect, it } from "vitest";

import { createSessionRegistry } from "./session-registry.ts";

describe("remote-approval session registry", () => {
  it("creates and reuses session state by session id", () => {
    const registry = createSessionRegistry();

    const first = registry.ensureSession("session-1", "repo · session-1");
    const second = registry.ensureSession("session-1", "repo · ignored");

    expect(first).toBe(second);
    expect(second.sessionLabel).toBe("repo · session-1");
  });

  it("restores persisted allow rules into the session state", () => {
    const registry = createSessionRegistry();

    const state = registry.restoreSession("session-1", "repo · session-1", [
      {
        type: "custom",
        customType: "remote-approval-allow-rule",
        data: {
          toolName: "bash",
          scope: "exact-command",
          value: "npm test",
          createdAt: 1,
        },
      },
    ]);

    expect(state.getAllowRules()).toEqual([
      {
        toolName: "bash",
        scope: "exact-command",
        value: "npm test",
        createdAt: 1,
      },
    ]);
  });

  it("drops session state on shutdown", () => {
    const registry = createSessionRegistry();
    registry.ensureSession("session-1", "repo · session-1");

    registry.removeSession("session-1");

    expect(registry.getSession("session-1")).toBeNull();
  });
});
