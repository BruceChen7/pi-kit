/**
 * Prompt Snippets Extension
 *
 * Provides text expansion for prompts via:
 * - Ctrl+J: Show snippet selector and insert selected snippet
 * - /snippet: Manage snippets (list, add, edit, delete)
 *
 * Configuration:
 * - Global: ~/.pi/agent/prompt-snippets.json
 * - Project: <cwd>/.pi/prompt-snippets.json (overrides global)
 *
 * Example config:
 * {
 *   "bug": "Analyze this code for bugs...\n",
 *   "refactor": "Suggest refactoring for...\n",
 *   "test": "Write comprehensive tests for...\n"
 * }
 *
 * Usage:
 * - Press Ctrl+J to open snippet selector, select one to insert
 * - /snippet list - Show all snippets
 * - /snippet add <name> [text] - Add new snippet (opens editor if no text)
 * - /snippet edit <name> - Edit existing snippet
 * /snippet delete <name> - Delete snippet
 */

import { Key } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerSnippetCommand, getCurrentSnippets } from "./commands.js";
import { loadSnippets } from "./storage.js";
import { showSnippetSelector, insertSnippetText } from "./selector.js";

export default function promptSnippetsExtension(pi: ExtensionAPI) {
	// Register /snippet command
	registerSnippetCommand(pi);

	// Register Ctrl+J shortcut for snippet insertion
	pi.registerShortcut(Key.ctrl("j"), {
		description: "Insert prompt snippet",
		handler: async (ctx) => {
			const snippets = getCurrentSnippets(ctx);
			const result = await showSnippetSelector(snippets, ctx);

			if (result) {
				insertSnippetText(result.text, ctx);
				ctx.ui.notify(`Inserted "${result.name}"`, "info");
			}
		},
	});

	// Notify on load
	pi.on("session_start", async (_event, ctx) => {
		const snippets = loadSnippets(ctx.cwd);
		const count = Object.keys(snippets).length;
		if (count > 0) {
			ctx.ui.notify(`Prompt snippets loaded: ${count} snippets`, "info");
		}
	});
}