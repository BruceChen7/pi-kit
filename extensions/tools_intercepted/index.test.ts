import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import extension from "./index.js";

const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
});

describe("tools_intercepted extension", () => {
  it("registers supported session lifecycle hooks", () => {
    const events: string[] = [];

    extension({
      on(event: string) {
        events.push(event);
      },
      registerTool() {
        // no-op
      },
    } as unknown as ExtensionAPI);

    expect(events).toEqual(["session_start"]);
  });
});
