import type {
  ActionState,
  BoardSnapshot,
  CardContext,
  ExecuteResponse,
} from "./types";

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export class KanbanRuntimeApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private buildUrl(path: string): string {
    return `${trimTrailingSlash(this.baseUrl)}${path}`;
  }

  private authHeaders(): HeadersInit {
    return {
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
    };
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
      headers: {
        authorization: `Bearer ${this.token}`,
      },
    });
  }

  async getCardContext(cardId: string): Promise<CardContext> {
    return this.request<CardContext>(
      `/kanban/cards/${encodeURIComponent(cardId)}/context`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.token}`,
        },
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
        headers: {
          authorization: `Bearer ${this.token}`,
        },
      },
    );
  }

  createEventSource(): EventSource {
    const url = `${this.buildUrl("/kanban/stream")}?token=${encodeURIComponent(this.token)}`;
    return new EventSource(url);
  }
}
