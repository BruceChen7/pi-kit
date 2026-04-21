import type {
  ActionState,
  BoardSnapshot,
  BootstrapResponse,
  CardContext,
  CardRuntimeDetail,
  ExecuteResponse,
} from "./types";

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    throw new Error("kanban api path is required");
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

async function readJsonPayload(
  response: Response,
): Promise<Record<string, unknown> | null> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }

    throw error;
  }
}

export class KanbanRuntimeApi {
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(normalizePath(path), {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });

    const payload = await readJsonPayload(response);
    if (!response.ok) {
      throw new Error(String(payload?.error ?? `HTTP ${response.status}`));
    }

    if (!payload) {
      throw new Error(`HTTP ${response.status}`);
    }

    return payload as T;
  }

  async bootstrap(): Promise<BootstrapResponse> {
    return this.request<BootstrapResponse>("/kanban/bootstrap", {
      method: "POST",
    });
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

  async patchBoard(nextBoardText: string): Promise<{ summary: string }> {
    return this.request<{ summary: string }>("/kanban/board", {
      method: "PATCH",
      body: JSON.stringify({
        nextBoardText,
      }),
    });
  }

  async getCardRuntime(cardId: string): Promise<CardRuntimeDetail> {
    return this.request<CardRuntimeDetail>(
      `/kanban/cards/${encodeURIComponent(cardId)}/runtime`,
      {
        method: "GET",
      },
    );
  }

  async sendTerminalInput(
    cardId: string,
    input: string,
  ): Promise<{ accepted: boolean; mode: string }> {
    return this.request<{ accepted: boolean; mode: string }>(
      `/kanban/cards/${encodeURIComponent(cardId)}/terminal/input`,
      {
        method: "POST",
        body: JSON.stringify({ input }),
      },
    );
  }

  createEventSource(): EventSource {
    return new EventSource("/kanban/stream");
  }

  createTerminalEventSource(streamUrl: string): EventSource {
    return new EventSource(streamUrl.trim());
  }
}
