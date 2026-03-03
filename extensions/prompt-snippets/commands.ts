import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import type { Snippets } from "./types.js";
import { buildManagementItems, showSnippetSelector } from "./selector.js";
import { addSnippet, deleteSnippet, getSnippet, loadSnippets, saveSnippets } from "./storage.js";

/** Parse command line arguments for /snippet command */
function parseSnippetArgs(args: string): { subcommand: string; name?: string; text?: string } {
	const trimmed = args.trim();
	if (!trimmed) {
		return { subcommand: "list" };
	}

	const parts = trimmed.split(/\s+/);
	const subcommand = parts[0].toLowerCase();

	switch (subcommand) {
		case "add": {
			// /snippet add <name> [text]
			// If text is provided, use it; otherwise, will open editor
			const name = parts[1];
			if (!name) {
				return { subcommand: "add", text: "" };
			}
			// Join remaining parts as text (supports spaces but not newlines in CLI)
			const text = parts.slice(2).join(" ");
			return { subcommand: "add", name, text: text || "" };
		}
		case "edit": {
			// /snippet edit <name>
			const name = parts[1];
			return { subcommand: "edit", name: name || "" };
		}
		case "delete": {
			// /snippet delete <name>
			const name = parts[1];
			return { subcommand: "delete", name: name || "" };
		}
		case "list":
		case "ls":
			return { subcommand: "list" };
		default:
			// Assume it's a snippet name to insert
			return { subcommand: "show", name: trimmed };
	}
}

/** Show snippet list in a dialog */
async function showSnippetList(snippets: Snippets, ctx: ExtensionContext): Promise<void> {
	const names = Object.keys(snippets);

	if (names.length === 0) {
		ctx.ui.notify("No snippets defined. Use `/snippet add` to create one.", "info");
		return;
	}

	const items: SelectItem[] = names.map((name) => ({
		value: name,
		label: name,
		description: snippets[name].slice(0, 50).replace(/\n/g, " "),
	}));

	await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Snippet List"))));

		const selectList = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
		});

		selectList.onSelect = async (item) => {
			// Close dialog first, then insert text
			done(null);
			const snippetText = snippets[item.value];
			const currentText = ctx.ui.getEditorText();
			ctx.ui.setEditorText(currentText + snippetText);
			ctx.ui.notify(`Inserted "${item.value}"`, "info");
		};
		selectList.onCancel = () => done(null);

		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "Ctrl+K/J navigate • enter to insert • esc cancel")));
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				// Map Ctrl+K/J to up/down
				if (data === "ctrl+k") {
					selectList.handleInput("up");
				} else if (data === "ctrl+j") {
					selectList.handleInput("down");
				} else {
					selectList.handleInput(data);
				}
				tui.requestRender();
			},
		};
	});
}

/** Handle add/edit snippet with editor */
async function editSnippet(
	snippets: Snippets,
	name: string,
	existingText: string,
	ctx: ExtensionContext
): Promise<boolean> {
	const text = await ctx.ui.editor("Edit snippet:", existingText);

	if (text === undefined) {
		// User cancelled
		return false;
	}

	if (!text.trim()) {
		ctx.ui.notify("Snippet cannot be empty", "warning");
		return false;
	}

	// Save to global config
	const updatedSnippets = addSnippet(snippets, name, text);
	saveSnippets(updatedSnippets);
	ctx.ui.notify(`Snippet "${name}" saved`, "success");
	return true;
}

/** Handle delete confirmation */
async function deleteSnippetPrompt(name: string, ctx: ExtensionContext): Promise<boolean> {
	const confirmed = await ctx.ui.confirm("Delete Snippet", `Delete snippet "${name}"?`);
	return confirmed;
}

/** Main snippet management selector */
async function showManagementSelector(snippets: Snippets, ctx: ExtensionContext): Promise<void> {
	const items = buildManagementItems(snippets);

	const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Manage Snippets"))));

		const selectList = new SelectList(items, Math.min(items.length, 12), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
		});

		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);

		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "Ctrl+K/J navigate • enter select • esc cancel")));
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				// Map Ctrl+K/J to up/down
				if (data === "ctrl+k") {
					selectList.handleInput("up");
				} else if (data === "ctrl+j") {
					selectList.handleInput("down");
				} else {
					selectList.handleInput(data);
				}
				tui.requestRender();
			},
		};
	});

	if (!result) return;

	// Handle result
	let currentSnippets = snippets;

	switch (result) {
		case "add": {
			const name = await ctx.ui.input("Snippet name:", "");
			if (name && name.trim()) {
				await editSnippet(currentSnippets, name.trim(), "", ctx);
			}
			break;
		}
		case "edit": {
			// Show snippet selector for edit
			const editResult = await showSnippetSelector(currentSnippets, ctx);
			if (editResult) {
				await editSnippet(currentSnippets, editResult.name, editResult.text, ctx);
			}
			break;
		}
		case "delete": {
			// Show snippet selector for delete
			const deleteResult = await showSnippetSelector(currentSnippets, ctx);
			if (deleteResult) {
				const confirmed = await deleteSnippetPrompt(deleteResult.name, ctx);
				if (confirmed) {
					currentSnippets = deleteSnippet(currentSnippets, deleteResult.name);
					saveSnippets(currentSnippets);
					ctx.ui.notify(`Snippet "${deleteResult.name}" deleted`, "success");
				}
			}
			break;
		}
		default: {
			// It's a snippet name, show actions for it
			const snippetText = getSnippet(currentSnippets, result);
			if (snippetText) {
				// Show action menu for this snippet
				const actionItems: SelectItem[] = [
					{ value: "insert", label: "Insert into editor", description: "Add snippet text at cursor" },
					{ value: "edit", label: "Edit", description: "Modify this snippet" },
					{ value: "delete", label: "Delete", description: "Remove this snippet" },
				];

				const action = await ctx.ui.custom<string | null>((tui2, theme2, _kb2, done2) => {
					const container2 = new Container();
					container2.addChild(new DynamicBorder((str) => theme2.fg("accent", str)));
					container2.addChild(new Text(theme2.fg("accent", theme2.bold(`Snippet: ${result}`))));

					const selectList2 = new SelectList(actionItems, actionItems.length, {
						selectedPrefix: (text) => theme2.fg("accent", text),
						selectedText: (text) => theme2.fg("accent", text),
						description: (text) => theme2.fg("muted", text),
					});

					selectList2.onSelect = (item) => done2(item.value);
					selectList2.onCancel = () => done2(null);

					container2.addChild(selectList2);
					container2.addChild(new DynamicBorder((str) => theme2.fg("accent", str)));

					return {
						render(width: number) {
							return container2.render(width);
						},
						invalidate() {
							container2.invalidate();
						},
						handleInput(data: string) {
							// Map Ctrl+K/J to up/down
							if (data === "ctrl+k") {
								selectList2.handleInput("up");
							} else if (data === "ctrl+j") {
								selectList2.handleInput("down");
							} else {
								selectList2.handleInput(data);
							}
							tui2.requestRender();
						},
					};
				});

				if (!action) return;

				switch (action) {
					case "insert": {
						const currentText = ctx.ui.getEditorText();
						ctx.ui.setEditorText(currentText + snippetText);
						ctx.ui.notify(`Inserted "${result}"`, "info");
						break;
					}
					case "edit": {
						await editSnippet(currentSnippets, result, snippetText, ctx);
						break;
					}
					case "delete": {
						const confirmed = await deleteSnippetPrompt(result, ctx);
						if (confirmed) {
							currentSnippets = deleteSnippet(currentSnippets, result);
							saveSnippets(currentSnippets);
							ctx.ui.notify(`Snippet "${result}" deleted`, "success");
						}
						break;
					}
				}
			}
		}
	}
}

/** Register /snippet command */
export function registerSnippetCommand(pi: ExtensionAPI): void {
	pi.registerCommand("snippet", {
		description: "Manage prompt snippets. Use /snippet to browse, add, edit, delete.",
		handler: async (args, ctx) => {
			const snippets = loadSnippets(ctx.cwd);
			const parsed = parseSnippetArgs(args);

			switch (parsed.subcommand) {
				case "list": {
					await showSnippetList(snippets, ctx);
					break;
				}
				case "add": {
					if (!parsed.name) {
						ctx.ui.notify("Usage: /snippet add <name> [text]", "warning");
						return;
					}
					// If text provided via CLI, use it; otherwise open editor
					if (parsed.text !== undefined && parsed.text !== "") {
						const updatedSnippets = addSnippet(snippets, parsed.name, parsed.text);
						saveSnippets(updatedSnippets);
						ctx.ui.notify(`Snippet "${parsed.name}" added`, "success");
					} else {
						await editSnippet(snippets, parsed.name, "", ctx);
					}
					break;
				}
				case "edit": {
					if (!parsed.name) {
						ctx.ui.notify("Usage: /snippet edit <name>", "warning");
						return;
					}
					const text = getSnippet(snippets, parsed.name);
					if (!text) {
						ctx.ui.notify(`Snippet "${parsed.name}" not found`, "error");
						return;
					}
					await editSnippet(snippets, parsed.name, text, ctx);
					break;
				}
				case "delete": {
					if (!parsed.name) {
						ctx.ui.notify("Usage: /snippet delete <name>", "warning");
						return;
					}
					const text = getSnippet(snippets, parsed.name);
					if (!text) {
						ctx.ui.notify(`Snippet "${parsed.name}" not found`, "error");
						return;
					}
					const confirmed = await deleteSnippetPrompt(parsed.name, ctx);
					if (confirmed) {
						const updatedSnippets = deleteSnippet(snippets, parsed.name);
						saveSnippets(updatedSnippets);
						ctx.ui.notify(`Snippet "${parsed.name}" deleted`, "success");
					}
					break;
				}
				case "show": {
					// Show specific snippet
					if (!parsed.name) {
						await showSnippetList(snippets, ctx);
						return;
					}
					const text = getSnippet(snippets, parsed.name);
					if (!text) {
						ctx.ui.notify(`Snippet "${parsed.name}" not found`, "error");
						return;
					}
					// Insert into editor
					const currentText = ctx.ui.getEditorText();
					ctx.ui.setEditorText(currentText + text);
					ctx.ui.notify(`Inserted "${parsed.name}"`, "info");
					break;
				}
				default: {
					// Default: show management UI
					await showManagementSelector(snippets, ctx);
				}
			}
		},
	});
}

/** Get current snippets (reload from disk) */
export function getCurrentSnippets(ctx: ExtensionContext): Snippets {
	return loadSnippets(ctx.cwd);
}