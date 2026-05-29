import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import extension from "./index.js";

describe("cs-search extension", () => {
  it("registers a session_start hook and exposes a cs_search tool focused on ranked structural search", async () => {
    const events: string[] = [];
    const tools: Array<Record<string, unknown>> = [];
    const whichCs = vi.fn().mockResolvedValue("/usr/local/bin/cs");

    const handlers = new Map<string, Function>();
    extension({
      on(event: string, handler: Function) {
        events.push(event);
        handlers.set(event, handler);
      },
      registerTool(definition: Record<string, unknown>) {
        tools.push(definition);
      },
    } as unknown as ExtensionAPI);

    expect(events).toEqual(["session_start"]);

    await handlers.get("session_start")?.(
      { reason: "startup" },
      {
        cwd: process.cwd(),
        signal: undefined,
        ui: { notify: vi.fn() },
        modelRegistry: {},
        shell: { which: whichCs },
      },
    );

    expect(whichCs).toHaveBeenCalledWith("cs");
    expect(tools).toHaveLength(1);

    const tool = tools[0];
    expect(tool.name).toBe("cs_search");
    expect(tool.description).toContain("ranked structural code search");
    expect(tool.promptGuidelines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Use cs_search when you need to find the most relevant implementation"),
        expect.stringContaining("Use rg instead when you need exact text or regex line matches"),
      ]),
    );
  });
});
