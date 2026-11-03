/**
 * Config is parsed once at the boundary (the JSON file and the environment),
 * so everything inside the extension can trust `DoopConfig`.
 */

export type DoopConfig = {
  baseUrl: string;
  agentKey: string;
  /** the canvas `/doop review` and `doop_comments` default to */
  canvasId?: string;
  /** the identity this session designs under; also what `toWorklist` treats as "my own comment" */
  agentName: string;
  /** subscribe to the canvas WebSocket on session start */
  watch: boolean;
  /** take resident cards from /api/local-agent while this session is open */
  cards: boolean;
};

export type ConfigError = {
  kind: "invalid";
  /** where the value came from: file path or "environment" */
  source: string;
  field: string;
  detail: string;
};

export const DEFAULT_BASE_URL = "http://localhost:4300";
export const DEFAULT_AGENT_NAME = "pi";

type Env = Record<string, string | undefined>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Empty strings count as absent: an env var set to "" should fall back, not win. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function dropTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * `unknown` in, `DoopConfig` out. A missing `agentKey` is the one error worth
 * its own message: without it every call fails with a 401 that says nothing
 * about the file the user needs to edit.
 */
export function parseDoopConfig(
  raw: unknown,
  source: string,
): DoopConfig | ConfigError {
  if (!isRecord(raw)) {
    return {
      kind: "invalid",
      source,
      field: "root",
      detail: "expected a JSON object",
    };
  }
  const agentKey = nonEmptyString(raw.agentKey);
  if (!agentKey) {
    return {
      kind: "invalid",
      source,
      field: "agentKey",
      detail:
        'missing or empty; mint one in doop under Settings -> Agent keys ("dpk_...")',
    };
  }
  const baseUrl = nonEmptyString(raw.baseUrl) ?? DEFAULT_BASE_URL;
  if (!URL.canParse(baseUrl)) {
    return {
      kind: "invalid",
      source,
      field: "baseUrl",
      detail: `not a URL: ${baseUrl}`,
    };
  }
  const canvasId = nonEmptyString(raw.canvasId);
  const agentName = nonEmptyString(raw.agentName) ?? DEFAULT_AGENT_NAME;
  return {
    baseUrl: dropTrailingSlashes(baseUrl),
    agentKey,
    canvasId,
    agentName,
    /* opt-in only: upgrading must not start a socket or spend model quota */
    watch: raw.watch === true,
    cards: raw.cards === true,
  };
}

/**
 * Environment overrides exist for tests and for one-off runs against another
 * instance. They never invent an `agentKey` that the file lacks — that stays
 * the file's job, except where the env supplies it wholesale.
 */
export function applyEnvOverrides(
  config: DoopConfig,
  env: Env = process.env,
): DoopConfig {
  const baseUrl = nonEmptyString(env.DOOP_BASE_URL);
  const agentKey = nonEmptyString(env.DOOP_AGENT_KEY);
  const canvasId = nonEmptyString(env.DOOP_CANVAS_ID);
  const agentName = nonEmptyString(env.DOOP_AGENT_NAME);
  return {
    ...config,
    ...(baseUrl ? { baseUrl: dropTrailingSlashes(baseUrl) } : {}),
    ...(agentKey ? { agentKey } : {}),
    ...(canvasId ? { canvasId } : {}),
    ...(agentName ? { agentName } : {}),
  };
}

/** A config the env alone can satisfy, for `DOOP_AGENT_KEY=... pi -p ...` runs. */
export function configFromEnv(
  env: Env = process.env,
): DoopConfig | ConfigError {
  return parseDoopConfig(
    {
      baseUrl: env.DOOP_BASE_URL,
      agentKey: env.DOOP_AGENT_KEY,
      canvasId: env.DOOP_CANVAS_ID,
      agentName: env.DOOP_AGENT_NAME,
      watch: env.DOOP_WATCH === "1" || env.DOOP_WATCH === "true",
      cards: env.DOOP_CARDS === "1" || env.DOOP_CARDS === "true",
    },
    "environment",
  );
}

export function isConfigError(
  value: DoopConfig | ConfigError,
): value is ConfigError {
  return "kind" in value;
}

export function configErrorText(error: ConfigError): string {
  return `doop config ${error.source}: ${error.field} ${error.detail}`;
}

/** Round-trip helper for `/doop bind`: same shape the file holds. */
export function withCanvasId(
  config: DoopConfig,
  canvasId?: string,
): DoopConfig {
  return canvasId
    ? { ...config, canvasId }
    : { ...config, canvasId: undefined };
}
