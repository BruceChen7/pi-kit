import { describe, expect, it } from "vitest";

import { createSessionState } from "./session-state.ts";

describe("remote-approval session state", () => {
  it("matches bash allow rules by exact command", () => {
    const state = createSessionState({
      sessionId: "session-1",
      sessionLabel: "repo · session-1",
    });

    state.addAllowRule({
      toolName: "bash",
      scope: "exact-command",
      value: "npm test",
      createdAt: 10,
    });

    expect(
      state.findMatchingAllowRule("bash", { command: "npm test" }),
    ).toMatchObject({
      toolName: "bash",
      scope: "exact-command",
      value: "npm test",
    });
    expect(
      state.findMatchingAllowRule("bash", { command: "npm run lint" }),
    ).toBeNull();
  });

  it("matches write and edit allow rules by path prefix", () => {
    const state = createSessionState({
      sessionId: "session-1",
      sessionLabel: "repo · session-1",
    });

    state.addAllowRule({
      toolName: "write",
      scope: "path-prefix",
      value: "src/generated",
      createdAt: 20,
    });

    expect(
      state.findMatchingAllowRule("write", {
        filePath: "src/generated/types.ts",
      }),
    ).toMatchObject({ value: "src/generated" });
    expect(
      state.findMatchingAllowRule("write", { filePath: "src/other/types.ts" }),
    ).toBeNull();
  });

  it("matches custom tools by tool-wide scope", () => {
    const state = createSessionState({
      sessionId: "session-1",
      sessionLabel: "repo · session-1",
    });

    state.addAllowRule({
      toolName: "deploy",
      scope: "tool-wide",
      value: "deploy",
      createdAt: 30,
    });

    expect(
      state.findMatchingAllowRule("deploy", { environment: "prod" }),
    ).toMatchObject({
      toolName: "deploy",
      scope: "tool-wide",
    });
    expect(
      state.findMatchingAllowRule("read", { path: "README.md" }),
    ).toBeNull();
  });
});
