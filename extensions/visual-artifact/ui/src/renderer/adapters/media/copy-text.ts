/**
 * Pure clipboard copy strategy for SvgViewport.svelte.
 *
 * Functional core: no DOM, no globals — the shell injects the two IO
 * adapters (navigator.clipboard and the legacy textarea+execCommand
 * fallback) and this module only decides strategy order and reports the
 * outcome. The real IO side effects live in the Svelte shell.
 */

export type CopyResult = "copied" | "failed";

export interface CopyIo {
  /**
   * Modern async clipboard write (navigator.clipboard.writeText).
   * Resolve false or reject when unavailable/denied.
   */
  clipboardWrite(text: string): Promise<boolean>;
  /**
   * Legacy synchronous fallback (hidden textarea + execCommand("copy")).
   * Return false when the copy did not happen.
   */
  legacyCopy(text: string): boolean;
}

/**
 * Copy `text` to the clipboard, trying the modern API first and falling
 * back to the legacy strategy. Empty/whitespace-only text is rejected
 * without touching any IO — there is nothing meaningful to copy.
 */
export async function copyText(text: string, io: CopyIo): Promise<CopyResult> {
  if (text.trim().length === 0) return "failed";

  const primarySucceeded = await io.clipboardWrite(text).catch(() => false);
  if (primarySucceeded) return "copied";

  try {
    return io.legacyCopy(text) ? "copied" : "failed";
  } catch {
    return "failed";
  }
}
