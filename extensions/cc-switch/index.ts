/**
 * cc-switch — LLM provider integration for pi via AIS Switch.
 *
 * Imperative shell: loads the model catalog that cc_switch generates for
 * Codex (`~/.codex/ais-switch-model-catalog.json`), converts it with the
 * pure core (core.ts), and registers the models as a pi provider through
 * the cc_switch local proxy. Also exposes `/cc-switch` status and
 * `/cc-switch refresh` commands.
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
import { type CodexModelCatalog, catalogModelsToPiModels } from "./core.ts";

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

// ── Model catalog loading (IO) ─────────────────────────────────────────────

function loadModelCatalog(): CodexModelCatalog | null {
  try {
    if (!fs.existsSync(CODEX_CATALOG_PATH)) {
      log.info(`Model catalog not found at ${CODEX_CATALOG_PATH}`);
      return null;
    }
    const raw = fs.readFileSync(CODEX_CATALOG_PATH, "utf-8");
    const parsed: unknown = JSON.parse(raw);

    // IO boundary validation: only a well-formed container reaches the
    // core. Entry-level defects are handled defensively inside
    // catalogModelsToPiModels, which re-checks every field at runtime.
    const maybe = parsed as Partial<CodexModelCatalog> | null;
    if (!maybe || !Array.isArray(maybe.models)) {
      log.warn(
        `Model catalog at ${CODEX_CATALOG_PATH} has an unexpected shape`,
      );
      return null;
    }
    const catalog = maybe as CodexModelCatalog;
    if (catalog.models.length === 0) {
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

// ── Provider registration (side effect) ────────────────────────────────────

function registerGatewayProvider(
  pi: ExtensionAPI,
  catalog: CodexModelCatalog,
): boolean {
  const models = catalogModelsToPiModels(catalog.models);
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
  const skipped = catalog.models.length - models.length;
  if (skipped > 0) {
    log.warn(
      `Skipped ${skipped} invalid catalog entries; registered ${models.length} models`,
    );
  } else {
    log.info(
      `Registered provider "${PROVIDER_NAME}" with ${models.length} models`,
    );
  }
  return true;
}

// ── Commands ───────────────────────────────────────────────────────────────

function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand("cc-switch", {
    description:
      "Show cc_switch proxy/catalog status; use `refresh` to reload the model catalog",
    handler: async (args, ctx) => {
      const arg = args.trim();

      if (arg === "refresh") {
        const catalog = loadModelCatalog();
        if (!catalog) {
          ctx.ui.notify(
            "cc_switch catalog not found — check that cc_switch is running " +
              "and a provider with a Codex model catalog is configured",
            "error",
          );
          return;
        }
        const ok = registerGatewayProvider(pi, catalog);
        ctx.ui.notify(
          ok
            ? `Reloaded ${catalog.models.length} models from catalog`
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

      const catalog = loadModelCatalog();
      if (!catalog) {
        ctx.ui.notify(
          `cc_switch: proxy ${PROXY_BASE_URL} · catalog not loaded (${CODEX_CATALOG_PATH})`,
          "error",
        );
        return;
      }
      ctx.ui.notify(
        `cc_switch: proxy ${PROXY_BASE_URL} · provider ${PROVIDER_NAME} · ${catalog.models.length} models`,
        "info",
      );
    },
  });
}

// ── Extension entry point ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  // Register provider eagerly so models are available when pi resolves model
  // patterns from settings.json. After startup, `/cc-switch refresh`
  // re-registers without a restart.
  const catalog = loadModelCatalog();
  if (catalog) {
    registerGatewayProvider(pi, catalog);
  } else {
    log.warn(
      "No model catalog found — cc_switch provider not registered. " +
        "Check that cc_switch is configured with a provider that generates " +
        "a Codex model catalog.",
    );
  }
  registerCommands(pi);
}
