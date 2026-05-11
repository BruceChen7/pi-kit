/**
 * Prompt Copy Extension
 *
 * Ctrl+Shift+Y: Copy the current prompt editor text to the clipboard.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

import { isStaleSessionContextError } from "../shared/stale-context.js";

const STATUS_KEY = "prompt-copy";
const STATUS_DURATION_MS = 2000;

function showStatus(
  ctx: ExtensionCommandContext,
  message: string,
  level: "info" | "warning" = "info",
  clearTimerRef: { value: ReturnType<typeof setTimeout> | null },
): void {
  if (ctx.hasUI) {
    ctx.ui.setStatus(STATUS_KEY, message);
    if (clearTimerRef.value) {
      clearTimeout(clearTimerRef.value);
    }
    clearTimerRef.value = setTimeout(() => {
      try {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      } catch (error) {
        if (!isStaleSessionContextError(error)) {
          throw error;
        }
      } finally {
        clearTimerRef.value = null;
      }
    }, STATUS_DURATION_MS);
    return;
  }

  ctx.ui.notify(message, level);
}

export default function promptCopyExtension(pi: ExtensionAPI) {
  const clearTimerRef: { value: ReturnType<typeof setTimeout> | null } = {
    value: null,
  };

  pi.registerShortcut(Key.ctrlShift("y"), {
    description: "Copy prompt editor to clipboard (Ctrl+Shift+Y)",
    handler: (ctx) => {
      const rawText = ctx.ui.getEditorText();
      const text = rawText.trim();

      if (!text) {
        showStatus(ctx, "Nothing to copy", "warning", clearTimerRef);
        return;
      }

      copyToClipboard(text);
      showStatus(ctx, "Copied to clipboard", "info", clearTimerRef);
    },
  });
}
