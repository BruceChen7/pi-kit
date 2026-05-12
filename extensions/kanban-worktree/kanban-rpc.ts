import type { RpcRequest } from "./protocol.ts";

export const KanbanRpcMethod = {
  DaemonHealth: "daemon.health",
  DaemonShutdown: "daemon.shutdown",
  RequirementsCreate: "requirements.create",
  RequirementsList: "requirements.list",
  RequirementsRemove: "requirements.remove",
  BranchesList: "branches.list",
  FeaturesLaunch: "features.launch",
} as const;

export type KanbanRpcMethod =
  (typeof KanbanRpcMethod)[keyof typeof KanbanRpcMethod];

export type IssueSummary = {
  issueId: string;
  originProvider: string;
  originId: string;
  title: string;
  description?: string;
  status: string;
  repoRoot?: string;
  baseBranch?: string;
  slug?: string;
  workBranch?: string;
  worktreePath?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type LaunchIntent = {
  originProvider: string;
  originId: string;
};

export type CreateIntent = {
  title: string;
  baseBranch: string | null;
  workBranch: string | null;
  launch: boolean;
  clientRequestId: string | null;
};

export type DeleteIntent = {
  originProvider: string;
  originId: string;
};

type JsonRecord = Record<string, unknown>;

export function daemonHealthRequest(): RpcRequest {
  return {
    id: "health",
    method: KanbanRpcMethod.DaemonHealth,
  };
}

export function daemonShutdownRequest(): RpcRequest {
  return {
    id: "shutdown",
    method: KanbanRpcMethod.DaemonShutdown,
  };
}

export function requirementsListRequest(id = "initial-list"): RpcRequest {
  return {
    id,
    method: KanbanRpcMethod.RequirementsList,
  };
}

export function requirementsCreateRequest(
  create: CreateIntent,
  id = `create-${create.title}`,
): RpcRequest {
  return {
    id,
    method: KanbanRpcMethod.RequirementsCreate,
    params: {
      title: create.title,
      ...(create.baseBranch ? { baseBranch: create.baseBranch } : {}),
      workBranch: create.workBranch,
    },
  };
}

export function featuresLaunchRequest(launch: LaunchIntent): RpcRequest {
  return {
    id: `launch-${launch.originProvider}-${launch.originId}`,
    method: KanbanRpcMethod.FeaturesLaunch,
    params: {
      originProvider: launch.originProvider,
      originId: launch.originId,
    },
  };
}

export function branchesListRequest(): RpcRequest {
  return {
    id: "branches-list",
    method: KanbanRpcMethod.BranchesList,
  };
}

export function requirementsRemoveRequest(deletion: DeleteIntent): RpcRequest {
  return {
    id: `delete-${deletion.originProvider}-${deletion.originId}`,
    method: KanbanRpcMethod.RequirementsRemove,
    params: deletion,
  };
}

export function readRpcError(response: unknown): string | null {
  const error = isRecord(response) ? response.error : null;
  if (!isRecord(error) || typeof error.message !== "string") return null;
  return error.message;
}

export function readIssuesResult(response: unknown): IssueSummary[] {
  const result = isRecord(response) ? response.result : null;
  return Array.isArray(result) ? result.filter(isIssueSummary) : [];
}

export function readIssueResult(response: unknown): IssueSummary | null {
  const result = isRecord(response) ? response.result : null;
  if (isIssueSummary(result)) return result;
  return normalizeLegacyIssue(result);
}

export function isIssueSummary(value: unknown): value is IssueSummary {
  return (
    isRecord(value) &&
    typeof value.issueId === "string" &&
    typeof value.originProvider === "string" &&
    typeof value.originId === "string" &&
    typeof value.title === "string" &&
    typeof value.status === "string"
  );
}

function normalizeLegacyIssue(value: unknown): IssueSummary | null {
  if (!isRecord(value)) return null;

  const originId = readFirstString(value, ["originId", "id"]);
  const title = readFirstString(value, ["title", "description"]);
  const status = readOptionalString(value, "status");
  if (!originId || !title || !status) return null;

  const description = readOptionalString(value, "description") ?? title;
  return {
    issueId:
      readOptionalString(value, "issueId") ?? `todo-workflow:${originId}`,
    originProvider:
      readOptionalString(value, "originProvider") ?? "todo-workflow",
    originId,
    title,
    description,
    status: status === "todo" ? "in-box" : status,
    repoRoot: readOptionalString(value, "repoRoot") ?? "",
    baseBranch: readOptionalString(value, "baseBranch") ?? "main",
    slug: readOptionalString(value, "slug") ?? originId,
    workBranch: readOptionalString(value, "workBranch"),
    worktreePath: readOptionalString(value, "worktreePath"),
    createdAt: readOptionalString(value, "createdAt") ?? "",
    updatedAt: readOptionalString(value, "updatedAt") ?? "",
  };
}

function readFirstString(record: JsonRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = readOptionalString(record, key);
    if (value) return value;
  }
  return null;
}

export function readOptionalString(
  record: JsonRecord,
  key: string,
): string | undefined {
  const value = record[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}
