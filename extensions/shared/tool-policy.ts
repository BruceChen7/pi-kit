import { pathsFromToolArgs, type ToolTargetPath } from "./tool-targets.ts";

/**
 * Hints a tool declares about what it does. They mirror MCP tool annotations
 * (`extensions.md#tool-exposure`); MCP servers send them and pi exposes them
 * through `pi.getAllTools()`.
 */
export type ToolAnnotationHints = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

/** The slice of `pi.getAllTools()` this module needs. */
export type ToolInfoLike = {
  name: string;
  annotations?: ToolAnnotationHints;
};

export type ToolCallKind =
  /** Declared read-only. */
  | "read"
  /** Not proven read-only, so it may modify something. */
  | "write"
  /** Unknown tool surface, for example a pi-kit extension tool. */
  | "unknown";

export type ToolCallPolicy = {
  /** True for `mcp__<server>__<tool>` names. */
  isMcp: boolean;
  kind: ToolCallKind;
  /** File paths found in the call arguments; only extracted for MCP tools. */
  paths: ToolTargetPath[];
  readOnly: boolean;
  /** MCP default when the hint is missing: a non-read-only tool may destroy data. */
  destructive: boolean;
  /** MCP default when the hint is missing: a non-read-only tool may reach outside pi. */
  openWorld: boolean;
  /** Whether a permission gate should ask the user before running the call. */
  requiresApproval: boolean;
};

export const MCP_TOOL_PREFIX = "mcp__";

export const isMcpToolName = (toolName: string): boolean =>
  toolName.startsWith(MCP_TOOL_PREFIX);

/**
 * `mcp__<server>__<tool>` -> server name, or `null` for other tools. Server
 * names keep their original spelling only when it is alphanumeric; a display
 * name is not recoverable from a tool name (`-` and `_` collapse to `_`), so
 * this is only used for messages.
 */
export const mcpServerName = (toolName: string): string | null => {
  if (!isMcpToolName(toolName)) {
    return null;
  }

  const rest = toolName.slice(MCP_TOOL_PREFIX.length);
  const separator = rest.indexOf("__");
  return separator === -1 ? rest : rest.slice(0, separator);
};

export const findToolAnnotations = (
  tools: readonly ToolInfoLike[] | undefined,
  toolName: string,
): ToolAnnotationHints | undefined =>
  tools?.find((tool) => tool.name === toolName)?.annotations;

const NON_MCP_POLICY: ToolCallPolicy = {
  isMcp: false,
  kind: "unknown",
  paths: [],
  readOnly: false,
  destructive: false,
  openWorld: false,
  requiresApproval: false,
};

/**
 * Classify one tool call. Pure: the caller passes the tool's annotations (from
 * its own `pi.getAllTools()` snapshot) instead of the runtime.
 *
 * Only `mcp__*` tools get a kind other than `"unknown"`. pi-kit's own tools
 * keep their existing name-based handling, so adding this policy cannot change
 * behavior on a machine without MCP servers.
 *
 * A missing `readOnlyHint` means "not read-only" (the MCP default), which makes
 * plan mode and permission gates conservative for servers that declare
 * nothing. Tools that are not connected yet are unknown, so the same default
 * applies until the server announces its hints.
 */
export const classifyToolCall = (input: {
  toolName: string;
  args: unknown;
  annotations?: ToolAnnotationHints;
}): ToolCallPolicy => {
  if (!isMcpToolName(input.toolName)) {
    return NON_MCP_POLICY;
  }

  const readOnly = input.annotations?.readOnlyHint === true;
  const destructive = !readOnly && (input.annotations?.destructiveHint ?? true);
  const openWorld = !readOnly && (input.annotations?.openWorldHint ?? true);

  return {
    isMcp: true,
    kind: readOnly ? "read" : "write",
    paths: pathsFromToolArgs(input.args),
    readOnly,
    destructive,
    openWorld,
    requiresApproval: !readOnly && (destructive || openWorld),
  };
};

const DEFAULT_MAX_SUMMARY_CHARS = 1000;

const formatHints = (annotations: ToolAnnotationHints | undefined): string => {
  const hints = annotations ?? {};
  return [
    hints.readOnlyHint === true ? "read-only" : "not read-only",
    (hints.destructiveHint ?? true) ? "may delete or overwrite" : "additive",
    (hints.openWorldHint ?? true)
      ? "reaches external systems"
      : "closed domain",
  ].join(", ");
};

const truncate = (text: string, maxChars: number): string =>
  text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}\n… (arguments truncated)`;

const formatArgs = (args: unknown): string => {
  try {
    return JSON.stringify(args, null, 2) ?? String(args);
  } catch {
    return String(args);
  }
};

/**
 * Confirmation body for a gate that runs before an MCP call. Pure value in /
 * value out so Safe-delete and future gates render the same text.
 */
export const formatMcpCallSummary = (input: {
  toolName: string;
  args: unknown;
  annotations?: ToolAnnotationHints;
  maxChars?: number;
}): string => {
  const server = mcpServerName(input.toolName);
  const lines = [
    `Tool: ${input.toolName}`,
    ...(server ? [`Server: ${server}`] : []),
    `Declared hints: ${formatHints(input.annotations)}`,
    "",
    "Arguments:",
    truncate(
      formatArgs(input.args),
      input.maxChars ?? DEFAULT_MAX_SUMMARY_CHARS,
    ),
  ];

  return lines.join("\n");
};
