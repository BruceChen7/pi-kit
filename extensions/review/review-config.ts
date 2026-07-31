/**
 * Review extension configuration.
 *
 * Resolves which model runs the review turn ("审模型"):
 * - priority: `/review --model <id>` (single-invocation override)
 *           > `third_extensions.review.model` (config; project overrides global)
 *           > DEFAULT_REVIEW_MODEL (default-enabled)
 * - config value "off" disables the feature (review behaves exactly as before).
 *
 * Decision logic lives in `resolveReviewModel` (pure, value in / value out);
 * `getReviewModel` is a thin shell that reads the settings file, converts it
 * to the config DTO, and delegates to the pure function. Shell side
 * (review.ts) performs the actual model switch via `pi.setModel`.
 */

import { loadSettings } from "../shared/settings.ts";

export const DEFAULT_REVIEW_MODEL = "cc-switch-gateway/llm-gateway--kimi-k3";
export const REVIEW_MODEL_OFF = "off";

/** Boundary DTO — the review config slice the decision logic needs. */
export type ReviewModelConfig = { model?: string };

/**
 * Pure decision: resolve the review model id, or `undefined` when the feature
 * is disabled.
 *
 * - `argsModel` (from `/review --model <id>`) wins over config for one call.
 * - Config missing/empty → DEFAULT_REVIEW_MODEL (feature is default-on).
 * - Config value "off" → disabled (current behavior).
 */
export function resolveReviewModel(
  config: ReviewModelConfig | undefined,
  argsModel?: string,
): string | undefined {
  if (argsModel?.trim()) {
    return argsModel.trim();
  }

  const configured = config?.model;

  if (configured === undefined || configured.trim() === "") {
    return DEFAULT_REVIEW_MODEL;
  }
  if (configured.trim() === REVIEW_MODEL_OFF) {
    return undefined;
  }
  return configured.trim();
}

/**
 * Thin shell: read merged settings (global + project) and delegate to the
 * pure decision function.
 */
export function getReviewModel(
  cwd: string,
  argsModel?: string,
): string | undefined {
  const settings = loadSettings(cwd).merged as {
    third_extensions?: { review?: ReviewModelConfig };
  };
  return resolveReviewModel(settings.third_extensions?.review, argsModel);
}

/**
 * Split a "provider/modelId" string on the first "/".
 * Returns null for empty input or when there is no "/" (or it is malformed).
 */
export function parseModelId(
  s: string,
): { provider: string; id: string } | null {
  if (!s) return null;
  const idx = s.indexOf("/");
  if (idx <= 0 || idx === s.length - 1) return null;
  return { provider: s.slice(0, idx), id: s.slice(idx + 1) };
}

/**
 * Strip a leading "--model <id>" from /review command args.
 * Only the prefix form is supported; returns the remaining args unchanged
 * when there is no override.
 */
export function extractModelOverride(args: string | undefined): {
  model: string | undefined;
  rest: string;
} {
  if (!args?.trim()) return { model: undefined, rest: args ?? "" };
  const match = args.trim().match(/^--model\s+(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return { model: undefined, rest: args };
  return { model: match[1], rest: match[2] ?? "" };
}
