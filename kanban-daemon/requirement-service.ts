import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  KanbanRuntimeStateStore,
  type KanbanTerminalEvent,
} from "../extensions/kanban-orchestrator/runtime-state.js";

export type RequirementBoardStatus = "inbox" | "in_progress" | "done";
export type RequirementRunStage = "launch" | "running" | "review" | "done";
export type RequirementSessionStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type RequirementProjectRecord = {
  id: string;
  name: string;
  path: string;
  normalizedPath: string;
  lastOpenedAt: string | null;
  lastDetailViewedAt: string | null;
};

export type RequirementRecord = {
  id: string;
  projectId: string;
  title: string;
  prompt: string;
  boardStatus: RequirementBoardStatus;
  runStage: RequirementRunStage;
  activeSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type RequirementSessionRecord = {
  id: string;
  requirementId: string;
  command: string;
  status: RequirementSessionStatus;
  runtimeRef: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  supersededBy: string | null;
};

type PersistedRepoState = {
  projects: RequirementProjectRecord[];
  requirements: RequirementRecord[];
  sessions: RequirementSessionRecord[];
};

type PersistedState = {
  repos: Record<string, PersistedRepoState>;
};

export type RequirementHomeProject = {
  project: {
    id: string;
    name: string;
    path: string;
  };
  inbox: RequirementSummary[];
  inProgress: RequirementSummary[];
  done: RequirementSummary[];
};

export type RequirementSummary = {
  id: string;
  title: string;
  prompt: string;
  boardStatus: RequirementBoardStatus;
  runStage: RequirementRunStage;
  updatedAt: string;
  hasActiveSession: boolean;
};

export type RequirementHomeData = {
  mode: "empty-create" | "project-board";
  hasUnfinishedRequirements: boolean;
  lastViewedProjectId: string | null;
  recentProjects: Array<{
    id: string;
    name: string;
    path: string;
  }>;
  projectGroups: RequirementHomeProject[];
};

export type RequirementDetail = {
  requirement: RequirementRecord;
  project: RequirementProjectRecord;
  activeSession: RequirementSessionRecord | null;
  runtime: {
    summary: string | null;
    status: "idle" | "running" | "completed" | "failed";
    terminalAvailable: boolean;
    streamUrl: string;
  };
};

function buildDefaultState(): PersistedState {
  return { repos: {} };
}

function buildDefaultRepoState(): PersistedRepoState {
  return {
    projects: [],
    requirements: [],
    sessions: [],
  };
}

function buildStatePath(): string {
  return path.join(os.homedir(), ".pi", "kanban", "state.json");
}

function normalizeProjectPath(projectPath: string): string {
  const trimmed = projectPath.trim();
  if (!trimmed) {
    return "";
  }

  const normalized = path.normalize(trimmed);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function trimToNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function deriveProjectName(input: {
  name?: string | null;
  path: string;
}): string {
  const explicitName = trimToNull(input.name);
  if (explicitName) {
    return explicitName;
  }

  const base = path.basename(input.path.trim());
  return base || input.path.trim();
}

function serialize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class RequirementService {
  private readonly statePath: string;

  private readonly repoRoot: string;

  private readonly workspaceId: string;

  private readonly runtimeState = new KanbanRuntimeStateStore();

  private readonly now: () => string;

  private readonly createId: () => string;

  constructor(input: {
    repoRoot: string;
    workspaceId: string;
    statePath?: string;
    now?: () => string;
    createId?: () => string;
  }) {
    this.repoRoot = input.repoRoot;
    this.workspaceId = input.workspaceId;
    this.statePath = input.statePath ?? buildStatePath();
    this.now = input.now ?? (() => new Date().toISOString());
    this.createId =
      input.createId ??
      (() => {
        if (
          typeof crypto !== "undefined" &&
          typeof crypto.randomUUID === "function"
        ) {
          return crypto.randomUUID();
        }

        return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      });
  }

  getHome(): RequirementHomeData {
    const state = this.getRepoState();
    const unfinishedProjectIds = new Set(
      state.requirements
        .filter((requirement) => requirement.boardStatus !== "done")
        .map((requirement) => requirement.projectId),
    );
    const hasUnfinishedRequirements = unfinishedProjectIds.size > 0;
    const projectGroups = state.projects
      .filter((project) => unfinishedProjectIds.has(project.id))
      .sort(compareProjects)
      .map((project) => ({
        project: {
          id: project.id,
          name: project.name,
          path: project.path,
        },
        inbox: this.buildSummaries(
          state.requirements.filter(
            (requirement) =>
              requirement.projectId === project.id &&
              requirement.boardStatus === "inbox",
          ),
          state,
        ),
        inProgress: this.buildSummaries(
          state.requirements.filter(
            (requirement) =>
              requirement.projectId === project.id &&
              requirement.boardStatus === "in_progress",
          ),
          state,
        ),
        done: this.buildSummaries(
          state.requirements.filter(
            (requirement) =>
              requirement.projectId === project.id &&
              requirement.boardStatus === "done",
          ),
          state,
        ),
      }));

    const recentProjects = [...state.projects]
      .sort(compareProjects)
      .slice(0, 5)
      .map((project) => ({
        id: project.id,
        name: project.name,
        path: project.path,
      }));

    return {
      mode: hasUnfinishedRequirements ? "project-board" : "empty-create",
      hasUnfinishedRequirements,
      lastViewedProjectId:
        recentProjects.find(
          (project) =>
            project.id === this.getLastViewedProjectId(state.projects),
        )?.id ?? this.getLastViewedProjectId(state.projects),
      recentProjects,
      projectGroups,
    };
  }

  createRequirement(input: {
    title: string;
    prompt: string;
    projectId?: string | null;
    projectName?: string | null;
    projectPath?: string | null;
  }): RequirementDetail {
    const title = trimToNull(input.title);
    const prompt = trimToNull(input.prompt);
    if (!title) {
      throw new Error("title is required");
    }
    if (!prompt) {
      throw new Error("prompt is required");
    }

    const state = this.readState();
    const repoState = this.ensureRepoState(state);
    const project = this.resolveProject(repoState, input);
    const now = this.now();
    const requirement: RequirementRecord = {
      id: this.createId(),
      projectId: project.id,
      title,
      prompt,
      boardStatus: "inbox",
      runStage: "launch",
      activeSessionId: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    repoState.requirements = [requirement, ...repoState.requirements];
    project.lastOpenedAt = now;
    project.lastDetailViewedAt = now;
    this.writeState(state);

    return this.getRequirementDetail(requirement.id);
  }

  getRequirementDetail(requirementId: string): RequirementDetail {
    const state = this.readState();
    const repoState = this.ensureRepoState(state);
    const requirement = repoState.requirements.find(
      (candidate) => candidate.id === requirementId,
    );
    if (!requirement) {
      throw new Error("requirement not found");
    }

    const project = repoState.projects.find(
      (candidate) => candidate.id === requirement.projectId,
    );
    if (!project) {
      throw new Error("project not found");
    }

    const now = this.now();
    project.lastDetailViewedAt = now;
    project.lastOpenedAt = now;
    this.writeState(state);

    return this.toRequirementDetail(requirement, project, repoState.sessions);
  }

  startRequirement(input: {
    requirementId: string;
    command: string;
  }): RequirementDetail {
    const command = trimToNull(input.command);
    if (!command) {
      throw new Error("command is required");
    }

    const state = this.readState();
    const repoState = this.ensureRepoState(state);
    const requirement = this.findRequirement(repoState, input.requirementId);
    const existingSession = this.findActiveSession(
      repoState.sessions,
      requirement,
    );
    const now = this.now();

    const nextSession: RequirementSessionRecord = {
      id: this.createId(),
      requirementId: requirement.id,
      command,
      status: "running",
      runtimeRef: `prototype:${requirement.id}`,
      startedAt: now,
      finishedAt: null,
      supersededBy: null,
    };

    if (existingSession) {
      existingSession.supersededBy = nextSession.id;
      existingSession.status = "cancelled";
      existingSession.finishedAt = now;
    }

    repoState.sessions = [nextSession, ...repoState.sessions];
    requirement.activeSessionId = nextSession.id;
    requirement.boardStatus = "in_progress";
    requirement.runStage = "running";
    requirement.completedAt = null;
    requirement.updatedAt = now;
    this.writeState(state);

    this.runtimeState.upsertCardRuntime({
      cardId: requirement.id,
      requestId: nextSession.id,
      status: "running",
      summary: `Running ${command}`,
      startedAt: now,
      completedAt: null,
      terminalAvailable: true,
    });
    this.runtimeState.appendTerminalChunk({
      cardId: requirement.id,
      ts: now,
      chunk: `$ ${command}\r\n`,
    });
    this.runtimeState.appendTerminalChunk({
      cardId: requirement.id,
      ts: now,
      chunk: `[prototype] workspace=${this.workspaceId} requirement=${requirement.title}\r\n`,
    });
    this.runtimeState.appendTerminalChunk({
      cardId: requirement.id,
      ts: now,
      chunk: `[prototype] session started. Continue typing or move to review when ready.\r\n`,
    });

    return this.toRequirementDetail(
      requirement,
      this.findProject(repoState, requirement.projectId),
      repoState.sessions,
    );
  }

  restartRequirement(input: {
    requirementId: string;
    command: string;
  }): RequirementDetail {
    return this.startRequirement(input);
  }

  openReview(requirementId: string): RequirementDetail {
    const state = this.readState();
    const repoState = this.ensureRepoState(state);
    const requirement = this.findRequirement(repoState, requirementId);
    const session = this.findActiveSession(repoState.sessions, requirement);
    const now = this.now();

    requirement.boardStatus = "in_progress";
    requirement.runStage = "review";
    requirement.updatedAt = now;
    if (session) {
      session.status = "completed";
      session.finishedAt = now;
    }
    this.writeState(state);

    this.runtimeState.upsertCardRuntime({
      cardId: requirement.id,
      requestId: session?.id ?? requirement.id,
      status: "completed",
      summary: "Ready for review",
      startedAt: session?.startedAt ?? now,
      completedAt: now,
      terminalAvailable: true,
    });
    this.runtimeState.appendTerminalChunk({
      cardId: requirement.id,
      ts: now,
      chunk: `[prototype] moved to review.\r\n`,
    });

    return this.toRequirementDetail(
      requirement,
      this.findProject(repoState, requirement.projectId),
      repoState.sessions,
    );
  }

  completeReview(requirementId: string): RequirementDetail {
    const state = this.readState();
    const repoState = this.ensureRepoState(state);
    const requirement = this.findRequirement(repoState, requirementId);
    const now = this.now();

    requirement.boardStatus = "done";
    requirement.runStage = "done";
    requirement.completedAt = now;
    requirement.updatedAt = now;
    this.writeState(state);

    this.runtimeState.upsertCardRuntime({
      cardId: requirement.id,
      status: "completed",
      summary: "Requirement done",
      completedAt: now,
      terminalAvailable: true,
    });
    this.runtimeState.appendTerminalChunk({
      cardId: requirement.id,
      ts: now,
      chunk: `[prototype] marked as done.\r\n`,
    });

    return this.toRequirementDetail(
      requirement,
      this.findProject(repoState, requirement.projectId),
      repoState.sessions,
    );
  }

  reopenReview(requirementId: string): RequirementDetail {
    const state = this.readState();
    const repoState = this.ensureRepoState(state);
    const requirement = this.findRequirement(repoState, requirementId);
    const session = this.findActiveSession(repoState.sessions, requirement);
    const now = this.now();

    requirement.boardStatus = "in_progress";
    requirement.runStage = "running";
    requirement.completedAt = null;
    requirement.updatedAt = now;
    if (session) {
      session.status = "running";
      session.finishedAt = null;
    }
    this.writeState(state);

    this.runtimeState.upsertCardRuntime({
      cardId: requirement.id,
      requestId: session?.id ?? requirement.id,
      status: "running",
      summary: "Back in progress",
      startedAt: session?.startedAt ?? now,
      completedAt: null,
      terminalAvailable: true,
    });
    this.runtimeState.appendTerminalChunk({
      cardId: requirement.id,
      ts: now,
      chunk: `[prototype] review reopened. Continue the session.\r\n`,
    });

    return this.toRequirementDetail(
      requirement,
      this.findProject(repoState, requirement.projectId),
      repoState.sessions,
    );
  }

  sendTerminalInput(
    requirementId: string,
    input: string,
  ): { accepted: boolean; mode: string } {
    const message = trimToNull(input);
    if (!message) {
      throw new Error("input is required");
    }

    const state = this.getRepoState();
    const requirement = state.requirements.find(
      (candidate) => candidate.id === requirementId,
    );
    if (!requirement) {
      throw new Error("requirement not found");
    }
    if (requirement.runStage !== "running") {
      throw new Error("requirement is not running");
    }

    const now = this.now();
    this.runtimeState.appendTerminalChunk({
      cardId: requirement.id,
      ts: now,
      chunk: `> ${message}\r\n`,
    });
    this.runtimeState.appendTerminalChunk({
      cardId: requirement.id,
      ts: now,
      chunk: `[prototype] simulated agent response for: ${message}\r\n`,
    });
    this.runtimeState.upsertCardRuntime({
      cardId: requirement.id,
      status: "running",
      summary: `Responded to: ${message}`,
      terminalAvailable: true,
    });

    return {
      accepted: true,
      mode: "line",
    };
  }

  subscribeTerminalStream(
    requirementId: string,
    listener: (event: KanbanTerminalEvent) => void,
  ): () => void {
    return this.runtimeState.subscribeTerminal(requirementId, listener);
  }

  private buildSummaries(
    requirements: RequirementRecord[],
    state: PersistedRepoState,
  ): RequirementSummary[] {
    return [...requirements]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((requirement) => ({
        id: requirement.id,
        title: requirement.title,
        prompt: requirement.prompt,
        boardStatus: requirement.boardStatus,
        runStage: requirement.runStage,
        updatedAt: requirement.updatedAt,
        hasActiveSession: Boolean(
          this.findActiveSession(state.sessions, requirement)?.status ===
            "running",
        ),
      }));
  }

  private getLastViewedProjectId(
    projects: RequirementProjectRecord[],
  ): string | null {
    return [...projects].sort(compareProjects)[0]?.id ?? null;
  }

  private resolveProject(
    state: PersistedRepoState,
    input: {
      projectId?: string | null;
      projectName?: string | null;
      projectPath?: string | null;
    },
  ): RequirementProjectRecord {
    const now = this.now();
    const projectId = trimToNull(input.projectId);
    if (projectId) {
      const existing = state.projects.find(
        (project) => project.id === projectId,
      );
      if (!existing) {
        throw new Error("project not found");
      }
      existing.lastOpenedAt = now;
      return existing;
    }

    const projectPath = trimToNull(input.projectPath);
    if (!projectPath) {
      throw new Error("project path is required");
    }

    const normalizedPath = normalizeProjectPath(projectPath);
    const existingByPath = state.projects.find(
      (project) => project.normalizedPath === normalizedPath,
    );
    if (existingByPath) {
      existingByPath.name = deriveProjectName({
        name: input.projectName,
        path: projectPath,
      });
      existingByPath.path = projectPath;
      existingByPath.lastOpenedAt = now;
      return existingByPath;
    }

    const project: RequirementProjectRecord = {
      id: this.createId(),
      name: deriveProjectName({ name: input.projectName, path: projectPath }),
      path: projectPath,
      normalizedPath,
      lastOpenedAt: now,
      lastDetailViewedAt: now,
    };
    state.projects = [project, ...state.projects];
    return project;
  }

  private toRequirementDetail(
    requirement: RequirementRecord,
    project: RequirementProjectRecord,
    sessions: RequirementSessionRecord[],
  ): RequirementDetail {
    const runtime = this.runtimeState.getCardRuntime(requirement.id);
    const activeSession = this.findActiveSession(sessions, requirement);
    return {
      requirement: serialize(requirement),
      project: serialize(project),
      activeSession: activeSession ? serialize(activeSession) : null,
      runtime: {
        summary: runtime.summary,
        status:
          runtime.status === "running"
            ? "running"
            : runtime.status === "failed"
              ? "failed"
              : runtime.status === "completed"
                ? "completed"
                : "idle",
        terminalAvailable: runtime.terminalAvailable,
        streamUrl: `/kanban/requirements/${encodeURIComponent(requirement.id)}/terminal/stream`,
      },
    };
  }

  private findRequirement(
    state: PersistedRepoState,
    requirementId: string,
  ): RequirementRecord {
    const requirement = state.requirements.find(
      (candidate) => candidate.id === requirementId,
    );
    if (!requirement) {
      throw new Error("requirement not found");
    }
    return requirement;
  }

  private findProject(
    state: PersistedRepoState,
    projectId: string,
  ): RequirementProjectRecord {
    const project = state.projects.find(
      (candidate) => candidate.id === projectId,
    );
    if (!project) {
      throw new Error("project not found");
    }
    return project;
  }

  private findActiveSession(
    sessions: RequirementSessionRecord[],
    requirement: RequirementRecord,
  ): RequirementSessionRecord | null {
    if (!requirement.activeSessionId) {
      return null;
    }

    return (
      sessions.find((session) => session.id === requirement.activeSessionId) ??
      null
    );
  }

  private getRepoState(): PersistedRepoState {
    return this.ensureRepoState(this.readState());
  }

  private ensureRepoState(state: PersistedState): PersistedRepoState {
    const existing = state.repos[this.repoRoot];
    if (existing) {
      return existing;
    }

    const created = buildDefaultRepoState();
    state.repos[this.repoRoot] = created;
    return created;
  }

  private readState(): PersistedState {
    try {
      const raw = fs.readFileSync(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedState;
      if (!parsed || typeof parsed !== "object" || !parsed.repos) {
        return buildDefaultState();
      }
      return parsed;
    } catch (error) {
      if (
        error instanceof Error &&
        ("code" in error ? error.code === "ENOENT" : false)
      ) {
        return buildDefaultState();
      }

      throw error;
    }
  }

  private writeState(state: PersistedState): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2));
  }
}

function compareProjects(
  left: RequirementProjectRecord,
  right: RequirementProjectRecord,
): number {
  const leftTs = left.lastDetailViewedAt ?? left.lastOpenedAt ?? "";
  const rightTs = right.lastDetailViewedAt ?? right.lastOpenedAt ?? "";
  return rightTs.localeCompare(leftTs);
}
