import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, type Key, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import type { Snippets } from "./types.js";

/** Truncate text for display in selector */
function truncateText(text: string, maxLength: number = 60): string {
	if (text.length <= maxLength) return text;
	return text.slice(0, maxLength - 3) + "...";
}

/** Build description text for a snippet */
function buildSnippetDescription(name: string, text: string): string {
	const truncated = truncateText(text.replace(/\n/g, "\\n"));
	return `"${truncated}"`;
}

/** Show snippet selector and return selected snippet name and text */
export async function showSnippetSelector(
	snippets: Snippets,
	ctx: ExtensionContext
): Promise<{ name: string; text: string } | null> {
	const names = Object.keys(snippets);

	if (names.length === 0) {
		ctx.ui.notify("No snippets defined. Use `/snippet add` to create one.", "warning");
		return null;
	}

	// Build select items with names and descriptions
	const items: SelectItem[] = names.map((name) => ({
		value: name,
		label: name,
		description: buildSnippetDescription(name, snippets[name]),
	}));

	const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

		// Header
		container.addChild(new Text(theme.fg("accent", theme.bold("Select Snippet"))));

		// SelectList with themed styling
		const selectList = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});

		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);

		container.addChild(selectList);

		// Footer hint
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

	if (!result) return null;
	return { name: result, text: snippets[result] };
}

/** Insert snippet text at cursor position in the editor */
export function insertSnippetText(text: string, ctx: ExtensionContext): void {
	const currentText = ctx.ui.getEditorText();
	const newText = currentText + text;
	ctx.ui.setEditorText(newText);
}

/** Build items for snippet management selector (with delete option) */
export function buildManagementItems(snippets: Snippets): SelectItem[] {
	const names = Object.keys(snippets);
	const items: SelectItem[] = names.map((name) => ({
		value: name,
		label: name,
		description: buildSnippetDescription(name, snippets[name]),
	}));

	// Add separator and actions
	items.push({ value: "---", label: "---", description: "" });
	items.push({ value: "add", label: "+ Add new snippet", description: "Create a new snippet" });

	return items;
}