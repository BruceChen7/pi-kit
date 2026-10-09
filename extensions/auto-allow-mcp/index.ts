/**
 * Auto-allow MCP tool calls
 *
 * Automatically allows toolverse MCP tool calls without requiring user
 * confirmation. Useful when you trust the MCP server and want to avoid
 * frequent permission prompts.
 *
 * To add more MCP servers to auto-allow, modify AUTO_ALLOW_PATTERNS.
 * For finer control, use AUTO_ALLOW_TOOLS with exact tool names.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
  pi.on("tool_call", async (event, _ctx) => {
    if (shouldAutoAllow(event.toolName)) {
      // Return undefined to not block the tool call.
      return undefined;
    }
    return undefined;
  });
}
