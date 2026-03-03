/** Snippet interface representing a prompt template */
export interface Snippet {
	/** Trigger name for the snippet */
	name: string;
	/** Expanded text content */
	text: string;
}

/** Collection of snippets keyed by name */
export type Snippets = Record<string, string>;

/** Result of snippet operations */
export interface SnippetResult {
	success: boolean;
	message: string;
}