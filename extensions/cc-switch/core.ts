/**
 * cc-switch core — pure proxy/catalog data → pi-model conversion.
 *
 * Functional core: value in / value out, no IO, no logger, no pi API.
 * The imperative shell lives in index.ts (fetching, catalog file read,
 * registration, commands).
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

// pi's public entry exports only the `ProviderModelConfig` union. The proxy
// conversion always produces chat models, so narrow the union to that arm.
export type PiChatModelConfig = Extract<
  ProviderModelConfig,
  { reasoning: boolean }
>;

export type PiThinkingLevelMap = NonNullable<
  PiChatModelConfig["thinkingLevelMap"]
>;

/** pi reasoning levels in ascending order. "off" is handled separately. */
const REASONING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** Effort name that asks the upstream to skip reasoning entirely. */
const NO_REASONING_EFFORT = "none";

/** Context window used when neither the proxy nor the catalog knows one. */
const DEFAULT_CONTEXT_WINDOW = 1048576;

/**
 * Minimal shape returned by AIS Switch's OpenAI-compatible `/v1/models`; in
 * practice it carries ids and routing metadata only, so the catalog supplies the
 * rest (see `CcSwitchModelProfile`).
 */
export interface CcSwitchProxyModel {
  id: string;
  name?: string;
  context_window?: number;
  max_context_window?: number;
  input_modalities?: string[];
  cc_switch?: {
    provider_name?: string;
  };
}

/** Model metadata per slug, as AIS Switch's model catalog records it. */
export type CcSwitchProfiles = ReadonlyMap<string, CcSwitchModelProfile>;

/**
 * The catalog slice pi can use. Catalog fields without a pi counterpart
 * (description, priority, `default_reasoning_level`, …) are not mapped.
 */
export interface CcSwitchModelProfile {
  /** Reasoning efforts the upstream advertises, in `cc_switch`'s spelling. */
  supportedEfforts: readonly string[];
  /** Input modalities the upstream accepts, in `cc_switch`'s spelling. */
  inputModalities: readonly string[];
  /** Context window in tokens; unset when the catalog records none. */
  contextWindow?: number;
}

/**
 * Index AIS Switch's model catalog (`~/.codex/ais-switch-model-catalog.json`) by
 * slug; slugs match the proxy's `/v1/models` ids. The catalog is external data,
 * so entries without a usable slug are dropped and malformed fields degrade to
 * "unknown" rather than failing the whole registration.
 */
export function catalogProfilesBySlug(
  catalog: unknown,
): Map<string, CcSwitchModelProfile> {
  const result = new Map<string, CcSwitchModelProfile>();
  const models = (catalog as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return result;

  for (const entry of models) {
    if (!entry || typeof entry !== "object") continue;
    const {
      slug,
      supported_reasoning_levels: levels,
      input_modalities: modalities,
      max_context_window: maxContextWindow,
      context_window: contextWindow,
    } = entry as {
      slug?: unknown;
      supported_reasoning_levels?: unknown;
      input_modalities?: unknown;
      max_context_window?: unknown;
      context_window?: unknown;
    };
    if (typeof slug !== "string" || !slug.trim()) continue;

    const supportedEfforts = Array.isArray(levels)
      ? levels
          .map((level) =>
            level && typeof level === "object"
              ? (level as { effort?: unknown }).effort
              : undefined,
          )
          .filter((effort): effort is string => typeof effort === "string")
          .map((effort) => effort.trim().toLowerCase())
          .filter((effort) => effort.length > 0)
      : [];
    const inputModalities = Array.isArray(modalities)
      ? modalities
          .filter(
            (modality): modality is string => typeof modality === "string",
          )
          .map((modality) => modality.trim().toLowerCase())
          .filter((modality) => modality.length > 0)
      : [];
    // Codex's context window is the maximum the upstream holds; the catalog
    // repeats it per model, so either field is authoritative.
    const window =
      positiveNumber(maxContextWindow) || positiveNumber(contextWindow);

    result.set(slug.trim(), {
      supportedEfforts,
      inputModalities,
      ...(window > 0 ? { contextWindow: window } : {}),
    });
  }
  return result;
}

/**
 * Map `cc_switch`'s reasoning levels onto pi thinking levels.
 *
 * Levels the catalog does not advertise become `null`, so pi never sends an
 * effort the upstream would reject; levels pi has no name for are ignored.
 * "off" becomes the upstream's explicit no-reasoning effort when there is one:
 * omitting the field would fall back to the gateway's own default (some use
 * "max"), which is not what "off" means.
 *
 * Returns `null` when the model has no reasoning level beyond "off".
 */
export function thinkingLevelMapFor(
  efforts: Iterable<string>,
): PiThinkingLevelMap | null {
  const supported = new Set(
    Array.from(efforts, (effort) => effort.trim().toLowerCase()),
  );

  const map: PiThinkingLevelMap = {
    off: supported.has(NO_REASONING_EFFORT) ? NO_REASONING_EFFORT : null,
  };
  let reasoning = false;
  for (const level of REASONING_LEVELS) {
    const mapped = supported.has(level) ? level : null;
    map[level] = mapped;
    reasoning = reasoning || mapped !== null;
  }

  return reasoning ? map : null;
}

/**
 * Convert the live AIS Switch model list into selectable pi models. Live proxy
 * metadata wins; `catalogProfiles` fills the gaps; models the catalog does not
 * know stay non-reasoning with the fallback context window instead of
 * advertising capabilities the upstream may reject.
 */
export function proxyModelsToPiModels(
  models: unknown[],
  catalogProfiles: CcSwitchProfiles = new Map(),
): PiChatModelConfig[] {
  const result: PiChatModelConfig[] = [];
  for (const entry of models) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Partial<CcSwitchProxyModel>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    if (!id) continue;

    const providerName =
      candidate.cc_switch &&
      typeof candidate.cc_switch === "object" &&
      typeof candidate.cc_switch.provider_name === "string"
        ? candidate.cc_switch.provider_name.trim()
        : "";
    const name =
      typeof candidate.name === "string" && candidate.name.trim()
        ? candidate.name
        : providerName
          ? `${providerName} · ${id}`
          : id;
    const profile = catalogProfiles.get(id);
    const modalities = Array.isArray(candidate.input_modalities)
      ? candidate.input_modalities
      : (profile?.inputModalities ?? []);
    const input: ("text" | "image")[] = modalities.includes("image")
      ? ["text", "image"]
      : ["text"];
    const thinkingLevelMap = thinkingLevelMapFor(
      profile?.supportedEfforts ?? [],
    );

    result.push({
      id,
      name,
      reasoning: thinkingLevelMap !== null,
      ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
      input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow:
        positiveNumber(candidate.max_context_window) ||
        positiveNumber(candidate.context_window) ||
        profile?.contextWindow ||
        DEFAULT_CONTEXT_WINDOW,
      maxTokens: 131072,
      compat: {
        supportsDeveloperRole: false,
        requiresAssistantAfterToolResult: false,
      },
    });
  }
  return result;
}

function positiveNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}
