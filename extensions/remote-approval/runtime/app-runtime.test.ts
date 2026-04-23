import { describe, expect, it } from "vitest";

import type { RemoteApprovalConfig } from "../config.ts";
import { createAppRuntime } from "./app-runtime.ts";

const config: RemoteApprovalConfig = {
  enabled: true,
  channelType: "telegram",
  botToken: "token",
  chatId: "chat",
  strictRemote: false,
  interceptTools: ["bash", "write", "edit"],
  extraInterceptTools: [],
  idleEnabled: true,
  continueEnabled: true,
  contextTurns: 3,
  contextMaxChars: 200,
  approvalTimeoutMs: 0,
  requestTtlSeconds: 600,
};

describe("remote-approval app runtime", () => {
  it("restores session state and config on session start", () => {
    const runtime = createAppRuntime();

    const session = runtime.startSession({
      cwd: "/tmp/pi-kit",
      sessionFile: "/tmp/pi-kit/.pi/sessions/abc123.jsonl",
      config,
      entries: [
        {
          type: "custom",
          customType: "remote-approval-allow-rule",
          data: {
            toolName: "bash",
            scope: "exact-command",
            value: "npm test",
            createdAt: 1,
          },
        },
      ],
    });

    expect(session.identity).toEqual({
      sessionId: "abc123",
      sessionLabel: "pi-kit · abc123",
    });
    expect(session.sessionState.getAllowRules()).toHaveLength(1);
    expect(runtime.getSession("abc123")?.config).toEqual(config);
  });

  it("removes runtime state on session shutdown", () => {
    const runtime = createAppRuntime();
    const session = runtime.startSession({
      cwd: "/tmp/pi-kit",
      sessionFile: "/tmp/pi-kit/.pi/sessions/abc123.jsonl",
      config,
      entries: [],
    });

    runtime.shutdownSession(session.identity.sessionId);

    expect(runtime.getSession(session.identity.sessionId)).toBeNull();
  });
});
