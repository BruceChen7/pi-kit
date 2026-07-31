/**
 * Shared Mermaid runtime bootstrap: DOM shim + parser singleton.
 *
 * Both plannotator-auto (plan mermaid validation before review submission)
 * and visual-artifact (artifact mermaid validation) parse Mermaid in Node.
 * Mermaid needs a DOM for most diagram types (flowchart, mindmap,
 * stateDiagram, classDiagram, gitGraph pull in DOMPurify), so we install a
 * linkedom shim once, before the mermaid module is first imported.
 *
 * Architecture: Functional Core, Imperative Shell — this is the **shell**:
 * global state (window/document globals + module cache) and dependency
 * acquisition live here; the pure parse/validate logic lives in callers.
 */

export type MermaidParser = {
  initialize(config: Record<string, unknown>): void;
  parse(code: string): Promise<unknown>;
};

let mermaidModule: MermaidParser | null = null;

/** Install a minimal DOM shim (linkedom) before mermaid is imported. Idempotent. */
export async function ensureDom(): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.window !== "undefined" && typeof g.document !== "undefined") {
    return;
  }
  const { parseHTML } = await import("linkedom");
  const dom = parseHTML(
    "<!DOCTYPE html><html><body></body></html>",
  ) as unknown as {
    window: { HTMLElement: unknown };
    document: unknown;
  };
  g.window = dom.window;
  g.document = dom.document;
  g.HTMLElement = dom.window.HTMLElement;
}

/** Get the mermaid parser instance (cached). Ensures DOM is set up first. */
export async function getMermaidParser(): Promise<MermaidParser> {
  if (!mermaidModule) {
    await ensureDom();
    mermaidModule = (await import("mermaid")).default as MermaidParser;
  }
  return mermaidModule;
}

/**
 * Reset the cached mermaid module for test isolation.
 * Call in beforeEach/afterEach when tests must not share mermaid state.
 */
export function resetMermaidModule(): void {
  mermaidModule = null;
}

/** Clean a mermaid parse error for agent-facing messages (drops the excerpt). */
export function formatMermaidError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\n+\.*[\s\S]*?\^\n*/u, " ")
    .replace(/Parse error on line \d+:\s*/u, "")
    .trim();
}

/**
 * Extract the 1-based line number (relative to the parsed code string)
 * from a mermaid parse error, if present. Callers combine it with the
 * code block's start line in the parent document.
 */
export function extractMermaidErrorLine(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/Parse error on line (\d+):/u);
  return match ? Number(match[1]) : undefined;
}
