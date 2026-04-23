import { describe, expect, it } from "vitest";

import {
  getStaticTodoCommandCompletionItems,
  parseTodoCommand,
} from "./router.js";

describe("todo router", () => {
  it("parses add --start into a single lifecycle action", () => {
    expect(parseTodoCommand("add --start Fix status banner")).toEqual({
      kind: "add",
      description: "Fix status banner",
      startNow: true,
    });
  });

  it("parses cleanup --all without leaking finish/cleanup implementation details", () => {
    expect(parseTodoCommand("cleanup --all")).toEqual({
      kind: "cleanup-all",
    });
  });

  it("exposes the unified top-level completion surface", () => {
    expect(
      getStaticTodoCommandCompletionItems().map((item) => item.value),
    ).toEqual([
      "add",
      "start",
      "resume",
      "finish",
      "cleanup",
      "remove",
      "list",
      "show",
    ]);
  });
});
