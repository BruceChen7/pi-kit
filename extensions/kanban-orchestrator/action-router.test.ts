import { describe, expect, it } from "vitest";

import {
  isKanbanActionName,
  type KanbanActionName,
  parseKanbanActionName,
} from "./types.js";

describe("kanban action router", () => {
  it("accepts only whitelisted actions", () => {
    const allowed: KanbanActionName[] = [
      "reconcile",
      "apply",
      "open-session",
      "custom-prompt",
      "validate",
      "prune-merged",
    ];

    for (const action of allowed) {
      expect(isKanbanActionName(action)).toBe(true);
      expect(parseKanbanActionName(action)).toBe(action);
    }
  });

  it("rejects non-whitelisted actions", () => {
    expect(isKanbanActionName("rm -rf" as KanbanActionName)).toBe(false);
    expect(parseKanbanActionName("feature-start")).toBeNull();
    expect(parseKanbanActionName("")).toBeNull();
  });
});
