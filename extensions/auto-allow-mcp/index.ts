/**
 * Auto-allow MCP tool calls
 *
 * Automatically allows toolverse MCP tool calls without requiring user
 * confirmation. Useful when you trust the MCP server and want to avoid
 * frequent permission prompts.
 *
 * MCP confirmation prompts come from the safe-delete extension's MCP gate,
 * not from pi itself. Pi's `tool_call` event can only block a call or mutate
 * its input — returning "no opinion" cannot suppress another extension's
 * prompt. The supported seam is safe-delete's approval channel: it emits one
 * approval event per gated call, and any extension may attach a remote
 * decision that races the local Y/N dialog. This extension auto-approves
 * matching calls there.
 *
 * To add more MCP servers to auto-allow, modify AUTO_ALLOW_PATTERNS.
 * For finer control, use AUTO_ALLOW_TOOLS with exact tool names.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  type PiKitSafeDeleteApprovalEvent,
  SAFE_DELETE_APPROVAL_CHANNEL,
} from "../shared/internal-events.ts";

// Prefix patterns for MCP tool names to auto-allow.
// Tool names look like: mcp__<server_name>__<tool_name>
const AUTO_ALLOW_PATTERNS: RegExp[] = [
  /^mcp__toolverse_/, // toolverse MCP server
];

// Optional: exact tool names to auto-allow (takes precedence over patterns).
// Example: ["mcp__toolverse_1787657608__global_code_search_tool"]
const AUTO_ALLOW_TOOLS: ReadonlySet<string> = new Set([]);

function shouldAutoAllow(toolName: string): boolean {
  if (AUTO_ALLOW_TOOLS.has(toolName)) return true;
  return AUTO_ALLOW_PATTERNS.some((pattern) => pattern.test(toolName));
}

export default function (pi: ExtensionAPI): void {
  pi.events.on(SAFE_DELETE_APPROVAL_CHANNEL, (data) => {
    const event = data as PiKitSafeDeleteApprovalEvent;
    // `command` is the tool name for MCP approvals and the shell command
    // for bash approvals; the mcp__ patterns only match the former.
    if (shouldAutoAllow(event.command)) {
      event.attachRemoteDecision(Promise.resolve(true));
    }
  });
}
