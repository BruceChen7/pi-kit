/**
 * opencode-go Provider Extension
 *
 * Registers opencode-go as a custom provider using the openai-completions API.
 * Base URL: https://opencode.ai/zen/go/v1
 *
 * Model resolution strategy: Stale-While-Revalidate
 *   1. Serve stale immediately: disk cache → embedded models.json (zero-latency)
 *   2. Revalidate in background: live API /models → merge with embedded → cache → hot-swap
 *   3. patch.json + custom-models.json applied on top of whichever source won
 *
 * Merge order: [live|cache|embedded] → apply patch.json → merge custom-models.json
 *
 * Usage:
 *   # Set your API key
 *   export OPENCODE_API_KEY=your-api-key
 *
 *   # Run pi with the extension
 *   pi -e ./extensions/opencode-go-provider
 *
 * Then use /model to select from available models
 *
 * Upstream: https://github.com/monotykamary/pi-opencode-go-provider
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import customModelsData from "./custom-models.json" with { type: "json" };
import modelsData from "./models.json" with { type: "json" };
import patchData from "./patch.json" with { type: "json" };

// ─── Types ────────────────────────────────────────────────────────────────

interface JsonModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  compat?: {
    supportsDeveloperRole?: boolean;
    supportsStore?: boolean;
    maxTokensField?: "max_completion_tokens" | "max_tokens";
    thinkingFormat?: "openai" | "zai" | "qwen" | "qwen-chat-template";
    supportsReasoningEffort?: boolean;
  };
}

interface PatchEntry {
  name?: string;
  reasoning?: boolean;
  input?: string[];
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;
}

type PatchData = Record<string, PatchEntry>;

// ─── Patch Application ────────────────────────────────────────────────────

function applyPatch(model: JsonModel, patch: PatchEntry): JsonModel {
  const result = { ...model };

  if (patch.name !== undefined) result.name = patch.name;
  if (patch.reasoning !== undefined) result.reasoning = patch.reasoning;
  if (patch.input !== undefined) result.input = patch.input;
  if (patch.contextWindow !== undefined)
    result.contextWindow = patch.contextWindow;
  if (patch.maxTokens !== undefined) result.maxTokens = patch.maxTokens;

  if (patch.cost) {
    result.cost = {
      input: patch.cost.input ?? result.cost.input,
      output: patch.cost.output ?? result.cost.output,
      cacheRead: patch.cost.cacheRead ?? result.cost.cacheRead,
      cacheWrite: patch.cost.cacheWrite ?? result.cost.cacheWrite,
    };
  }
  if (patch.compat) {
    result.compat = { ...(result.compat || {}), ...patch.compat };
  }

  if (!result.reasoning && result.compat?.thinkingFormat) {
    delete result.compat.thinkingFormat;
  }
  if (result.compat && Object.keys(result.compat).length === 0) {
    delete result.compat;
  }

  return result;
}

/** Full pipeline: base models → patch → custom → result */
function buildModels(
  base: JsonModel[],
  custom: JsonModel[],
  patch: PatchData,
): JsonModel[] {
  const modelMap = new Map<string, JsonModel>();

  for (const model of base) {
    modelMap.set(model.id, model);
  }

  for (const [id, patchEntry] of Object.entries(patch)) {
    const existing = modelMap.get(id);
    if (existing) {
      modelMap.set(id, applyPatch(existing, patchEntry));
    }
  }

  for (const model of custom) {
    const patchEntry = patch[model.id];
    modelMap.set(model.id, patchEntry ? applyPatch(model, patchEntry) : model);
  }

  const result = Array.from(modelMap.values());
  for (const model of result) {
    if (model.reasoning) {
      model.compat ??= {};
      if (model.compat.supportsReasoningEffort === undefined) {
        model.compat.supportsReasoningEffort = true;
      }
    }
  }
  return result;
}

// ─── Stale-While-Revalidate Model Sync ────────────────────────────────────

const PROVIDER_ID = "opencode-go";
const BASE_URL = "https://opencode.ai/zen/go/v1";
const MODELS_URL = "https://models.dev/api.json";
const CACHE_DIR = path.join(os.homedir(), ".pi", "agent", "cache");
const CACHE_PATH = path.join(CACHE_DIR, `${PROVIDER_ID}-models.json`);
const LIVE_FETCH_TIMEOUT_MS = 8000;

/** A model object from the models.dev API. */
interface ModelsDevModel {
  id: string;
  name: string;
  reasoning?: boolean;
  modalities?: { input?: string[] };
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
  limit?: {
    context?: number;
    output?: number;
  };
  status?: string;
}

/** Transform a model from models.dev into the Pi-native format. */
function transformApiModel(apiModel: ModelsDevModel): JsonModel {
  const inputTypes = apiModel.modalities?.input || ["text"];
  const cost = apiModel.cost || {};
  const limit = apiModel.limit || {};
  return {
    id: apiModel.id,
    name: apiModel.name || apiModel.id,
    reasoning: apiModel.reasoning || false,
    input: inputTypes,
    cost: {
      input: cost.input || 0,
      output: cost.output || 0,
      cacheRead: cost.cache_read || 0,
      cacheWrite: cost.cache_write || 0,
    },
    contextWindow: limit.context || 0,
    maxTokens: limit.output || 0,
  };
}

async function fetchLiveModels(
  _apiKey: string,
  signal?: AbortSignal,
): Promise<JsonModel[] | null> {
  try {
    const timeout = AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS);
    const combinedSignal = signal
      ? AbortSignal.any([timeout, signal])
      : timeout;
    const response = await fetch(MODELS_URL, {
      signal: combinedSignal,
    });
    if (!response.ok) return null;
    const data = await response.json();
    const provider = data[PROVIDER_ID];
    if (!provider?.models) return null;
    const apiModels = (
      Object.values(provider.models) as ModelsDevModel[]
    ).filter((m) => m.status !== "deprecated");
    if (apiModels.length === 0) return null;
    return apiModels.map(transformApiModel);
  } catch {
    return null;
  }
}

function loadCachedModels(): JsonModel[] | null {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function cacheModels(models: JsonModel[]): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, `${JSON.stringify(models, null, 2)}\n`);
  } catch {
    // Cache write failure is non-fatal
  }
}

function mergeWithEmbedded(
  liveModels: JsonModel[],
  embeddedModels: JsonModel[],
): JsonModel[] {
  const embeddedMap = new Map(embeddedModels.map((m) => [m.id, m]));
  const result: JsonModel[] = [];
  for (const liveModel of liveModels) {
    const embedded = embeddedMap.get(liveModel.id);
    if (embedded) {
      result.push({
        ...liveModel,
        ...embedded,
      });
    } else {
      result.push(liveModel);
    }
  }
  return appendMissingById(result, embeddedModels);
}

/**
 * Pure helper: append items from `supplement` whose `id` is not already in `primary`.
 * Returns a new array; does not mutate either input.
 */
function appendMissingById(
  primary: JsonModel[],
  supplement: JsonModel[],
): JsonModel[] {
  const known = new Set(primary.map((m) => m.id));
  return [...primary, ...supplement.filter((m) => !known.has(m.id))];
}

function loadStaleModels(embeddedModels: JsonModel[]): JsonModel[] {
  const cached = loadCachedModels();
  if (!cached || cached.length === 0) return embeddedModels;
  return appendMissingById(cached, embeddedModels);
}

async function revalidateModels(
  _apiKey: string | undefined,
  embeddedModels: JsonModel[],
  signal?: AbortSignal,
): Promise<JsonModel[] | null> {
  const liveModels = await fetchLiveModels("", signal);
  if (!liveModels || liveModels.length === 0) return null;
  const merged = mergeWithEmbedded(liveModels, embeddedModels);
  cacheModels(merged);
  return merged;
}

// ─── Background Revalidation ──────────────────────────────────────────────

let revalidateAbort: AbortController | null = null;

// ─── Extension Entry Point ────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const embeddedModels = modelsData as JsonModel[];
  const customModels = customModelsData as JsonModel[];
  const patches = patchData as PatchData;

  const staleBase = loadStaleModels(embeddedModels);
  const staleModels = buildModels(staleBase, customModels, patches);

  pi.registerProvider("opencode-go", {
    baseUrl: BASE_URL,
    apiKey: "$OPENCODE_API_KEY",
    api: "openai-completions",
    models: staleModels as ProviderModelConfig[],
  });

  pi.on("session_start", async (_event, _ctx) => {
    revalidateAbort?.abort();
    revalidateAbort = new AbortController();
    const signal = revalidateAbort.signal;
    revalidateModels(undefined, embeddedModels, signal).then((freshBase) => {
      if (freshBase && !signal.aborted) {
        pi.registerProvider("opencode-go", {
          baseUrl: BASE_URL,
          apiKey: "$OPENCODE_API_KEY",
          api: "openai-completions",
          models: buildModels(
            freshBase,
            customModels,
            patches,
          ) as ProviderModelConfig[],
        });
      }
    });
  });

  pi.on("session_shutdown", () => {
    revalidateAbort?.abort();
  });
}
