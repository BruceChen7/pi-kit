import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { SAFE_DELETE_APPROVAL_CHANNEL } from "../shared/internal-events.ts";

const loadAutoAllow = async () => (await import("./index.ts")).default;

type ApprovalHandler = (data: unknown) => void;

const setup = () => {
  const approvalHandlers: ApprovalHandler[] = [];
  const pi = {
    on: vi.fn(),
    events: {
      emit: vi.fn(),
      on(channel: string, handler: ApprovalHandler) {
        if (channel === SAFE_DELETE_APPROVAL_CHANNEL) {
          approvalHandlers.push(handler);
        }
      },
    },
  } as unknown as ExtensionAPI;
  return { pi, approvalHandlers };
};

const emitApproval = (
  approvalHandlers: ApprovalHandler[],
  command: string,
): Array<Promise<boolean>> => {
  const decisions: Array<Promise<boolean>> = [];
  const event = {
    type: "safe-delete.approval",
    requestId: "safe_delete_test",
    createdAt: Date.now(),
    command,
    title: "MCP tool call needs confirmation",
    body: "Allow this MCP tool call to run?",
    contextPreview: [],
    fullContextLines: [],
    attachRemoteDecision: (decision: Promise<boolean>) => {
      decisions.push(decision);
    },
    ctx: {},
  };
  for (const handler of approvalHandlers) handler(event);
  return decisions;
};

describe("auto-allow-mcp remote approvals", () => {
  it("auto-approves matching MCP tool calls", async () => {
    const { pi, approvalHandlers } = setup();
    const autoAllow = await loadAutoAllow();
    autoAllow(pi);

    const decisions = emitApproval(
      approvalHandlers,
      "mcp__toolverse_1787657608__search_log_live",
    );

    expect(decisions).toHaveLength(1);
    await expect(decisions[0]).resolves.toBe(true);
  });

  it("does not auto-approve MCP tools outside the patterns", async () => {
    const { pi, approvalHandlers } = setup();
    const autoAllow = await loadAutoAllow();
    autoAllow(pi);

    const decisions = emitApproval(
      approvalHandlers,
      "mcp__other_server__some_tool",
    );

    expect(decisions).toHaveLength(0);
  });

  it("does not auto-approve destructive bash commands", async () => {
    const { pi, approvalHandlers } = setup();
    const autoAllow = await loadAutoAllow();
    autoAllow(pi);

    const decisions = emitApproval(approvalHandlers, "rm -rf /");

    expect(decisions).toHaveLength(0);
  });
});
