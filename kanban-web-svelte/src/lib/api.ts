import type {
  BootstrapResponse,
  HomeResponse,
  RequirementDetail,
  TerminalInputResponse,
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
    return this.request<RequirementDetail>("/kanban/requirements", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async getRequirement(requirementId: string): Promise<RequirementDetail> {
    return this.request<RequirementDetail>(
      `/kanban/requirements/${encodeURIComponent(requirementId)}`,
      {
        method: "GET",
      },
    );
  }

  async startRequirement(
    requirementId: string,
    command: string,
  ): Promise<RequirementDetail> {
    return this.request<RequirementDetail>(
      `/kanban/requirements/${encodeURIComponent(requirementId)}/start`,
      {
        method: "POST",
        body: JSON.stringify({ command }),
      },
    );
  }

  async restartRequirement(
    requirementId: string,
    command: string,
  ): Promise<RequirementDetail> {
    return this.request<RequirementDetail>(
      `/kanban/requirements/${encodeURIComponent(requirementId)}/restart`,
      {
        method: "POST",
        body: JSON.stringify({ command }),
      },
    );
  }

  async openRequirementReview(
    requirementId: string,
  ): Promise<RequirementDetail> {
    return this.request<RequirementDetail>(
      `/kanban/requirements/${encodeURIComponent(requirementId)}/review/open`,
      {
        method: "POST",
      },
    );
  }

  async completeRequirementReview(
    requirementId: string,
  ): Promise<RequirementDetail> {
    return this.request<RequirementDetail>(
      `/kanban/requirements/${encodeURIComponent(requirementId)}/review/complete`,
      {
        method: "POST",
      },
    );
  }

  async reopenRequirementReview(
    requirementId: string,
  ): Promise<RequirementDetail> {
    return this.request<RequirementDetail>(
      `/kanban/requirements/${encodeURIComponent(requirementId)}/review/reopen`,
      {
        method: "POST",
      },
    );
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
