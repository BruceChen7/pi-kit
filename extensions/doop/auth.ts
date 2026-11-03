/**
 * Shell + boundary: the one credential `/ws` and `/api/local-agent` accept is a
 * better-auth session cookie. This module gets it (email + password), parses it
 * once, and stores only the cookie — the password is never written.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DoopConfig } from "./config.js";

const COOKIE_NAME = "better-auth.session_token";
const KEYCHAIN_SERVICE = "pi-kit-doop";

export type AuthRecord = {
  email: string;
  /** `better-auth.session_token=<value>` — ready to use as a Cookie header */
  cookie: string;
  obtainedAt: number;
};

export type AuthError = {
  kind: "missing" | "invalid" | "login" | "unreachable";
  message: string;
};

export type AuthLoad =
  | { ok: true; record: AuthRecord; source: string }
  | { ok: false; error: AuthError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

export function defaultAuthPath(): string {
  return (
    process.env.DOOP_AUTH_PATH?.trim() ||
    path.join(os.homedir(), ".pi", "agent", "doop-auth.json")
  );
}

/**
 * `set-cookie` lines carry attributes after the value; the cookie header must
 * not. Takes the first session cookie it finds, which is what better-auth sets.
 */
export function parseSessionCookie(
  setCookies: readonly string[],
): string | undefined {
  for (const header of setCookies) {
    const pair = header.split(";")[0]?.trim();
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (name === COOKIE_NAME && value !== "") return `${name}=${value}`;
  }
  return undefined;
}

export function parseAuthRecord(
  raw: unknown,
  source: string,
): AuthRecord | AuthError {
  if (!isRecord(raw)) {
    return {
      kind: "invalid",
      message: `doop auth ${source}: expected a JSON object — run /doop login`,
    };
  }
  const email = nonEmpty(raw.email);
  const cookie = nonEmpty(raw.cookie);
  if (!email || !cookie) {
    return {
      kind: "invalid",
      message: `doop auth ${source}: ${email ? "cookie" : "email"} is missing — run /doop login`,
    };
  }
  if (!cookie.startsWith(`${COOKIE_NAME}=`)) {
    return {
      kind: "invalid",
      message: `doop auth ${source}: cookie is not a ${COOKIE_NAME} value — run /doop login`,
    };
  }
  const obtainedAt =
    typeof raw.obtainedAt === "number" && Number.isFinite(raw.obtainedAt)
      ? raw.obtainedAt
      : 0;
  return { email, cookie, obtainedAt };
}

export function authCookieHeader(record: AuthRecord): string {
  return record.cookie;
}

export function readAuthRecord(authPath: string): AuthLoad {
  let raw: string;
  try {
    raw = fs.readFileSync(authPath, "utf8");
  } catch {
    return {
      ok: false,
      error: {
        kind: "missing",
        message: `not signed in to doop — run /doop login (no ${authPath})`,
      },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error: {
        kind: "invalid",
        message: `doop auth ${authPath}: not valid JSON — run /doop login`,
      },
    };
  }
  const record = parseAuthRecord(parsed, authPath);
  if ("kind" in record) return { ok: false, error: record };
  return { ok: true, record, source: authPath };
}

/** 0600 like the config: this is a bearer credential. */
export function writeAuthRecord(authPath: string, record: AuthRecord): void {
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(
    authPath,
    `${JSON.stringify({ email: record.email, cookie: record.cookie, obtainedAt: record.obtainedAt }, null, 2)}\n`,
    { mode: 0o600 },
  );
  fs.chmodSync(authPath, 0o600);
}

export function clearAuthRecord(authPath: string): void {
  try {
    fs.rmSync(authPath);
  } catch {
    /* already gone: logout is idempotent */
  }
}

/**
 * Password sources, in order: the environment (scripted runs), the macOS
 * keychain (the user ran `security add-generic-password` once), and nothing.
 * The caller prompts only when this returns undefined.
 */
export function resolvePassword(
  email: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const fromEnv = nonEmpty(env.DOOP_PASSWORD);
  if (fromEnv) return fromEnv;
  try {
    const value = execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", email, "-w"],
      { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

export function resolveEmail(
  record: AuthRecord | undefined,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return nonEmpty(env.DOOP_EMAIL) ?? record?.email;
}

export type SignIn =
  | { ok: true; record: AuthRecord }
  | { ok: false; error: AuthError };

/** POST /api/auth/sign-in/email and keep the session cookie it sets. */
export async function signIn(
  config: DoopConfig,
  credentials: { email: string; password: string },
  options: { fetchImpl?: typeof fetch } = {},
): Promise<SignIn> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = `${config.baseUrl}/api/auth/sign-in/email`;
  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        /* better-auth refuses a sign-in without an Origin (MISSING_OR_NULL_
           ORIGIN); a browser sends it, so this client sends the instance's. */
        origin: config.baseUrl,
      },
      body: JSON.stringify({
        email: credentials.email,
        password: credentials.password,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: "unreachable",
        message: `doop is not reachable at ${config.baseUrl} (${error instanceof Error ? error.message : String(error)}). Start it with: cd ~/work/doop && bun run dev`,
      },
    };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      error: {
        kind: "login",
        message: `doop rejected those credentials (HTTP ${response.status}) — check the email and password`,
      },
    };
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      ok: false,
      error: {
        kind: "login",
        message: `doop answered HTTP ${response.status} for sign-in: ${text.slice(0, 200)}`,
      },
    };
  }
  const cookie = parseSessionCookie(response.headers.getSetCookie());
  if (!cookie) {
    return {
      ok: false,
      error: {
        kind: "login",
        message:
          "sign-in succeeded but the response carried no session cookie — is this the same doop the browser uses?",
      },
    };
  }
  return {
    ok: true,
    record: { email: credentials.email, cookie, obtainedAt: Date.now() },
  };
}
