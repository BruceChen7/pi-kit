import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

/**
 * Extension that seeds the prompt editor history with recent prompts from the
 * current session and other sessions started in the same working directory.
 */
const MAX_HISTORY_ENTRIES = 100;
const MAX_RECENT_PROMPTS = 30;

interface PromptEntry {
	text: string;
	timestamp: number;
}

class HistoryEditor extends CustomEditor {
	private lockedBorder = false;
	private _borderColor?: (text: string) => string;
	private promptHistory: PromptEntry[] = [];

	// Search mode state
	private searchMode = false;
	private searchQuery = "";
	private searchResults: PromptEntry[] = [];
	private searchIndex = -1;
	private originalText = "";

	constructor(
		tui: ConstructorParameters<typeof CustomEditor>[0],
		theme: ConstructorParameters<typeof CustomEditor>[1],
		keybindings: ConstructorParameters<typeof CustomEditor>[2],
	) {
		super(tui, theme, keybindings);
		delete (this as { borderColor?: (text: string) => string }).borderColor;
		Object.defineProperty(this, "borderColor", {
			get: () => this._borderColor ?? ((text: string) => text),
			set: (value: (text: string) => string) => {
				if (this.lockedBorder) return;
				this._borderColor = value;
			},
			configurable: true,
			enumerable: true,
		});
	}

	lockBorderColor() {
		this.lockedBorder = true;
	}

	public setHistory(history: PromptEntry[]): void {
		this.promptHistory = history;
	}

	override handleInput(data: string): void {
		// Ctrl+R (0x12) enters search mode
		if (data === "\x12" && !this.searchMode) {
			this.enterSearchMode();
			return;
		}

		if (this.searchMode) {
			this.handleSearchInput(data);
			return;
		}

		// Default behavior
		super.handleInput(data);
	}

	private enterSearchMode(): void {
		this.searchMode = true;
		this.searchQuery = "";
		this.searchResults = [];
		this.searchIndex = -1;
		this.originalText = this.getText();
	}

	private handleSearchInput(data: string): void {
		const tui = (this as { _tui?: any })._tui;

		// Escape: exit search, restore original text
		if (data === "\x1b") {
			this.exitSearchMode(false);
			tui?.requestRender();
			return;
		}

		// Enter: accept current match, exit search
		if (data === "\r" || data === "\n") {
			this.exitSearchMode(true);
			tui?.requestRender();
			return;
		}

		// Ctrl+G (0x07): cancel search, restore original text (like bash)
		if (data === "\x07") {
			this.exitSearchMode(false);
			tui?.requestRender();
			return;
		}

		// Ctrl+R (0x12): search for next match
		if (data === "\x12") {
			this.searchNext();
			tui?.requestRender();
			return;
		}

		// Backspace: delete search character
		if (data === "\x7f" || data === "\x08") {
			if (this.searchQuery.length > 0) {
				this.searchQuery = this.searchQuery.slice(0, -1);
				this.performSearch();
			}
			tui?.requestRender();
			return;
		}

		// Regular character: add to search query
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.searchQuery += data;
			this.performSearch();
			tui?.requestRender();
			return;
		}

		// Other keys: pass to default handler
		super.handleInput(data);
	}

	private performSearch(): void {
		if (!this.searchQuery) {
			this.searchResults = [];
			this.searchIndex = -1;
			return;
		}

		// Regex + case insensitive (fd style)
		try {
			const regex = new RegExp(this.searchQuery, "i");
			this.searchResults = this.promptHistory.filter(entry => regex.test(entry.text));
			this.searchIndex = this.searchResults.length > 0 ? 0 : -1;
		} catch {
			this.searchResults = [];
			this.searchIndex = -1;
		}
	}

	private searchNext(): void {
		if (this.searchResults.length === 0) return;
		this.searchIndex = (this.searchIndex + 1) % this.searchResults.length;
	}

	private exitSearchMode(accept: boolean): void {
		this.searchMode = false;

		if (accept && this.searchIndex >= 0) {
			const matched = this.searchResults[this.searchIndex];
			this.setText(matched.text);
		} else {
			this.setText(this.originalText);
		}

		this.searchQuery = "";
		this.searchResults = [];
		this.searchIndex = -1;
		this.originalText = "";
	}

	private highlightMatch(text: string): string {
		if (!this.searchQuery) return text;
		try {
			const regex = new RegExp(`(${this.searchQuery})`, "gi");
			return text.replace(regex, "\x1b[7m$1\x1b[27m");
		} catch {
			return text;
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);

		if (this.searchMode && lines.length > 0) {
			const searchPrompt = `(reverse-i-search)\`${this.searchQuery}': `;
			const match = this.searchIndex >= 0 ? this.searchResults[this.searchIndex] : null;

			if (match) {
				const highlighted = this.highlightMatch(match.text);
				const promptWidth = visibleWidth(searchPrompt);
				const maxContentWidth = Math.max(0, width - promptWidth);
				const truncated = truncateToWidth(highlighted, maxContentWidth, "...", false);
				lines[lines.length - 1] = searchPrompt + truncated;
			} else {
				lines[lines.length - 1] = searchPrompt + "(no match)";
			}

			// Add status line
			if (this.searchResults.length > 0) {
				const count = this.searchResults.length;
				lines.push(`[${this.searchIndex + 1}/${count}] hit Enter to select, Ctrl+G to cancel`);
			} else if (this.searchQuery) {
				lines.push("(failed)");
			}
		}

		return lines;
	}
}

function extractText(content: Array<{ type: string; text?: string }>): string {
	const text = content
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text ?? "")
		.join("");

	// Filter out skill tag blocks to avoid searching system prompts
	// Format: <skill name="..." location="...">...</skill>
	const skillTagRegex = /<skill\s+[^>]*>[\s\S]*?<\/skill>/gi;
	let filtered = text.replace(skillTagRegex, "");

	// Filter out extension-generated prompts (e.g., review guidelines from review.ts)
	// These are system prompts injected by extensions that shouldn't appear in history search
	const extensionPromptPatterns = [
		/^# Review Guidelines\s*\n/i, // REVIEW_RUBRIC from review.ts
	];

	for (const pattern of extensionPromptPatterns) {
		if (pattern.test(filtered)) {
			return "";
		}
	}

	return filtered.trim();
}

function collectUserPromptsFromEntries(entries: Array<any>): PromptEntry[] {
	const prompts: PromptEntry[] = [];

	for (const entry of entries) {
		if (entry?.type !== "message") continue;
		const message = entry?.message;
		if (!message || message.role !== "user" || !Array.isArray(message.content)) continue;
		const text = extractText(message.content);
		if (!text) continue;
		const timestamp = Number(message.timestamp ?? entry.timestamp ?? Date.now());
		prompts.push({ text, timestamp });
	}

	return prompts;
}

function getSessionDirForCwd(cwd: string): string {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return path.join(os.homedir(), ".pi", "agent", "sessions", safePath);
}

async function readTail(filePath: string, maxBytes = 256 * 1024): Promise<string> {
	let fileHandle: fs.FileHandle | undefined;
	try {
		const stats = await fs.stat(filePath);
		const size = stats.size;
		const start = Math.max(0, size - maxBytes);
		const length = size - start;
		if (length <= 0) return "";

		const buffer = Buffer.alloc(length);
		fileHandle = await fs.open(filePath, "r");
		const { bytesRead } = await fileHandle.read(buffer, 0, length, start);
		if (bytesRead === 0) return "";
		let chunk = buffer.subarray(0, bytesRead).toString("utf8");
		if (start > 0) {
			const firstNewline = chunk.indexOf("\n");
			if (firstNewline !== -1) {
				chunk = chunk.slice(firstNewline + 1);
			}
		}
		return chunk;
	} catch {
		return "";
	} finally {
		await fileHandle?.close();
	}
}

async function loadPromptHistoryForCwd(cwd: string, excludeSessionFile?: string): Promise<PromptEntry[]> {
	const sessionDir = getSessionDirForCwd(path.resolve(cwd));
	const resolvedExclude = excludeSessionFile ? path.resolve(excludeSessionFile) : undefined;
	const prompts: PromptEntry[] = [];

	let entries: fs.Dirent[] = [];
	try {
		entries = await fs.readdir(sessionDir, { withFileTypes: true });
	} catch {
		return prompts;
	}

	const files = await Promise.all(
		entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
			.map(async (entry) => {
				const filePath = path.join(sessionDir, entry.name);
				try {
					const stats = await fs.stat(filePath);
					return { filePath, mtimeMs: stats.mtimeMs };
				} catch {
					return undefined;
				}
			})
	);

	const sortedFiles = files
		.filter((file): file is { filePath: string; mtimeMs: number } => Boolean(file))
		.sort((a, b) => b.mtimeMs - a.mtimeMs);

	for (const file of sortedFiles) {
		if (resolvedExclude && path.resolve(file.filePath) === resolvedExclude) continue;

		const tail = await readTail(file.filePath);
		if (!tail) continue;
		const lines = tail.split("\n").filter(Boolean);
		for (const line of lines) {
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry?.type !== "message") continue;
			const message = entry?.message;
			if (!message || message.role !== "user" || !Array.isArray(message.content)) continue;
			const text = extractText(message.content);
			if (!text) continue;
			const timestamp = Number(message.timestamp ?? entry.timestamp ?? Date.now());
			prompts.push({ text, timestamp });
			if (prompts.length >= MAX_RECENT_PROMPTS) break;
		}
		if (prompts.length >= MAX_RECENT_PROMPTS) break;
	}

	return prompts;
}

function buildHistoryList(currentSession: PromptEntry[], previousSessions: PromptEntry[]): PromptEntry[] {
	const all = [...currentSession, ...previousSessions];
	all.sort((a, b) => a.timestamp - b.timestamp);

	const seen = new Set<string>();
	const deduped: PromptEntry[] = [];
	for (const prompt of all) {
		const key = `${prompt.timestamp}:${prompt.text}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(prompt);
	}

	return deduped.slice(-MAX_HISTORY_ENTRIES);
}

let loadCounter = 0;

function historiesMatch(a: PromptEntry[], b: PromptEntry[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		if (a[i]?.text !== b[i]?.text || a[i]?.timestamp !== b[i]?.timestamp) return false;
	}
	return true;
}

function setEditorHistory(pi: ExtensionAPI, ctx: ExtensionContext, history: PromptEntry[]) {
	ctx.ui.setEditorComponent((tui, theme, keybindings) => {
		const editor = new HistoryEditor(tui, theme, keybindings);
		const borderColor = (text: string) => {
			const isBashMode = editor.getText().trimStart().startsWith("!");
			const colorFn = isBashMode
				? ctx.ui.theme.getBashModeBorderColor()
				: ctx.ui.theme.getThinkingBorderColor(pi.getThinkingLevel());
			return colorFn(text);
		};

		editor.borderColor = borderColor;
		editor.lockBorderColor();
		for (const prompt of history) {
			editor.addToHistory?.(prompt.text);
		}
		editor.setHistory(history);
		return editor;
	});
}

function applyEditorWithHistory(pi: ExtensionAPI, ctx: ExtensionContext) {
	if (!ctx.hasUI) return;

	const sessionFile = ctx.sessionManager.getSessionFile();
	const currentEntries = ctx.sessionManager.getBranch();
	const currentPrompts = collectUserPromptsFromEntries(currentEntries);
	const immediateHistory = buildHistoryList(currentPrompts, []);

	const currentLoad = ++loadCounter;
	const initialText = ctx.ui.getEditorText();
	setEditorHistory(pi, ctx, immediateHistory);

	void (async () => {
		const previousPrompts = await loadPromptHistoryForCwd(ctx.cwd, sessionFile ?? undefined);
		if (currentLoad !== loadCounter) return;
		if (ctx.ui.getEditorText() !== initialText) return;
		const history = buildHistoryList(currentPrompts, previousPrompts);
		if (historiesMatch(history, immediateHistory)) return;
		setEditorHistory(pi, ctx, history);
	})();
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		applyEditorWithHistory(pi, ctx);
	});

	pi.on("session_switch", (_event, ctx) => {
		applyEditorWithHistory(pi, ctx);
	});
}
