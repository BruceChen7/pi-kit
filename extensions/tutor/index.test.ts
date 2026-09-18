/**
 * 接线测试：用一个假的 ExtensionAPI 断言 tutor 注册了哪些工具/命令/事件。
 * 这是"开关演练"的自动化替身——真正的 /toggle-plugin 演练仍在 pi 会话里做。
 */

import { describe, expect, it, vi } from "vitest";
import tutorExtension from "./index.ts";

type Registered = {
  tools: string[];
  commands: string[];
  events: string[];
};

const fakePi = (): { api: never; seen: Registered } => {
  const seen: Registered = { tools: [], commands: [], events: [] };
  const api = {
    registerTool: vi.fn((tool: { name: string }) => seen.tools.push(tool.name)),
    registerCommand: vi.fn((name: string) => seen.commands.push(name)),
    on: vi.fn((event: string) => seen.events.push(event)),
    appendEntry: vi.fn(),
  };
  return { api: api as never, seen };
};

describe("tutor extension wiring", () => {
  it("registers the teaching tools, note commands and mirror events", () => {
    const { api, seen } = fakePi();
    tutorExtension(api);

    expect(seen.tools).toEqual([
      "quiz",
      "ask_user_question",
      "bind_notes",
      "split_topic",
      "validate_mermaid",
      "render_mermaid",
    ]);
    expect(seen.commands).toEqual(["md-topic", "md-log", "md-unlog"]);
    expect(seen.events).toEqual(
      expect.arrayContaining([
        "session_start",
        "message_end",
        "tool_execution_update",
        "tool_call",
        "tool_result",
      ]),
    );
  });
});
