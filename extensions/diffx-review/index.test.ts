import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";

import extension from "./index.ts";

describe("diffx-review extension", () => {
  it("registers expected commands and tools", () => {
    const commands: string[] = [];
    const tools: string[] = [];

    extension({
      registerCommand(name: string) {
        commands.push(name);
      },
      registerTool(definition: { name: string }) {
        tools.push(definition.name);
      },
    } as unknown as ExtensionAPI);

    expect(commands.sort()).toEqual([
      "diffx-finish-review",
      "diffx-review-status",
      "diffx-start-review",
      "diffx-stop-review",
    ]);
    expect(tools.sort()).toEqual([
      "diffx_list_comments",
      "diffx_reply_comment",
      "diffx_resolve_comment",
      "diffx_review_status",
    ]);
  });
});
