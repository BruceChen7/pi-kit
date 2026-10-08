import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

/**
 * JSON-safe payload type for `structuredContent`, taken from the pi API so we
 * do not restate `JsonValue` (pi does not export that type from its package
 * root). A value of this type is what codemode scripts receive instead of the
 * model-facing text.
 */
export type StructuredPayload = NonNullable<
  AgentToolResult["structuredContent"]
>;

/**
 * Pure: pair model-facing text with a structured payload.
 *
 * `details` and `structuredContent` point at the same object on purpose — the
 * payload is built once, so what the UI/logs read and what programmatic callers
 * (codemode scripts, `ctx.executeTool()`) read cannot drift apart. Tools that
 * declare an `outputSchema` must always set `structuredContent`.
 */
export function structuredResult<T extends StructuredPayload>(
  text: string,
  structured: T,
): AgentToolResult<T> {
  return {
    content: [{ type: "text", text }],
    details: structured,
    structuredContent: structured,
  };
}
