export type BootstrapResponse =
  | {
      status: "ready";
      sessionId: string;
      workspaceId?: string;
      capabilities?: {
        stream: boolean;
        actions: boolean;
      };
    }
  | {
      status: "pending";
      retryAfterMs: number;
      message?: string;
    }
  | {
      status: "failed";
      error: string;
    };

export type RequirementBoardStatus = "inbox" | "in_progress" | "done";
export type RequirementSessionStatus = "live" | "exited" | "failed" | "killed";

export type RequirementSummary = {
  id: string;
  title: string;
  prompt: string;
  boardStatus: RequirementBoardStatus;
  updatedAt: string;
  hasActiveSession: boolean;
};

export type HomeProjectGroup = {
  project: {
    id: string;
    name: string;
    path: string;
  };
  inbox: RequirementSummary[];
  inProgress: RequirementSummary[];
  done: RequirementSummary[];
};

export type HomeResponse = {
  mode: "empty-create" | "project-board";
  hasUnfinishedRequirements: boolean;
  lastViewedProjectId: string | null;
  recentProjects: Array<{
    id: string;
    name: string;
    path: string;
  }>;
  projectGroups: HomeProjectGroup[];
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

export type RequirementDetail = {
  requirement: RequirementRecord;
  project: {
    id: string;
    name: string;
    path: string;
    normalizedPath: string;
    lastOpenedAt: string | null;
    lastDetailViewedAt: string | null;
  };
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

export type TerminalInputResponse = {
  accepted: boolean;
  mode: string;
};
