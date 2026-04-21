import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { KanbanTerminalEvent } from "../extensions/kanban-orchestrator/runtime-state.js";
import {
  type PtySessionExitInfo,
  PtySessionManager,
  type PtyShellFactory,
} from "./pty-session-manager.js";

export type RequirementBoardStatus = "inbox" | "in_progress" | "done";
export type RequirementSessionStatus = "live" | "exited" | "failed" | "killed";

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
  shellPid: number | null;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  exitReason: "shell-exit" | "restart" | "daemon-shutdown" | "error" | null;
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
  terminal: {
    summary: string | null;
    status: "idle" | "live" | "exited" | "error";
    writable: boolean;
    shellAlive: boolean;
    streamUrl: string;
    lastExitCode: number | null;
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

function isBoardStatus(value: unknown): value is RequirementBoardStatus {
  return value === "inbox" || value === "in_progress" || value === "done";
}

function isSessionStatus(value: unknown): value is RequirementSessionStatus {
  return (
    value === "live" ||
    value === "exited" ||
    value === "failed" ||
    value === "killed"
  );
}

function deriveLegacyBoardStatus(
  input: Record<string, unknown>,
): RequirementBoardStatus {
  if (isBoardStatus(input.boardStatus)) {
    return input.boardStatus;
  }

  const runStage = trimToNull(
    typeof input.runStage === "string" ? input.runStage : null,
  );
  if (runStage === "done") {
    return "done";
  }
  if (runStage === "running" || runStage === "review") {
    return "in_progress";
  }
  return "inbox";
}

function normalizeProjectRecord(
  input: unknown,
): RequirementProjectRecord | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const record = input as Record<string, unknown>;
  const id = trimToNull(typeof record.id === "string" ? record.id : null);
  const name = trimToNull(typeof record.name === "string" ? record.name : null);
  const projectPath = trimToNull(
    typeof record.path === "string" ? record.path : null,
  );
  const normalizedPath = trimToNull(
    typeof record.normalizedPath === "string" ? record.normalizedPath : null,
  );
  if (!id || !name || !projectPath) {
    return null;
  }

  return {
    id,
    name,
    path: projectPath,
    normalizedPath: normalizedPath ?? normalizeProjectPath(projectPath),
    lastOpenedAt:
      typeof record.lastOpenedAt === "string" ? record.lastOpenedAt : null,
    lastDetailViewedAt:
      typeof record.lastDetailViewedAt === "string"
        ? record.lastDetailViewedAt
        : null,
  };
}

function normalizeRequirementRecord(input: unknown): RequirementRecord | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const record = input as Record<string, unknown>;
  const id = trimToNull(typeof record.id === "string" ? record.id : null);
  const projectId = trimToNull(
    typeof record.projectId === "string" ? record.projectId : null,
  );
  const title = trimToNull(
    typeof record.title === "string" ? record.title : null,
  );
  const prompt = trimToNull(
    typeof record.prompt === "string" ? record.prompt : null,
  );
  const createdAt =
    typeof record.createdAt === "string"
      ? record.createdAt
      : new Date(0).toISOString();
  const updatedAt =
    typeof record.updatedAt === "string" ? record.updatedAt : createdAt;

  if (!id || !projectId || !title || !prompt) {
    return null;
  }

  return {
    id,
    projectId,
    title,
    prompt,
    boardStatus: deriveLegacyBoardStatus(record),
    activeSessionId:
      typeof record.activeSessionId === "string"
        ? record.activeSessionId
        : null,
    createdAt,
    updatedAt,
    completedAt:
      typeof record.completedAt === "string" ? record.completedAt : null,
  };
}

function normalizeSessionRecord(
  input: unknown,
): RequirementSessionRecord | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const record = input as Record<string, unknown>;
  const id = trimToNull(typeof record.id === "string" ? record.id : null);
  const requirementId = trimToNull(
    typeof record.requirementId === "string" ? record.requirementId : null,
  );
  const command = trimToNull(
    typeof record.command === "string" ? record.command : null,
  );
  const startedAt =
    typeof record.startedAt === "string"
      ? record.startedAt
      : new Date(0).toISOString();

  if (!id || !requirementId || !command) {
    return null;
  }

  let status: RequirementSessionStatus;
  if (isSessionStatus(record.status)) {
    status = record.status;
  } else {
    switch (record.status) {
      case "running":
        status = "live";
        break;
      case "failed":
        status = "failed";
        break;
      case "cancelled":
        status = "killed";
        break;
      default:
        status = "exited";
        break;
    }
  }

  return {
    id,
    requirementId,
    command,
    status,
    shellPid:
      typeof record.shellPid === "number" && Number.isFinite(record.shellPid)
        ? record.shellPid
        : null,
    startedAt,
    finishedAt:
      typeof record.finishedAt === "string" ? record.finishedAt : null,
    exitCode:
      typeof record.exitCode === "number" && Number.isFinite(record.exitCode)
        ? record.exitCode
        : null,
    exitReason:
      record.exitReason === "shell-exit" ||
      record.exitReason === "restart" ||
      record.exitReason === "daemon-shutdown" ||
      record.exitReason === "error"
        ? record.exitReason
        : null,
    supersededBy:
      typeof record.supersededBy === "string" ? record.supersededBy : null,
  };
}

function normalizeState(input: unknown): PersistedState {
  if (!input || typeof input !== "object") {
    return buildDefaultState();
  }

  const rawRepos =
    "repos" in input && input.repos && typeof input.repos === "object"
      ? (input.repos as Record<string, unknown>)
      : {};

  const repos = Object.fromEntries(
    Object.entries(rawRepos).map(([repoRoot, rawRepoState]) => {
      const repo =
        rawRepoState && typeof rawRepoState === "object"
          ? (rawRepoState as Record<string, unknown>)
          : {};
      const projects = Array.isArray(repo.projects)
        ? repo.projects.map(normalizeProjectRecord).filter(Boolean)
        : [];
      const requirements = Array.isArray(repo.requirements)
        ? repo.requirements.map(normalizeRequirementRecord).filter(Boolean)
        : [];
      const sessions = Array.isArray(repo.sessions)
        ? repo.sessions.map(normalizeSessionRecord).filter(Boolean)
        : [];

      return [
        repoRoot,
        {
          projects,
          requirements,
          sessions,
        } satisfies PersistedRepoState,
      ];
    }),
  );

  return { repos };
}

function compareProjects(
  left: RequirementProjectRecord,
  right: RequirementProjectRecord,
): number {
  const leftTs = left.lastDetailViewedAt ?? left.lastOpenedAt ?? "";
  const rightTs = right.lastDetailViewedAt ?? right.lastOpenedAt ?? "";
  return rightTs.localeCompare(leftTs);
}

export class RequirementService {
  private readonly statePath: string;

  private readonly repoRoot: string;

  private readonly now: () => string;

  private readonly createId: () => string;

  private readonly terminalManager: PtySessionManager;

  constructor(input: {
    repoRoot: string;
    workspaceId: string;
    statePath?: string;
    now?: () => string;
    createId?: () => string;
    createShell?: PtyShellFactory;
    ptySessionManager?: PtySessionManager;
  }) {
    this.repoRoot = input.repoRoot;
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
    this.terminalManager =
      input.ptySessionManager ??
      new PtySessionManager({
        createShell: input.createShell,
        now: this.now,
        onSessionExit: (info) => {
          this.handleSessionExit(info);
        },
      });

    this.reconcilePersistedLiveSessions();
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
    const requirement = this.findRequirement(repoState, requirementId);
    const project = this.findProject(repoState, requirement.projectId);
    const now = this.now();

    project.lastDetailViewedAt = now;
    project.lastOpenedAt = now;
    this.writeState(state);

    return this.toRequirementDetail(requirement, project, repoState.sessions);
  }

  async startRequirement(input: {
    requirementId: string;
    command: string;
  }): Promise<RequirementDetail> {
    const command = trimToNull(input.command);
    if (!command) {
      throw new Error("command is required");
    }

    const state = this.readState();
    const repoState = this.ensureRepoState(state);
    const requirement = this.findRequirement(repoState, input.requirementId);
    const project = this.findProject(repoState, requirement.projectId);
    const activeSession = this.findActiveSession(
      repoState.sessions,
      requirement,
    );

    if (
      activeSession?.status === "live" &&
      this.terminalManager.hasLiveSession(requirement.id)
    ) {
      throw new Error("requirement session already running; use restart");
    }

    const now = this.now();
    const nextSessionId = this.createId();
    const startResult = await this.terminalManager.startSession({
      requirementId: requirement.id,
      sessionId: nextSessionId,
      cwd: project.path,
      command,
    });

    const refreshedState = this.readState();
    const refreshedRepo = this.ensureRepoState(refreshedState);
    const refreshedRequirement = this.findRequirement(
      refreshedRepo,
      requirement.id,
    );
    const refreshedProject = this.findProject(
      refreshedRepo,
      refreshedRequirement.projectId,
    );
    const previousSession = this.findActiveSession(
      refreshedRepo.sessions,
      refreshedRequirement,
    );

    if (previousSession && previousSession.id !== nextSessionId) {
      previousSession.supersededBy = nextSessionId;
    }

    const terminalSnapshot = this.terminalManager.getSnapshot(
      refreshedRequirement.id,
    );
    refreshedRepo.sessions = [
      {
        id: nextSessionId,
        requirementId: refreshedRequirement.id,
        command,
        status:
          terminalSnapshot.status === "live"
            ? "live"
            : terminalSnapshot.status === "error"
              ? "failed"
              : "exited",
        shellPid: startResult.shellPid,
        startedAt: now,
        finishedAt: terminalSnapshot.status === "live" ? null : now,
        exitCode:
          terminalSnapshot.status === "live"
            ? null
            : terminalSnapshot.lastExitCode,
        exitReason:
          terminalSnapshot.status === "live"
            ? null
            : terminalSnapshot.status === "error"
              ? "error"
              : "shell-exit",
        supersededBy: null,
      },
      ...refreshedRepo.sessions.filter(
        (session) => session.id !== nextSessionId,
      ),
    ];
    refreshedRequirement.activeSessionId = nextSessionId;
    refreshedRequirement.boardStatus = "in_progress";
    refreshedRequirement.completedAt = null;
    refreshedRequirement.updatedAt = now;
    this.writeState(refreshedState);

    return this.toRequirementDetail(
      refreshedRequirement,
      refreshedProject,
      refreshedRepo.sessions,
    );
  }

  async restartRequirement(input: {
    requirementId: string;
    command: string;
  }): Promise<RequirementDetail> {
    const command = trimToNull(input.command);
    if (!command) {
      throw new Error("command is required");
    }

    await this.terminalManager.terminateSession(input.requirementId, "restart");
    return this.startRequirement({
      requirementId: input.requirementId,
      command,
    });
  }

  updateBoardStatus(input: {
    requirementId: string;
    boardStatus: RequirementBoardStatus;
  }): RequirementDetail {
    if (!isBoardStatus(input.boardStatus)) {
      throw new Error("board status is required");
    }

    const state = this.readState();
    const repoState = this.ensureRepoState(state);
    const requirement = this.findRequirement(repoState, input.requirementId);
    const now = this.now();

    requirement.boardStatus = input.boardStatus;
    requirement.updatedAt = now;
    requirement.completedAt = input.boardStatus === "done" ? now : null;
    this.writeState(state);

    return this.toRequirementDetail(
      requirement,
      this.findProject(repoState, requirement.projectId),
      repoState.sessions,
    );
  }

  async sendTerminalInput(
    requirementId: string,
    input: string,
  ): Promise<{ accepted: boolean; mode: string }> {
    if (typeof input !== "string" || input.length === 0) {
      throw new Error("input is required");
    }

    const state = this.getRepoState();
    const requirement = state.requirements.find(
      (candidate) => candidate.id === requirementId,
    );
    if (!requirement) {
      throw new Error("requirement not found");
    }
    const activeSession = this.findActiveSession(state.sessions, requirement);
    if (!activeSession || activeSession.status !== "live") {
      throw new Error("no active terminal session");
    }

    await this.terminalManager.sendInput(requirementId, input);
    return {
      accepted: true,
      mode: "raw",
    };
  }

  subscribeTerminalStream(
    requirementId: string,
    listener: (event: KanbanTerminalEvent) => void,
  ): () => void {
    return this.terminalManager.subscribe(requirementId, listener);
  }

  async stop(): Promise<void> {
    await this.terminalManager.stopAll("daemon-shutdown");
  }

  private handleSessionExit(info: PtySessionExitInfo): void {
    const state = this.readState();
    const repoState = this.ensureRepoState(state);
    const session = repoState.sessions.find(
      (candidate) => candidate.id === info.sessionId,
    );
    if (!session) {
      return;
    }

    session.finishedAt = info.finishedAt;
    session.exitCode = info.exitCode;
    session.exitReason = info.reason;
    session.status =
      info.reason === "restart" || info.reason === "daemon-shutdown"
        ? "killed"
        : info.reason === "error" ||
            (typeof info.exitCode === "number" && info.exitCode !== 0)
          ? "failed"
          : "exited";
    this.writeState(state);
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
        updatedAt: requirement.updatedAt,
        hasActiveSession:
          this.findActiveSession(state.sessions, requirement)?.status ===
          "live",
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
    const activeSession = this.findActiveSession(sessions, requirement);
    const terminalSnapshot = this.deriveTerminalSnapshot(
      requirement,
      activeSession,
    );

    return {
      requirement: serialize(requirement),
      project: serialize(project),
      activeSession: activeSession ? serialize(activeSession) : null,
      terminal: {
        summary: terminalSnapshot.summary,
        status: terminalSnapshot.status,
        writable: terminalSnapshot.writable,
        shellAlive: terminalSnapshot.shellAlive,
        streamUrl: `/kanban/requirements/${encodeURIComponent(requirement.id)}/terminal/stream`,
        lastExitCode: terminalSnapshot.lastExitCode,
      },
    };
  }

  private deriveTerminalSnapshot(
    requirement: RequirementRecord,
    activeSession: RequirementSessionRecord | null,
  ): RequirementDetail["terminal"] {
    const runtime = this.terminalManager.getSnapshot(requirement.id);
    if (runtime.status !== "idle") {
      return {
        ...runtime,
        streamUrl: `/kanban/requirements/${encodeURIComponent(requirement.id)}/terminal/stream`,
      };
    }

    if (!activeSession) {
      return {
        summary: null,
        status: "idle",
        writable: false,
        shellAlive: false,
        streamUrl: `/kanban/requirements/${encodeURIComponent(requirement.id)}/terminal/stream`,
        lastExitCode: null,
      };
    }

    if (activeSession.status === "failed") {
      return {
        summary:
          activeSession.exitCode === null
            ? "Shell exited with error"
            : `Shell exited with code ${activeSession.exitCode}`,
        status: "error",
        writable: false,
        shellAlive: false,
        streamUrl: `/kanban/requirements/${encodeURIComponent(requirement.id)}/terminal/stream`,
        lastExitCode: activeSession.exitCode,
      };
    }

    if (
      activeSession.status === "exited" ||
      activeSession.status === "killed"
    ) {
      return {
        summary: "Shell exited",
        status: "exited",
        writable: false,
        shellAlive: false,
        streamUrl: `/kanban/requirements/${encodeURIComponent(requirement.id)}/terminal/stream`,
        lastExitCode: activeSession.exitCode,
      };
    }

    return {
      summary: "Shell unavailable. Restart the session.",
      status: "error",
      writable: false,
      shellAlive: false,
      streamUrl: `/kanban/requirements/${encodeURIComponent(requirement.id)}/terminal/stream`,
      lastExitCode: activeSession.exitCode,
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

  private reconcilePersistedLiveSessions(): void {
    const state = this.readState();
    const repoState = this.ensureRepoState(state);
    let changed = false;
    const finishedAt = this.now();

    for (const session of repoState.sessions) {
      if (session.status !== "live") {
        continue;
      }

      session.status = "killed";
      session.exitReason = session.exitReason ?? "daemon-shutdown";
      session.finishedAt = session.finishedAt ?? finishedAt;
      changed = true;
    }

    if (changed) {
      this.writeState(state);
    }
  }

  private readState(): PersistedState {
    try {
      const raw = fs.readFileSync(this.statePath, "utf8");
      return normalizeState(JSON.parse(raw));
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
