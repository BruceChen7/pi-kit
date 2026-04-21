import type {
  BootstrapResponse,
  HomeResponse,
  RequirementDetail,
  TerminalInputResponse,
} from "./types";

const defaultRequirementTerminal: RequirementDetail["terminal"] = {
  summary: null,
  status: "idle",
  writable: false,
  shellAlive: false,
  streamUrl: "",
  lastExitCode: null,
};

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

function normalizeRequirementDetail(
  payload: RequirementDetail,
): RequirementDetail {
  return {
    ...payload,
    terminal: {
      ...defaultRequirementTerminal,
      ...(payload.terminal ?? {}),
    },
  };
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

  async getHome(): Promise<HomeResponse> {
    return this.request<HomeResponse>("/kanban/home", {
      method: "GET",
    });
  }

  async createRequirement(input: {
    title: string;
    prompt: string;
    projectId?: string | null;
    projectName?: string | null;
    projectPath?: string | null;
  }): Promise<RequirementDetail> {
    const payload = await this.request<RequirementDetail>("/kanban/requirements", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return normalizeRequirementDetail(payload);
  }

  async getRequirement(requirementId: string): Promise<RequirementDetail> {
    const payload = await this.request<RequirementDetail>(
      `/kanban/requirements/${encodeURIComponent(requirementId)}`,
      {
        method: "GET",
      },
    );
    return normalizeRequirementDetail(payload);
  }

  async startRequirement(
    requirementId: string,
    command: string,
  ): Promise<RequirementDetail> {
    const payload = await this.request<RequirementDetail>(
      `/kanban/requirements/${encodeURIComponent(requirementId)}/start`,
      {
        method: "POST",
        body: JSON.stringify({ command }),
      },
    );
    return normalizeRequirementDetail(payload);
  }

  async restartRequirement(
    requirementId: string,
    command: string,
  ): Promise<RequirementDetail> {
    const payload = await this.request<RequirementDetail>(
      `/kanban/requirements/${encodeURIComponent(requirementId)}/restart`,
      {
        method: "POST",
        body: JSON.stringify({ command }),
      },
    );
    return normalizeRequirementDetail(payload);
  }

  async updateRequirementBoardStatus(
    requirementId: string,
    boardStatus: "inbox" | "in_progress" | "done",
  ): Promise<RequirementDetail> {
    const payload = await this.request<RequirementDetail>(
      `/kanban/requirements/${encodeURIComponent(requirementId)}/board-status`,
      {
        method: "POST",
        body: JSON.stringify({ boardStatus }),
      },
    );
    return normalizeRequirementDetail(payload);
  }

  async sendRequirementTerminalInput(
    requirementId: string,
    input: string,
  ): Promise<TerminalInputResponse> {
    return this.request<TerminalInputResponse>(
      `/kanban/requirements/${encodeURIComponent(requirementId)}/terminal/input`,
      {
        method: "POST",
        body: JSON.stringify({ input }),
      },
    );
  }

  createTerminalEventSource(streamUrl: string): EventSource {
    return new EventSource(streamUrl.trim());
  }
}
