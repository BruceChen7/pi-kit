/**
 * cc-switch — LLM provider integration for pi via AIS Switch.
 *
 * Shell half of `core.ts`: fetches `/v1/models` and the model catalog, registers
 * the models as a pi provider through the local proxy, and exposes `/cc-switch`.
 *
 * Prerequisites:
 *   - AIS Switch (cc_switch) desktop app running with local proxy enabled
 *   - A provider configured in cc_switch
 *   - For thinking levels: cc_switch's Codex model catalog
 *     (`~/.codex/ais-switch-model-catalog.json`)
 */

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { createLogger } from "../shared/logger.ts";
import {
  type CcSwitchProfiles,
  catalogProfilesBySlug,
  type PiChatModelConfig,
  proxyModelsToPiModels,
} from "./core.ts";

const log = createLogger("cc-switch");

// ── Constants ──────────────────────────────────────────────────────────────

const PROXY_HOST = "127.0.0.1";
const PROXY_PORT = 15721;
const PROXY_BASE_URL = `http://${PROXY_HOST}:${PROXY_PORT}`;
const PROXY_MODELS_URL = `${PROXY_BASE_URL}/v1/models`;
const PROXY_FETCH_TIMEOUT_MS = 3000;

// AIS Switch serves Codex a model catalog that records each model's reasoning
// levels, context window and input modalities. pi reads the same data so the
// registered models describe what the upstream actually accepts.
const CATALOG_RELATIVE_PATH = path.join(
  ".codex",
  "ais-switch-model-catalog.json",
);

// When cc_switch manages authentication (e.g. OAuth, SSO), the live config
// contains a sentinel value that the local proxy intercepts and replaces
// with the real credential.  The sentinel name varies by deployment; this
// default works for common cc_switch setups.
const API_KEY = "PROXY_MANAGED";
const API_TYPE: ProviderConfig["api"] = "openai-responses";

const PROVIDER_NAME = "cc-switch-gateway";

/**
 * Resolve the catalog path per call so it follows the current home directory.
 */
function modelCatalogPath(): string {
  return path.join(os.homedir(), CATALOG_RELATIVE_PATH);
}

async function loadCatalogProfiles(): Promise<CcSwitchProfiles> {
  const catalogPath = modelCatalogPath();
  try {
    const raw = await readFile(catalogPath, "utf8");
    const profiles = catalogProfilesBySlug(JSON.parse(raw));
    log.info(`Loaded catalog metadata for ${profiles.size} models`);
    return profiles;
  } catch (err) {
    log.warn(`No catalog metadata from ${catalogPath}: ${err}`);
    return new Map();
  }
}

async function loadProviderModels(): Promise<PiChatModelConfig[] | null> {
  try {
    const response = await fetch(PROXY_MODELS_URL, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(PROXY_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      log.warn(
        `AIS Switch model endpoint returned HTTP ${response.status} at ${PROXY_MODELS_URL}`,
      );
      return null;
    }

    const parsed: unknown = await response.json();
    const maybe = parsed as { data?: unknown } | null;
    if (!maybe || !Array.isArray(maybe.data)) {
      log.warn("AIS Switch model endpoint returned an unexpected shape");
      return null;
    }

    const models = proxyModelsToPiModels(
      maybe.data,
      await loadCatalogProfiles(),
    );
    if (models.length === 0) {
      log.warn("AIS Switch model endpoint returned no usable models");
      return null;
    }
    log.info(
      `Loaded ${models.length} models from AIS Switch proxy ` +
        `(${models.filter((model) => model.reasoning).length} with thinking levels)`,
    );
    return models;
  } catch (err) {
    log.warn(`Failed to load models from AIS Switch proxy: ${err}`);
    return null;
  }
}

// ── Provider registration (side effect) ────────────────────────────────────

function registerGatewayProvider(
  pi: ExtensionAPI,
  models: PiChatModelConfig[],
): boolean {
  try {
    pi.registerProvider(PROVIDER_NAME, {
      name: "cc_switch Proxy",
      baseUrl: PROXY_BASE_URL,
      apiKey: API_KEY,
      api: API_TYPE,
      authHeader: true,
      models,
    });
  } catch (err) {
    log.error(`Failed to register provider "${PROVIDER_NAME}": ${err}`);
    return false;
  }
  log.info(
    `Registered provider "${PROVIDER_NAME}" with ${models.length} models`,
  );
  return true;
}

// ── Commands ───────────────────────────────────────────────────────────────

function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand("cc-switch", {
    description:
      "Show cc_switch proxy/model status; use `refresh` to reload models",
    handler: async (args, ctx) => {
      const arg = args.trim();

      if (arg === "refresh") {
        const models = await loadProviderModels();
        if (!models) {
          ctx.ui.notify(
            "cc_switch models not found — check that the local proxy is running",
            "error",
          );
          return;
        }
        const ok = registerGatewayProvider(pi, models);
        ctx.ui.notify(
          ok
            ? `Reloaded ${models.length} models from cc_switch`
            : "Failed to reload models — see extension logs",
          ok ? "info" : "error",
        );
        return;
      }

      if (arg !== "") {
        ctx.ui.notify(
          `Unknown cc-switch subcommand "${arg}" — use \`/cc-switch\` or \`/cc-switch refresh\``,
          "error",
        );
        return;
      }

      const models = await loadProviderModels();
      if (!models) {
        ctx.ui.notify(
          `cc_switch: proxy ${PROXY_BASE_URL} · models not loaded`,
          "error",
        );
        return;
      }
      const withThinking = models.filter((model) => model.reasoning).length;
      ctx.ui.notify(
        `cc_switch: proxy ${PROXY_BASE_URL} · provider ${PROVIDER_NAME} · ` +
          `${models.length} models (${withThinking} with thinking levels)`,
        "info",
      );
    },
  });
}

// ── Extension entry point ──────────────────────────────────────────────────

export default async function (pi: ExtensionAPI): Promise<void> {
  // Register provider eagerly so models are available when pi resolves model
  // patterns from settings.json. The factory is async because model discovery
  // comes from the live proxy endpoint.
  const models = await loadProviderModels();
  if (models) {
    registerGatewayProvider(pi, models);
  } else {
    log.warn(
      "No cc_switch models found — provider not registered. " +
        "Check that cc_switch is running with its local proxy enabled.",
    );
  }
  registerCommands(pi);
}
