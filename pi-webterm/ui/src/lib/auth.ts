// ─── Auth Token Management ─────────────────────────────────────

const TOKEN_KEY = "pi-webterm-token";

export function getSessionToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setSessionToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearSessionToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export function hasSessionToken(): boolean {
  return !!getSessionToken();
}

// ─── URL Helpers ───────────────────────────────────────────────

/** Normalize a WS URL to an HTTP URL for REST API calls. */
function toHttpUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws:\/\//, "http://").replace(/\/ws$/, "");
}

// ─── Login API ─────────────────────────────────────────────────

export interface LoginResult {
  token: string;
  expiresIn: number;
}

export async function login(
  baseUrl: string,
  username: string,
  password: string,
): Promise<LoginResult> {
  const apiUrl = toHttpUrl(baseUrl);
  const res = await fetch(`${apiUrl}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Login failed" }));
    throw new Error(body.error || "Login failed");
  }

  return res.json();
}

export async function logout(baseUrl: string): Promise<void> {
  const token = getSessionToken();
  if (!token) return;

  const apiUrl = toHttpUrl(baseUrl);
  try {
    await fetch(`${apiUrl}/api/logout`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
    });
  } finally {
    clearSessionToken();
  }
}
