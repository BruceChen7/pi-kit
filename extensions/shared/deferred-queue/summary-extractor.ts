/**
 * Extract the final assistant text from Pi JSON-mode output.
 *
 * Pure function: parses newline-delimited JSON events from Pi's output
 * and returns the last assistant message text.
 *
 * Matches the event format: message_end with role === "assistant".
 * Reference: extensions/librarian/index.ts
 */
export function extractAssistantSummary(stdout: string): string | undefined {
  try {
    const lines = stdout.trim().split("\n");
    let lastText = "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const event = JSON.parse(trimmed);

        if (
          event?.type === "message_end" &&
          event?.message?.role === "assistant"
        ) {
          const text = (event.message.content ?? [])
            .filter((p: Record<string, unknown>) => p?.type === "text")
            .map((p: Record<string, unknown>) => p.text as string)
            .join("\n")
            .trim();

          if (text) {
            lastText = text;
          }
        }
      } catch {
        // Non-JSON line — ignore
      }
    }

    return lastText || undefined;
  } catch {
    return undefined;
  }
}
