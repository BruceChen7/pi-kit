import { describe, expect, it, vi } from "vitest";

import {
  collectStoredAllowRules,
  persistAllowRule,
  REMOTE_APPROVAL_ALLOW_RULE_TYPE,
} from "./persistence.ts";

describe("remote-approval persistence", () => {
  it("collects stored allow rules from custom session entries", () => {
    const rules = collectStoredAllowRules([
      {
        type: "custom",
        customType: REMOTE_APPROVAL_ALLOW_RULE_TYPE,
        data: {
          toolName: "bash",
          scope: "exact-command",
          value: "npm test",
          createdAt: 1,
        },
      },
      {
        type: "custom",
        customType: "other",
        data: { ignored: true },
      },
    ]);

    expect(rules).toEqual([
      {
        toolName: "bash",
        scope: "exact-command",
        value: "npm test",
        createdAt: 1,
      },
    ]);
  });

  it("persists allow rules through pi.appendEntry", () => {
    const appendEntry = vi.fn();

    persistAllowRule(
      {
        appendEntry,
      },
      {
        toolName: "write",
        scope: "path-prefix",
        value: "src/generated",
        createdAt: 2,
      },
    );

    expect(appendEntry).toHaveBeenCalledWith(REMOTE_APPROVAL_ALLOW_RULE_TYPE, {
      toolName: "write",
      scope: "path-prefix",
      value: "src/generated",
      createdAt: 2,
    });
  });
});
