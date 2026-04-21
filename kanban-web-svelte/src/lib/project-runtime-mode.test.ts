import { describe, expect, it } from "vitest";

import { getLocalProjectBoardRuntimeMode } from "./project-runtime-mode";

describe("local project board runtime mode", () => {
  it("disables runtime-backed terminal access in local board flow", () => {
    expect(getLocalProjectBoardRuntimeMode()).toEqual({
      actionsEnabled: false,
      terminalUnavailableMessage:
        "Terminal runtime is unavailable for local project boards in this flow.",
    });
  });
});
