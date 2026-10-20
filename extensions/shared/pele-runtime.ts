/**
 * Pele parser acquisition for Node-side Mermaid validation.
 *
 * Validators need a Mermaid-compatible parser, not a renderer. Pele is
 * synchronous and DOM-free, so this shell owns no globals and needs no
 * serialization: its only job is to load the dependency once and surface
 * load failures to the caller's degrade path.
 */

export type PeleParser = {
  parse(code: string): unknown;
};

type PeleModule = typeof import("pele");

let pelePromise: Promise<PeleModule> | null = null;

/**
 * Get the pele module (cached). A failed import is not cached, so the
 * graceful-skip path can retry on the next validation.
 */
export function getPeleParser(): Promise<PeleParser> {
  pelePromise ??= import("pele").catch((error: unknown) => {
    pelePromise = null;
    throw error;
  });
  return pelePromise;
}
