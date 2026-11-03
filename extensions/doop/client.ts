/**
 * Shell: one MCP `tools/call` over HTTP, plus the classification of what went
 * wrong. Every failure carries the next action, because the four causes look
 * identical from the model's side.
 */

import type { DoopConfig } from "./config.js";
import { type DoopComment, parseComments } from "./worklist.js";

export type DoopError = {
  kind: "auth" | "unavailable" | "protocol" | "canvas";
  message: string;
};

export type CallResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: DoopError };

export type ClientOptions = {
  fetchImpl?: typeof fetch;
  /** tests pass 0 to keep a retry from costing wall time */
  retryDelayMs?: number;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_DELAY_MS = 250;

let requestId = 0;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function fail(
  kind: DoopError["kind"],
  message: string,
): { ok: false; error: DoopError } {
  return { ok: false, error: { kind, message } };
}

function authMessage(config: DoopConfig, status: number): DoopError {
  return {
    kind: "auth",
    message: `doop rejected the agent key (${status}) at ${config.baseUrl}. Mint a new one: doop -> Settings -> Agent keys, then update ~/.pi/agent/doop.json (or DOOP_AGENT_KEY).`,
  };
}

function transportMessage(config: DoopConfig, detail: string): DoopError {
  return {
    kind: "unavailable",
    message: `doop is not reachable at ${config.baseUrl}/mcp (${detail}). Start it with: cd ~/work/doop && bun run dev`,
  };
}

type RawCall = { ok: true; payload: unknown } | { ok: false; error: DoopError };

async function post(
  config: DoopConfig,
  body: string,
  options: Required<Pick<ClientOptions, "timeoutMs">> &
    Pick<ClientOptions, "fetchImpl">,
): Promise<{ status: number; text: string }> {
  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(`${config.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${config.agentKey}`,
    },
    body,
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  return { status: response.status, text: await response.text() };
}

/**
 * One call, retried once on transport failure and 5xx. The doop server is
 * stateless per request, so a retry cannot duplicate a write.
 */
export async function callTool(
  config: DoopConfig,
  name: string,
  args: Record<string, unknown>,
  options: ClientOptions = {},
): Promise<RawCall> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  requestId += 1;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: requestId,
    method: "tools/call",
    params: { name, arguments: args },
  });

  let lastDetail = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: { status: number; text: string };
    try {
      response = await post(config, body, {
        timeoutMs,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error);
      if (attempt === 0) await sleep(retryDelayMs);
      continue;
    }
    const { status, text } = response;
    if (status === 401 || status === 403) {
      return { ok: false, error: authMessage(config, status) };
    }
    if (status >= 500) {
      lastDetail = `HTTP ${status}`;
      if (attempt === 0) await sleep(retryDelayMs);
      continue;
    }
    if (status < 200 || status >= 300) {
      return fail(
        "protocol",
        `doop answered HTTP ${status}: ${text.slice(0, 200)}`,
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return fail(
        "protocol",
        `doop answered with non-JSON: ${text.slice(0, 200)}`,
      );
    }
    return unwrap(payload, config);
  }
  return { ok: false, error: transportMessage(config, lastDetail) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrap(payload: unknown, config: DoopConfig): RawCall {
  if (!isRecord(payload)) {
    return fail("protocol", "doop answered with a non-object JSON-RPC payload");
  }
  if (payload.error !== undefined && payload.error !== null) {
    const message = isRecord(payload.error) ? payload.error.message : undefined;
    const detail =
      typeof message === "string" ? message : "unknown JSON-RPC error";
    if (/unauthori[sz]ed|oauth|token/i.test(detail)) {
      return { ok: false, error: authMessage(config, 401) };
    }
    return fail("protocol", `doop tool error: ${detail}`);
  }
  const result = payload.result;
  if (!isRecord(result)) {
    return fail("protocol", "doop answered without a result");
  }
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0) {
    return fail("protocol", "doop answered without content");
  }
  const text = isRecord(content[0]) ? content[0].text : undefined;
  if (typeof text !== "string") {
    return fail("protocol", "doop content block had no text");
  }
  /* doop answers an inaccessible canvas with isError plus a prose message, and
     the MCP client keeps that shape. It is a canvas problem, not a protocol one. */
  if (result.isError === true) {
    return {
      ok: false,
      error: { kind: "canvas", message: text.replace(/^Error: /, "") },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("protocol", `doop content was not JSON: ${text.slice(0, 200)}`);
  }
  return { ok: true, payload: parsed };
}

/**
 * The comments of one canvas, already past the boundary. A canvas the agent
 * cannot see comes back as a plain string from doop instead of an array; that
 * is the `canvas` error, not a protocol failure.
 */
export async function getComments(
  config: DoopConfig,
  canvasId: string,
  options: ClientOptions = {},
): Promise<CallResult<DoopComment[]>> {
  const call = await callTool(
    config,
    "get_comments",
    {
      canvas_id: canvasId,
      include_resolved: false,
      agent_name: config.agentName,
    },
    options,
  );
  if (!call.ok) return call;
  if (typeof call.payload === "string") {
    return fail("canvas", call.payload);
  }
  const parsed = parseComments(call.payload);
  if (!parsed.ok) return fail("protocol", parsed.detail);
  return { ok: true, value: parsed.comments };
}
