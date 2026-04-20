import type {
  ActionState,
  BoardSnapshot,
  CardContext,
  ExecuteResponse,
} from "./types";

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function normalizeToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed.toLowerCase().startsWith("bearer ")) {
    return trimmed.slice("bearer ".length).trim();
  }
  return trimmed;
}

export class KanbanRuntimeApi {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.token = normalizeToken(token);
  }

  private buildUrl(path: string): string {
    return `${trimTrailingSlash(this.baseUrl)}${path}`;
  }

  private authHeaders(): HeadersInit {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };

    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }

    return headers;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(this.buildUrl(path), {
      ...init,
      headers: {
        ...this.authHeaders(),
        ...(init?.headers ?? {}),
      },
    });

    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(String(payload.error ?? `HTTP ${response.status}`));
    }

    return payload as T;
  }

  async getBoard(): Promise<BoardSnapshot> {
    return this.request<BoardSnapshot>("/kanban/board", {
      method: "GET",
    });
  }

  async getCardContext(cardId: string): Promise<CardContext> {
    return this.request<CardContext>(
      `/kanban/cards/${encodeURIComponent(cardId)}/context`,
      {
        method: "GET",
      },
    );
  }

  async executeAction(input: {
    action: string;
    cardId: string;
    worktreeKey: string;
    payload?: Record<string, unknown>;
  }): Promise<ExecuteResponse> {
    return this.request<ExecuteResponse>("/kanban/actions/execute", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async getActionStatus(requestId: string): Promise<ActionState> {
    return this.request<ActionState>(
      `/kanban/actions/${encodeURIComponent(requestId)}`,
      {
        method: "GET",
      },
    );
  }

  createEventSource(): EventSource {
    const baseStreamUrl = this.buildUrl("/kanban/stream");
    const url = this.token
      ? `${baseStreamUrl}?token=${encodeURIComponent(this.token)}`
      : baseStreamUrl;
    return new EventSource(url);
  }
}
