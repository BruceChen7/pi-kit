import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";

import extension from "./index.js";

describe("feature-workflow extension", () => {
  it("registers expected commands", () => {
    const commands: string[] = [];

    extension({
      registerCommand(name: string) {
        commands.push(name);
      },
      exec() {
        throw new Error("exec should not run during registration");
      },
      on() {
        // no-op
      },
    } as unknown as ExtensionAPI);

    expect(commands.sort()).toEqual([
      "feature-list",
      "feature-setup",
      "feature-start",
      "feature-switch",
      "feature-validate",
    ]);
  });
});
