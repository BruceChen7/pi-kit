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
export type RequirementRunStage = "launch" | "running" | "review" | "done";
export type RequirementSessionStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type RequirementSummary = {
  id: string;
  title: string;
  prompt: string;
  boardStatus: RequirementBoardStatus;
  runStage: RequirementRunStage;
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
  runtime: {
    summary: string | null;
    status: "idle" | "running" | "completed" | "failed";
    terminalAvailable: boolean;
    streamUrl: string;
  };
};

export type TerminalInputResponse = {
  accepted: boolean;
  mode: string;
};
