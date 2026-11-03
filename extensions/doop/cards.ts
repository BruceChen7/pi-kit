/**
 * Shell: the local-agent endpoints. These are how a canvas card reaches *this*
 * machine instead of a model key on the server, and how its result goes back.
 *
 * They authenticate with the browser session cookie, not the agent key: the
 * server answers them from `req.user`, and a run token (not the cookie) is what
 * the card's own MCP calls use.
 */

import type { AuthRecord } from "./auth.js";
import type { DoopConfig } from "./config.js";

/** The server only accepts a Claude-ish model id; it rides along as a label. */
export const PREFERENCE_MODEL = "sonnet";

export type CardJob = {
  id: string;
  token: string;
  prompt: string;
  system: string;
  maxTurns: number;
};

export type CardsError = { message: string };

export type CardsResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: CardsError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function parseJob(raw: unknown): CardJob | undefined {
  if (!isRecord(raw)) return undefined;
  const id = text(raw.id);
  const token = text(raw.token);
  const prompt = text(raw.prompt);
  if (!id || !token || !prompt) return undefined;
  return {
    id,
    token,
    prompt,
    system: text(raw.system) ?? "",
    maxTurns:
      typeof raw.maxTurns === "number" && Number.isFinite(raw.maxTurns)
        ? raw.maxTurns
        : 0,
  };
}

async function request(
  config: DoopConfig,
  auth: AuthRecord,
  pathName: string,
  init: { method: string; body?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  return fetchImpl(`${config.baseUrl}${pathName}`, {
    method: init.method,
    headers: {
      "content-type": "application/json",
      cookie: auth.cookie,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(15_000),
  });
}

function failure(status: number): CardsError {
  if (status === 401 || status === 403) {
    return {
      message: `doop session expired (HTTP ${status}) — run /doop login again`,
    };
  }
  return {
    message: `doop local-agent answered HTTP ${status} — /doop status to check the instance`,
  };
}

async function readJson(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export async function setCardsEnabled(
  config: DoopConfig,
  auth: AuthRecord,
  enabled: boolean,
  fetchImpl?: typeof fetch,
): Promise<CardsResult<{ enabled: boolean }>> {
  try {
    const response = await request(
      config,
      auth,
      "/api/local-agent",
      {
        method: "PUT",
        body: { enabled, model: PREFERENCE_MODEL },
      },
      fetchImpl,
    );
    if (!response.ok) return { ok: false, error: failure(response.status) };
    const body = await readJson(response);
    return {
      ok: true,
      value: {
        enabled: isRecord(body) && body.enabled === true,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        message: `doop is not reachable at ${config.baseUrl} (${error instanceof Error ? error.message : String(error)})`,
      },
    };
  }
}

export async function pollJob(
  config: DoopConfig,
  auth: AuthRecord,
  deviceId: string,
  fetchImpl?: typeof fetch,
): Promise<CardsResult<{ enabled: boolean; job?: CardJob }>> {
  try {
    const response = await request(
      config,
      auth,
      "/api/local-agent/poll",
      { method: "POST", body: { deviceId } },
      fetchImpl,
    );
    if (!response.ok) return { ok: false, error: failure(response.status) };
    const body = await readJson(response);
    if (!isRecord(body)) {
      return {
        ok: false,
        error: { message: "doop local-agent poll returned no body" },
      };
    }
    const job = parseJob(body.job);
    return {
      ok: true,
      value: {
        enabled: body.enabled === true,
        ...(job ? { job } : {}),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        message: `doop is not reachable at ${config.baseUrl} (${error instanceof Error ? error.message : String(error)})`,
      },
    };
  }
}

export async function finishJob(
  config: DoopConfig,
  auth: AuthRecord,
  deviceId: string,
  jobId: string,
  result: { success: boolean; text: string },
  fetchImpl?: typeof fetch,
): Promise<CardsResult<{ finished: boolean }>> {
  try {
    const response = await request(
      config,
      auth,
      `/api/local-agent/finish/${encodeURIComponent(jobId)}`,
      { method: "POST", body: { deviceId, ...result } },
      fetchImpl,
    );
    /* 409 = another device already finished this run; not an error for us */
    if (response.status === 409)
      return { ok: true, value: { finished: false } };
    if (!response.ok) return { ok: false, error: failure(response.status) };
    return { ok: true, value: { finished: true } };
  } catch (error) {
    return {
      ok: false,
      error: {
        message: `doop is not reachable at ${config.baseUrl} (${error instanceof Error ? error.message : String(error)})`,
      },
    };
  }
}
