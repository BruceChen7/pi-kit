import { describe, expect, it, vi } from "vitest";

import { requestLocalApproval } from "./local-approval.ts";

describe("remote-approval local approval", () => {
  it("prefers a custom overlay when ui.custom is available", async () => {
    const custom = vi.fn(async (_builder, options) => {
      expect(options).toEqual({ overlay: true });
      return "always";
    });
    const select = vi.fn();

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

    expect(decision).toBe("always");
    expect(select).not.toHaveBeenCalled();
  });

  it("confirms the default overlay selection when Enter is pressed", async () => {
    const custom = vi.fn(async (builder) => {
      let resolved: ((value: "allow" | "always" | "deny") => void) | null =
        null;
      const resultPromise = new Promise<"allow" | "always" | "deny">(
        (resolve) => {
          resolved = resolve;
        },
      );

      const component = builder(
        { requestRender: vi.fn() },
        {
          fg: (_color: string, text: string) => text,
          bg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
        {},
        (value: "allow" | "always" | "deny") => resolved?.(value),
      );
      component.handleInput("\r");
      return resultPromise;
    });

    const decision = await requestLocalApproval(
      {
        hasUI: true,
        ui: {
          custom,
        },
      },
      {
        toolName: "bash",
        title: "Approve bash: npm test",
        preview: "npm test",
        contextPreview: ["assistant: Finished."],
      },
    );

    expect(decision).toBe("allow");
  });

  it("falls back to ui.select when custom overlay is unavailable", async () => {
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
