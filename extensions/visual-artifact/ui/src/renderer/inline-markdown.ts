function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Render the intentionally small inline-markdown subset accepted by prose
 * adapters. HTML is escaped first; only code spans and strong emphasis are
 * emitted as markup.
 */
export function renderInlineMarkdown(value: string): string {
  return value
    .split(/(`[^`\n]+`)/u)
    .map((part) => {
      if (part.startsWith("`") && part.endsWith("`")) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }

      return escapeHtml(part).replace(
        /\*\*([^*\n]+)\*\*/gu,
        "<strong>$1</strong>",
      );
    })
    .join("");
}
