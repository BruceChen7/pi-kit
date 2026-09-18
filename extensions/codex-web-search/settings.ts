import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEEP_SEARCH_QUERY_BUDGET,
  DEEP_SEARCH_TIMEOUT_MS,
  DEFAULT_CODEX_WEB_SEARCH_MODEL,
  DEFAULT_DEEP_MAX_SOURCES,
  DEFAULT_FAST_MAX_SOURCES,
  DEFUDDLE_TIMEOUT_MS,
  FAST_SEARCH_QUERY_BUDGET,
  FAST_SEARCH_TIMEOUT_MS,
  MAX_ALLOWED_SOURCES,
  MAX_QUERY_BUDGET,
  MAX_TIMEOUT_MS,
  MIN_QUERY_BUDGET,
  MIN_TIMEOUT_MS,
} from "./constants.js";
import type {
  DefuddleMode,
  SearchFreshness,
  SearchMode,
  WebSearchSettings,
} from "./types.js";

export const DEFAULT_WEB_SEARCH_SETTINGS: WebSearchSettings = {
  defaultMode: "fast",
  fastFreshness: "cached",
  deepFreshness: "live",
  fastMaxSources: DEFAULT_FAST_MAX_SOURCES,
  deepMaxSources: DEFAULT_DEEP_MAX_SOURCES,
  codexModel: DEFAULT_CODEX_WEB_SEARCH_MODEL,
  defuddleMode: "direct",
  fastTimeoutMs: FAST_SEARCH_TIMEOUT_MS,
  deepTimeoutMs: DEEP_SEARCH_TIMEOUT_MS,
  defuddleTimeoutMs: DEFUDDLE_TIMEOUT_MS,
  fastQueryBudget: FAST_SEARCH_QUERY_BUDGET,
  deepQueryBudget: DEEP_SEARCH_QUERY_BUDGET,
};

export const SETTINGS_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "pi-codex-web-search.settings.json",
);

export async function loadSettings(
  path = SETTINGS_PATH,
): Promise<WebSearchSettings> {
  try {
    const raw = await readFile(path, "utf-8");
    try {
      return normalizeSettings(JSON.parse(raw) as unknown);
    } catch {
      return { ...DEFAULT_WEB_SEARCH_SETTINGS };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_WEB_SEARCH_SETTINGS };
    }
    throw error;
  }
}

export async function saveSettings(
  settings: Partial<WebSearchSettings>,
  path = SETTINGS_PATH,
): Promise<WebSearchSettings> {
  const normalized = normalizeSettings(settings);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
  return normalized;
}

export function formatSettings(settings: WebSearchSettings): string {
  return [
    "Search defaults:",
    `  Default mode: ${settings.defaultMode}`,
    `  Fast freshness: ${settings.fastFreshness}`,
    `  Deep freshness: ${settings.deepFreshness}`,
    `  Fast max sources: ${settings.fastMaxSources}`,
    `  Deep max sources: ${settings.deepMaxSources}`,
    "",
    "Codex runtime:",
    `  Model: ${formatCodexModel(settings.codexModel)}`,
    "",
    "Defuddle behavior:",
    `  Mode: ${settings.defuddleMode}`,
    "",
    "Timeouts:",
    `  Fast: ${formatDuration(settings.fastTimeoutMs)}`,
    `  Deep: ${formatDuration(settings.deepTimeoutMs)}`,
    `  Defuddle: ${formatDuration(settings.defuddleTimeoutMs)}`,
    "",
    "Query budgets:",
    `  Fast: ${settings.fastQueryBudget}`,
    `  Deep: ${settings.deepQueryBudget}`,
  ].join("\n");
}

export function formatCodexModel(model: string): string {
  return model.trim() ? model.trim() : "inherit from Codex config";
}

export function normalizeSettings(value: unknown): WebSearchSettings {
  const candidate = value && typeof value === "object" ? value : {};
  const typedCandidate = candidate as {
    defaultMode?: unknown;
    fastFreshness?: unknown;
    deepFreshness?: unknown;
    fastMaxSources?: unknown;
    deepMaxSources?: unknown;
    defaultMaxSources?: unknown;
    codexModel?: unknown;
    defuddleMode?: unknown;
    fastTimeoutMs?: unknown;
    deepTimeoutMs?: unknown;
    defuddleTimeoutMs?: unknown;
    fastQueryBudget?: unknown;
    deepQueryBudget?: unknown;
  };
  const legacyMaxSources = asOptionalIntegerInRange(
    typedCandidate.defaultMaxSources,
    1,
    MAX_ALLOWED_SOURCES,
  );

  return {
    defaultMode: asMode(
      typedCandidate.defaultMode,
      DEFAULT_WEB_SEARCH_SETTINGS.defaultMode,
    ),
    fastFreshness: asFreshness(
      typedCandidate.fastFreshness,
      DEFAULT_WEB_SEARCH_SETTINGS.fastFreshness,
    ),
    deepFreshness: asFreshness(
      typedCandidate.deepFreshness,
      DEFAULT_WEB_SEARCH_SETTINGS.deepFreshness,
    ),
    fastMaxSources: asIntegerInRange(
      typedCandidate.fastMaxSources,
      1,
      MAX_ALLOWED_SOURCES,
      legacyMaxSources ?? DEFAULT_WEB_SEARCH_SETTINGS.fastMaxSources,
    ),
    deepMaxSources: asIntegerInRange(
      typedCandidate.deepMaxSources,
      1,
      MAX_ALLOWED_SOURCES,
      legacyMaxSources ?? DEFAULT_WEB_SEARCH_SETTINGS.deepMaxSources,
    ),
    codexModel: asModel(typedCandidate.codexModel),
    defuddleMode: asDefuddleMode(
      typedCandidate.defuddleMode,
      DEFAULT_WEB_SEARCH_SETTINGS.defuddleMode,
    ),
    fastTimeoutMs: asIntegerInRange(
      typedCandidate.fastTimeoutMs,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      DEFAULT_WEB_SEARCH_SETTINGS.fastTimeoutMs,
    ),
    deepTimeoutMs: asIntegerInRange(
      typedCandidate.deepTimeoutMs,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      DEFAULT_WEB_SEARCH_SETTINGS.deepTimeoutMs,
    ),
    defuddleTimeoutMs: asIntegerInRange(
      typedCandidate.defuddleTimeoutMs,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      DEFAULT_WEB_SEARCH_SETTINGS.defuddleTimeoutMs,
    ),
    fastQueryBudget: asIntegerInRange(
      typedCandidate.fastQueryBudget,
      MIN_QUERY_BUDGET,
      MAX_QUERY_BUDGET,
      DEFAULT_WEB_SEARCH_SETTINGS.fastQueryBudget,
    ),
    deepQueryBudget: asIntegerInRange(
      typedCandidate.deepQueryBudget,
      MIN_QUERY_BUDGET,
      MAX_QUERY_BUDGET,
      DEFAULT_WEB_SEARCH_SETTINGS.deepQueryBudget,
    ),
  };
}

function formatDuration(value: number): string {
  if (value % 1_000 === 0) {
    return `${value / 1_000}s (${value} ms)`;
  }
  return `${value} ms`;
}

function asMode(value: unknown, fallback: SearchMode): SearchMode {
  return value === "fast" || value === "deep" ? value : fallback;
}

function asFreshness(
  value: unknown,
  fallback: SearchFreshness,
): SearchFreshness {
  return value === "cached" || value === "live" ? value : fallback;
}

const CODEX_MODEL_INHERIT_VALUES = new Set([
  "",
  "inherit",
  "default",
  "none",
  "off",
]);

/**
 * Normalizes a Codex model override. Empty or inherit-style values mean
 * "use whatever model the user's Codex config selects".
 */
export function asModel(value: unknown): string {
  if (typeof value !== "string") {
    return DEFAULT_WEB_SEARCH_SETTINGS.codexModel;
  }

  const trimmed = value.trim();
  return CODEX_MODEL_INHERIT_VALUES.has(trimmed.toLowerCase()) ? "" : trimmed;
}

function asDefuddleMode(value: unknown, fallback: DefuddleMode): DefuddleMode {
  return value === "off" ||
    value === "direct" ||
    value === "fallback" ||
    value === "both"
    ? value
    : fallback;
}

function asOptionalIntegerInRange(
  value: unknown,
  min: number,
  max: number,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const rounded = Math.trunc(value);
  if (rounded < min || rounded > max) {
    return undefined;
  }

  return rounded;
}

function asIntegerInRange(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  return asOptionalIntegerInRange(value, min, max) ?? fallback;
}
