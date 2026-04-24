import { describe, expect, it, vi } from "vitest";

import { requestLocalApproval } from "./local-approval.ts";

describe("remote-approval local approval", () => {
  it("prefers the native pi-agent select UI when ui.custom is also available", async () => {
    const custom = vi.fn(async () => "always");
    const select = vi.fn(async () => "Deny");

    const decision = await requestLocalApproval(
      {
        hasUI: true,
        ui: {
          custom,
          select,
        },
      },
      {
        toolName: "bash",
        title: "Approve bash: npm test",
        preview: "npm test",
        contextPreview: ["assistant: Finished."],
      },
    );

    expect(decision).toBe("deny");
    expect(select).toHaveBeenCalledWith("Approve bash: npm test", [
      "Allow",
      "Always",
      "Deny",
    ]);
    expect(custom).not.toHaveBeenCalled();
  });

  it("uses ui.select for local approval", async () => {
    const select = vi.fn(async () => "Deny");

    const decision = await requestLocalApproval(
      {
        hasUI: true,
        ui: {
          select,
        },
      },
      {
        toolName: "bash",
        title: "Approve bash: npm test",
        preview: "npm test",
        contextPreview: [],
      },
    );

    expect(decision).toBe("deny");
    expect(select).toHaveBeenCalledWith("Approve bash: npm test", [
      "Allow",
      "Always",
      "Deny",
    ]);
  });
});
