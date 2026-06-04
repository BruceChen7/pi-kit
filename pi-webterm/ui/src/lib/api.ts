// ─── REST API Client for Session Management ────────────────────

export interface SessionInfo {
  name: string;
  dirname: string;
  branch: string;
  hash?: string; // short cwd hash (v2 sessions only)
  status: "running" | "stopped" | "crashed" | "starting";
  attached: boolean;
}

export interface LoginResult {
  token: string;
  expiresIn: number;
  sessions: SessionInfo[];
}

export interface CreateSessionResult {
  name: string;
  dirname: string;
  branch: string;
  cwd: string;
  status: string;
  attached: boolean;
  sessionToken: string;
}

export interface AttachResult {
  sessionToken: string;
  name: string;
}

// ─── Workspace / Directory Discovery ───────────────────────────

export interface DirectoryInfo {
  path: string;
  name: string;
  branches: string[];
}

export interface ListDirectoriesResult {
  basePath: string;
  scannedAt: number;
  directories: DirectoryInfo[];
}

// ─── Helpers ───────────────────────────────────────────────────

function apiUrl(path: string): string {
  const proto = window.location.protocol === "https:" ? "https" : "http";
  return `${proto}://${window.location.host}${path}`;
}

function headers(
  token?: string,
  opts?: { noContentType?: boolean },
): Record<string, string> {
  const h: Record<string, string> = {};
  if (!opts?.noContentType) h["content-type"] = "application/json";
  if (token) h["authorization"] = `Bearer ${token}`;
  return h;
}

// ─── API Methods ───────────────────────────────────────────────

export const api = {
  async login(username: string, password: string): Promise<LoginResult> {
    const res = await fetch(apiUrl("/api/login"), {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: "Login failed" }));
      throw new Error(body.error || "Login failed");
    }
    return res.json();
  },

  async logout(token: string): Promise<void> {
    try {
      await fetch(apiUrl("/api/logout"), {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify({}),
      });
    } catch {
      // best-effort
    }
  },

  async listSessions(token: string): Promise<SessionInfo[]> {
    const res = await fetch(apiUrl("/api/sessions"), {
      headers: headers(token),
    });
    if (!res.ok) throw new Error("Failed to list sessions");
    const data = await res.json();
    return data.sessions ?? [];
  },

  async createSession(
    token: string,
    opts: {
      dirname?: string;
      branch?: string;
      cwd?: string;
      agentCommand?: string;
      baseBranch?: string;
    },
  ): Promise<CreateSessionResult> {
    const res = await fetch(apiUrl("/api/sessions"), {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify(opts),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: "Create failed" }));
      throw new Error(body.error || "Create failed");
    }
    return res.json();
  },

  async attachToSession(token: string, name: string): Promise<AttachResult> {
    const res = await fetch(
      apiUrl(`/api/sessions/${encodeURIComponent(name)}/attach`),
      {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify({}),
      },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: "Attach failed" }));
      throw new Error(body.error || "Attach failed");
    }
    return res.json();
  },

  async deleteSession(token: string, name: string): Promise<void> {
    const res = await fetch(
      apiUrl(`/api/sessions/${encodeURIComponent(name)}`),
      {
        method: "DELETE",
        headers: headers(token, { noContentType: true }),
      },
    );
    if (!res.ok) throw new Error("Failed to delete session");
  },

  // ── Workspace / Directory Discovery ─────────────────────────

  async listDirectories(token: string): Promise<ListDirectoriesResult> {
    const res = await fetch(apiUrl("/api/workspace/directories"), {
      headers: headers(token),
    });
    if (!res.ok) throw new Error("Failed to list directories");
    return res.json();
  },

  async refreshDirectories(token: string): Promise<ListDirectoriesResult> {
    const res = await fetch(apiUrl("/api/workspace/refresh"), {
      method: "POST",
      headers: headers(token),
    });
    if (!res.ok) throw new Error("Failed to refresh directories");
    return res.json();
  },

  async fetchRepoBranches(
    token: string,
    repoPath: string,
  ): Promise<DirectoryInfo> {
    const res = await fetch(
      apiUrl(
        `/api/workspace/repo/branches?path=${encodeURIComponent(repoPath)}`,
      ),
      { headers: headers(token) },
    );
    if (!res.ok) throw new Error("Failed to fetch repo branches");
    return res.json();
  },
};
