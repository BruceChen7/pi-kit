import { describe, expect, it, vi } from "vitest";

import { createRequestStore } from "../runtime/request-store.ts";
import {
  deriveAllowRule,
  requestRemoteApproval,
  runApprovalRace,
} from "./approval.ts";

describe("remote-approval flow", () => {
  it("derives a bash allow rule from the exact command", () => {
    expect(deriveAllowRule("bash", { command: "npm test" }, 10)).toMatchObject({
      toolName: "bash",
      scope: "exact-command",
      value: "npm test",
      createdAt: 10,
    });
  });

  it("derives a path-prefix allow rule for write and edit", () => {
    expect(
      deriveAllowRule("write", { filePath: "src/generated/api.ts" }, 10),
    ).toMatchObject({
      toolName: "write",
      scope: "path-prefix",
      value: "src/generated/api.ts",
    });
    expect(
      deriveAllowRule("edit", { file_path: "src/generated/api.ts" }, 10),
    ).toMatchObject({
      toolName: "edit",
      scope: "path-prefix",
      value: "src/generated/api.ts",
    });
  });

  it("resolves local-first approval races once and records the source", async () => {
    const store = createRequestStore(() => 10);
    store.create({
      requestId: "apr_1",
      kind: "approval",
      sessionId: "session-1",
      sessionLabel: "repo · session-1",
      toolName: "bash",
      toolInputPreview: "npm test",
      contextPreview: [],
      fullContextAvailable: false,
    });

    let resolveLocal: ((value: "allow" | "always" | "deny") => void) | null =
      null;
    let resolveRemote: ((value: "allow" | "always" | "deny") => void) | null =
      null;

    const localApproval = new Promise<"allow" | "always" | "deny">(
      (resolve) => {
        resolveLocal = resolve;
      },
    );
    const remoteApproval = new Promise<"allow" | "always" | "deny">(
      (resolve) => {
        resolveRemote = resolve;
      },
    );

    const resultPromise = runApprovalRace({
      requestId: "apr_1",
      requestStore: store,
      localApproval,
      remoteApproval,
    });

    resolveLocal?.("allow");
    const result = await resultPromise;
    resolveRemote?.("deny");

    expect(result).toEqual({
      decision: "allow",
      resolvedBy: "local",
      status: "approved",
      allowRule: null,
    });
    expect(store.get("apr_1")?.status).toBe("approved");
    expect(store.get("apr_1")?.resolutionSource).toBe("local");
  });

  it("creates an allow rule when remote Always wins", async () => {
    const store = createRequestStore(() => 20);
    store.create({
      requestId: "apr_2",
      kind: "approval",
      sessionId: "session-1",
      sessionLabel: "repo · session-1",
      toolName: "deploy",
      toolInputPreview: "deploy prod",
      contextPreview: [],
      fullContextAvailable: false,
    });

    const result = await runApprovalRace({
      requestId: "apr_2",
      requestStore: store,
      localApproval: new Promise(() => {
        // pending forever
      }),
      remoteApproval: Promise.resolve("always"),
      toolName: "deploy",
      toolInput: { environment: "prod" },
      now: () => 99,
    });

    expect(result).toMatchObject({
      decision: "always",
      resolvedBy: "remote",
      status: "always",
      allowRule: {
        toolName: "deploy",
        scope: "tool-wide",
        value: "deploy",
        createdAt: 99,
      },
    });
    expect(store.get("apr_2")?.status).toBe("always");
    expect(store.get("apr_2")?.resolutionSource).toBe("remote");
  });

  it("requests remote approval from telegram and updates the message after a decision callback", async () => {
    const editMessage = vi.fn(async () => undefined);
    const channel = {
      sendMessage: async () => 42,
      editMessage,
      sendReply: async () => 100,
      poll: async (acceptedMessageIds: Iterable<number>) => {
        expect([...acceptedMessageIds]).toEqual([42]);
        return { type: "callback" as const, data: "always" };
      },
    };

    const result = await requestRemoteApproval({
      channel,
      text: "🔐 Approval request",
      includeAlways: true,
      sleep: async () => undefined,
    });

    expect(result).toEqual({
      decision: "always",
      messageId: 42,
    });
    expect(editMessage).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        text: expect.stringContaining("✅ Always approved"),
        buttons: [],
      }),
    );
  });

  it("expands full context in reply thread before waiting for the final approval callback", async () => {
    const sendReply = vi.fn(async () => 100);
    const editMessage = vi.fn(async () => undefined);
    const poll = vi
      .fn()
      .mockResolvedValueOnce({ type: "callback", data: "more" })
      .mockResolvedValueOnce({ type: "callback", data: "allow" });
    const channel = {
      sendMessage: async () => 42,
      editMessage,
      sendReply,
      poll,
    };

    const result = await requestRemoteApproval({
      channel,
      text: "🔐 Approval request",
      includeAlways: true,
      fullContextLines: ["assistant: detailed step 1", "user: detailed step 2"],
      sleep: async () => undefined,
    });

    expect(result).toEqual({
      decision: "allow",
      messageId: 42,
    });
    expect(sendReply).toHaveBeenCalledTimes(2);
    expect(sendReply).toHaveBeenNthCalledWith(
      1,
      42,
      "assistant: detailed step 1",
    );
    expect(sendReply).toHaveBeenNthCalledWith(2, 42, "user: detailed step 2");
    expect(editMessage).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        text: expect.stringContaining("✅ Approved"),
        buttons: [],
      }),
    );
  });
});
