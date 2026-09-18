export const TOOL_NAME = "web_search";
export const SETTINGS_COMMAND = "web-search-settings";

export const DEFAULT_FAST_MAX_SOURCES = 5;
export const DEFAULT_DEEP_MAX_SOURCES = 5;
export const MAX_ALLOWED_SOURCES = 10;

export const FAST_SEARCH_TIMEOUT_MS = 90_000;
export const DEEP_SEARCH_TIMEOUT_MS = 240_000;
export const DEFUDDLE_TIMEOUT_MS = 45_000;
export const MIN_TIMEOUT_MS = 5_000;
export const MAX_TIMEOUT_MS = 600_000;

export const FAST_SEARCH_QUERY_BUDGET = 10;
export const DEEP_SEARCH_QUERY_BUDGET = 24;
export const MIN_QUERY_BUDGET = 1;
export const MAX_QUERY_BUDGET = 100;

/**
 * Codex model used for web search by default.
 *
 * Codex accepts `-c web_search="..."` even when the active model cannot use the
 * hosted web search tool, and then silently performs no search at all. Pinning a
 * model that supports it avoids that trap on installs whose default Codex model
 * is a proxy or gateway model without hosted search support.
 *
 * When this model is unavailable, runs fall back to the Codex config default
 * instead of failing, so the extension still works on other machines.
 */
export const DEFAULT_CODEX_WEB_SEARCH_MODEL = "llm-gateway--gpt-5.5";
