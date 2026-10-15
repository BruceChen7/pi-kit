/**
 * Shared Mermaid runtime bootstrap: bounded DOM shim + parser singleton.
 *
 * Both plannotator-auto (plan mermaid validation before review submission)
 * and visual-artifact (artifact mermaid validation) parse Mermaid in Node.
 * Mermaid needs a DOM for most diagram types (flowchart, mindmap,
 * stateDiagram, classDiagram, gitGraph pull in DOMPurify), so we install a
 * linkedom shim — but only inside a bounded window: install → work → restore.
 *
 * Never leave `window` / `document` / `HTMLElement` behind. Hosts such as
 * Pi Web run agent sessions inside their own HTTP server process, where any
 * `typeof window !== "undefined"` pushes Next.js onto browser code paths
 * (e.g. `getLocationOrigin()` destructuring `window.location`), turning every
 * later request into a 500 until the server is restarted.
 *
 * Architecture: Functional Core, Imperative Shell — this is the **shell**:
 * global state (window/document globals + module cache) and dependency
 * acquisition live here; the pure parse/validate logic lives in callers.
 */

export type MermaidParser = {
  initialize(config: Record<string, unknown>): void;
  parse(code: string): Promise<unknown>;
};

const DOM_GLOBALS = ["window", "document", "HTMLElement"] as const;

let mermaidModule: MermaidParser | null = null;
let parserFacade: MermaidParser | null = null;
let queue: Promise<unknown> = Promise.resolve();

/**
 * Run one task at a time so the DOM shim can never be observed half-installed:
 * `validateMermaidNodesInSpec` parses several diagrams concurrently.
 */
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  // Keep the chain settled (never rejected) so one failure cannot block the rest.
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Install the linkedom shim and return its restore function.
 * A host that already provides a DOM (browser, test host, another shim) is
 * never touched: the returned restore is a no-op.
 */
async function acquireDom(): Promise<() => void> {
  const host = globalThis as Record<string, unknown>;
  if (
    typeof host.window !== "undefined" &&
    typeof host.document !== "undefined"
  ) {
    return () => {};
  }

  const { parseHTML } = await import("linkedom");
  const dom = parseHTML(
    "<!DOCTYPE html><html><body></body></html>",
  ) as unknown as {
    window: { HTMLElement: unknown };
    document: unknown;
  };

  const previous = DOM_GLOBALS.map((key) => ({
    key,
    existed: Object.hasOwn(host, key),
    value: host[key],
  }));

  host.window = dom.window;
  host.document = dom.document;
  host.HTMLElement = dom.window.HTMLElement;

  return () => {
    for (const { key, existed, value } of previous) {
      if (existed) {
        host[key] = value;
      } else {
        delete host[key];
      }
    }
  };
}

/** Bounded DOM window: install → run → restore, error paths included. */
async function withDom<T>(task: () => Promise<T>): Promise<T> {
  const restore = await acquireDom();
  try {
    return await task();
  } finally {
    restore();
  }
}

async function loadMermaid(): Promise<MermaidParser> {
  if (!mermaidModule) {
    // Importing mermaid is the expensive part (~600ms) and needs the DOM too.
    mermaidModule = await serialized(() =>
      withDom(async () => (await import("mermaid")).default as MermaidParser),
    );
  }
  return mermaidModule;
}

/**
 * Get the mermaid parser instance (cached). Every parse runs inside its own
 * bounded DOM window, so the host process is left without a DOM afterwards.
 *
 * `initialize` is passed through untouched: it does not need a DOM.
 */
export async function getMermaidParser(): Promise<MermaidParser> {
  const mermaid = await loadMermaid();
  if (!parserFacade) {
    parserFacade = {
      initialize: (config) => mermaid.initialize(config),
      parse: (code) => serialized(() => withDom(() => mermaid.parse(code))),
    };
  }
  return parserFacade;
}

/**
 * Reset the cached mermaid module for test isolation.
 * Call in beforeEach/afterEach when tests must not share mermaid state.
 */
export function resetMermaidModule(): void {
  mermaidModule = null;
  parserFacade = null;
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
