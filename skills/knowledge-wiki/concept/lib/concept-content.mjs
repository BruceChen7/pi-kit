/**
 * concept-content.mjs
 *
 * Pure functional core of wiki-concept.mjs: builds concept file content
 * with no IO and no side effects. Kept in a separate module so tests (and
 * other tools) can import it without triggering the CLI shell's import-time
 * knowledge-dir resolution in lib/paths.mjs.
 */

/**
 * Build the full content of a concept markdown file.
 *
 * Pure function — no IO, no side effects. Returns the string that should
 * be written to the concept file. Can be tested without mocking the
 * filesystem or stdin.
 *
 * When `body` is empty, produces a skeleton (frontmatter + title + empty
 * Sources section). When `body` is provided, it is inserted between the
 * title and Sources.
 *
 * @param {object} params
 * @param {string} params.displayName - Human-readable concept name
 * @param {string} params.type - "Concept" or "Synthesis"
 * @param {string} params.icon - Frontmatter _icon value
 * @param {string} params.tags - JSON array string like '["tag1","tag2"]'
 * @param {string} params.body - Markdown body content (empty string for skeleton)
 * @returns {string} Full concept file content
 */
export function buildConceptContent({ displayName, type, icon, tags, body }) {
  const parts = [
    "---",
    `type: ${type}`,
    `_icon: ${icon}`,
    `tags: ${tags}`,
    "---",
    "",
    `# ${displayName}`,
  ];

  if (body) {
    parts.push("", body);
  }

  parts.push("", "## Sources", "");
  return parts.join("\n");
}
