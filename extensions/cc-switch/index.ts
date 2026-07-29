/**
 * cc-switch — LLM provider integration for pi via AIS Switch.
 *
 * Reads the model catalog that cc_switch generates for Codex
 * (`~/.codex/ais-switch-model-catalog.json`) and registers the
 * models as a pi provider through the cc_switch local proxy.
 *
 * Prerequisites:
 *   - AIS Switch (cc_switch) desktop app running with local proxy enabled
 *   - A provider configured in cc_switch with model catalog generated
 */

import fs from "node:fs";
import path from "node:path";
import type {
  ExtensionAPI,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("cc-switch");

// ── Constants ──────────────────────────────────────────────────────────────

const PROXY_HOST = "127.0.0.1";
const PROXY_PORT = 15721;
const PROXY_BASE_URL = `http://${PROXY_HOST}:${PROXY_PORT}`;

// When cc_switch manages authentication (e.g. OAuth, SSO), the live config
// contains a sentinel value that the local proxy intercepts and replaces
// with the real credential.  The sentinel name varies by deployment; this
// default works for common cc_switch setups.
const API_KEY = "PROXY_MANAGED";
const API_TYPE: ProviderConfig["api"] = "openai-responses";

const CODEX_CATALOG_PATH = path.join(
  process.env.HOME || "",
  ".codex",
  "ais-switch-model-catalog.json",
);

const PROVIDER_NAME = "cc-switch-gateway";

// ── Types ──────────────────────────────────────────────────────────────────

interface CodexModel {
  slug: string;
  display_name: string;
  description: string;
  context_window: number;
  max_context_window: number;
  input_modalities: string[];
  default_reasoning_level: string;
  supported_reasoning_levels: Array<{ effort: string; description: string }>;
  priority?: number;
}

interface CodexModelCatalog {
  models: CodexModel[];
}

// ── Model catalog loading ──────────────────────────────────────────────────

function loadModelCatalog(): CodexModelCatalog | null {
  try {
    if (!fs.existsSync(CODEX_CATALOG_PATH)) {
      log.info(`Model catalog not found at ${CODEX_CATALOG_PATH}`);
      return null;
    }
    const raw = fs.readFileSync(CODEX_CATALOG_PATH, "utf-8");
    const catalog: CodexModelCatalog = JSON.parse(raw);
    if (!catalog.models || catalog.models.length === 0) {
      log.warn("Model catalog is empty");
      return null;
    }
    log.info(`Loaded ${catalog.models.length} models from catalog`);
    return catalog;
  } catch (err) {
    log.error(`Failed to load model catalog: ${err}`);
    return null;
  }
}

// ── Model conversion ───────────────────────────────────────────────────────

function catalogModelsToPiModels(
  models: CodexModel[],
): ProviderConfig["models"] {
  return models.map((m) => {
    const input: ("text" | "image")[] = m.input_modalities.includes("image")
      ? ["text", "image"]
      : ["text"];

    const thinkingLevelMap: Record<string, string | null> = {};
    for (const rl of m.supported_reasoning_levels) {
      const level = rl.effort as "low" | "medium" | "high" | "xhigh" | "max";
      thinkingLevelMap[level] = level;
    }

    return {
      id: m.slug,
      name: m.display_name,
      reasoning: true,
      input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.max_context_window || m.context_window || 1048576,
      maxTokens: 131072,
      compat: {
        supportsDeveloperRole: false,
        requiresAssistantAfterToolResult: false,
      },
    };
  });
}

// ── Provider registration ──────────────────────────────────────────────────

function registerGatewayProvider(
  pi: ExtensionAPI,
  catalog: CodexModelCatalog,
): void {
  const models = catalogModelsToPiModels(catalog.models);

  pi.registerProvider(PROVIDER_NAME, {
    name: "cc_switch Proxy",
    baseUrl: PROXY_BASE_URL,
    apiKey: API_KEY,
    api: API_TYPE,
    authHeader: true,
    models,
  });

  log.info(
    `Registered provider "${PROVIDER_NAME}" with ${models.length} models`,
  );
}

// ── Extension entry point ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  // Register provider eagerly so models are available when pi resolves model
  // patterns from settings.json.
  const catalog = loadModelCatalog();
  if (catalog) {
    registerGatewayProvider(pi, catalog);
    log.info(`Registered ${catalog.models.length} models from catalog`);
  } else {
    log.warn(
      "No model catalog found — cc_switch provider not registered. " +
        "Check that cc_switch is configured with a provider that generates " +
        "a Codex model catalog.",
    );
  }
}
