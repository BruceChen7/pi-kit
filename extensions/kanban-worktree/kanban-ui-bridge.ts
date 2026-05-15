import type { GlimpseWindow } from "../shared/glimpse-window.ts";
import {
  branchesListRequest,
  type CreateIntent,
  type DeleteIntent,
  featuresLaunchRequest,
  type IssueSummary,
  isRecord,
  type LaunchIntent,
  readIssueResult,
  readOptionalString,
  readRpcError,
  requirementsCreateRequest,
  requirementsRemoveRequest,
} from "./kanban-rpc.ts";

type RequestFn = (socketPath: string, message: unknown) => Promise<unknown>;

type BridgeContext = {
  socketPath: string;
  request: RequestFn;
  window: GlimpseWindow;
};

type LaunchIntentHandlerInput = BridgeContext & { launch: LaunchIntent };
type CreateIntentHandlerInput = BridgeContext & { create: CreateIntent };
type DeleteIntentHandlerInput = BridgeContext & { deletion: DeleteIntent };

type CreateResult =
  | {
      type: "create-result";
      ok: true;
      clientRequestId: string | null;
      issue: IssueSummary;
    }
  | {
      type: "create-result";
      ok: false;
      clientRequestId: string | null;
      error: string;
    };

type LaunchResult =
  | {
      type: "launch-result";
      ok: true;
      originProvider: string;
      originId: string;
      run: unknown;
    }
  | {
      type: "launch-result";
      ok: false;
      originProvider: string;
      originId: string;
      error: string;
    };

type BranchesResult =
  | {
      type: "branches-result";
      ok: true;
      branches: string[];
      defaultBranch: string;
    }
  | {
      type: "branches-result";
      ok: false;
      error: string;
    };

type DeleteResult =
  | {
      type: "delete-result";
      ok: true;
      originProvider: string;
      originId: string;
      issue: IssueSummary | null;
    }
  | {
      type: "delete-result";
      ok: false;
      originProvider: string;
      originId: string;
      error: string;
    };

type InteractionResult =
  | CreateResult
  | LaunchResult
  | BranchesResult
  | DeleteResult;

export function attachKanbanUiBridge(input: BridgeContext): void {
  const { socketPath, request, window } = input;
  window.on("message", async (message: unknown) => {
    const launch = readLaunchIntent(message);
    if (launch) {
      await handleLaunchIntent({ socketPath, request, window, launch });
      return;
    }
    if (readBranchesIntent(message)) {
      await handleBranchesIntent({ socketPath, request, window });
      return;
    }
    const create = readCreateIntent(message);
    if (create) {
      await handleCreateIntent({ socketPath, request, window, create });
      return;
    }
    const deletion = readDeleteIntent(message);
    if (deletion) {
      await handleDeleteIntent({ socketPath, request, window, deletion });
    }
  });
}

async function handleCreateIntent(
  input: CreateIntentHandlerInput,
): Promise<void> {
  const { socketPath, request, window, create } = input;
  try {
    if (!create.workBranch) {
      sendInteractionResult(
        window,
        createFailureResult(
          create.clientRequestId,
          "Enter a work branch name.",
        ),
      );
      return;
    }

    const response = await request(
      socketPath,
      requirementsCreateRequest(create),
    );
    const result = createResultFromResponse(create.clientRequestId, response);
    sendInteractionResult(window, result);
    if (result.ok && create.launch) {
      await handleLaunchIntent({
        socketPath,
        request,
        window,
        launch: result.issue,
      });
    }
  } catch (error) {
    sendInteractionResult(
      window,
      createFailureResult(create.clientRequestId, errorMessage(error)),
    );
  }
}

async function handleLaunchIntent(
  input: LaunchIntentHandlerInput,
): Promise<void> {
  const { socketPath, request, window, launch } = input;
  try {
    const response = await request(socketPath, featuresLaunchRequest(launch));
    sendInteractionResult(window, launchResultFromResponse(launch, response));
  } catch (error) {
    sendInteractionResult(
      window,
      launchFailureResult(launch, errorMessage(error)),
    );
  }
}

async function handleDeleteIntent(
  input: DeleteIntentHandlerInput,
): Promise<void> {
  const { socketPath, request, window, deletion } = input;
  try {
    const response = await request(
      socketPath,
      requirementsRemoveRequest(deletion),
    );
    sendInteractionResult(window, deleteResultFromResponse(deletion, response));
  } catch (error) {
    sendInteractionResult(
      window,
      deleteFailureResult(deletion, errorMessage(error)),
    );
  }
}

async function handleBranchesIntent(input: BridgeContext): Promise<void> {
  const { socketPath, request, window } = input;
  try {
    const response = await request(socketPath, branchesListRequest());
    sendInteractionResult(window, branchesResultFromResponse(response));
  } catch (error) {
    sendInteractionResult(window, branchesFailureResult(errorMessage(error)));
  }
}

function createResultFromResponse(
  clientRequestId: string | null,
  response: unknown,
): CreateResult {
  const error = readRpcError(response);
  if (error) return createFailureResult(clientRequestId, error);

  const issue = readIssueResult(response);
  if (!issue) {
    return createFailureResult(
      clientRequestId,
      unrecognizedIssueMessage(response),
    );
  }

  return createSuccessResult(clientRequestId, issue);
}

function createSuccessResult(
  clientRequestId: string | null,
  issue: IssueSummary,
): CreateResult {
  return {
    type: "create-result",
    ok: true,
    clientRequestId,
    issue,
  };
}

function createFailureResult(
  clientRequestId: string | null,
  error: string,
): CreateResult {
  return {
    type: "create-result",
    ok: false,
    clientRequestId,
    error,
  };
}

function launchResultFromResponse(
  launch: LaunchIntent,
  response: unknown,
): LaunchResult {
  const error = readRpcError(response);
  if (error) return launchFailureResult(launch, error);
  const run = isRecord(response) ? response.result : null;
  return launchSuccessResult(launch, run);
}

function launchSuccessResult(launch: LaunchIntent, run: unknown): LaunchResult {
  return {
    type: "launch-result",
    ok: true,
    originProvider: launch.originProvider,
    originId: launch.originId,
    run,
  };
}

function launchFailureResult(
  launch: LaunchIntent,
  error: string,
): LaunchResult {
  return {
    type: "launch-result",
    ok: false,
    originProvider: launch.originProvider,
    originId: launch.originId,
    error,
  };
}

function branchesResultFromResponse(response: unknown): BranchesResult {
  const error = readRpcError(response);
  if (error) return branchesFailureResult(error);

  const result = isRecord(response) ? response.result : null;
  if (!isRecord(result)) {
    return branchesFailureResult("branches.list returned an invalid result");
  }
  const branches = Array.isArray(result.branches)
    ? result.branches.filter(
        (branch): branch is string => typeof branch === "string",
      )
    : [];
  const defaultBranch = readOptionalString(result, "defaultBranch") ?? "main";
  return {
    type: "branches-result",
    ok: true,
    branches: branches.length > 0 ? branches : [defaultBranch],
    defaultBranch,
  };
}

function branchesFailureResult(error: string): BranchesResult {
  return {
    type: "branches-result",
    ok: false,
    error,
  };
}

function deleteResultFromResponse(
  deletion: DeleteIntent,
  response: unknown,
): DeleteResult {
  const error = readRpcError(response);
  if (error) return deleteFailureResult(deletion, error);
  return {
    type: "delete-result",
    ok: true,
    originProvider: deletion.originProvider,
    originId: deletion.originId,
    issue: readIssueResult(response),
  };
}

function deleteFailureResult(
  deletion: DeleteIntent,
  error: string,
): DeleteResult {
  return {
    type: "delete-result",
    ok: false,
    originProvider: deletion.originProvider,
    originId: deletion.originId,
    error,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendInteractionResult(
  window: GlimpseWindow,
  result: InteractionResult,
): void {
  const detail = escapeScriptJson(result);
  window.send?.(
    `window.dispatchEvent(new CustomEvent("kanban:${result.type}", ` +
      `{ detail: ${detail} }));`,
  );
}

function escapeScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function readLaunchIntent(message: unknown): LaunchIntent | null {
  if (
    isRecord(message) &&
    message.type === "launch" &&
    typeof message.originProvider === "string" &&
    typeof message.originId === "string"
  ) {
    return {
      originProvider: message.originProvider,
      originId: message.originId,
    };
  }
  return null;
}

function readBranchesIntent(message: unknown): boolean {
  return isRecord(message) && message.type === "branches:list";
}

function readDeleteIntent(message: unknown): DeleteIntent | null {
  if (
    isRecord(message) &&
    message.type === "delete" &&
    typeof message.originProvider === "string" &&
    typeof message.originId === "string"
  ) {
    return {
      originProvider: message.originProvider,
      originId: message.originId,
    };
  }
  return null;
}

function readCreateIntent(message: unknown): CreateIntent | null {
  if (
    isRecord(message) &&
    message.type === "create" &&
    typeof message.title === "string" &&
    message.title.trim().length > 0
  ) {
    return {
      title: message.title.trim(),
      baseBranch: readOptionalString(message, "baseBranch") ?? null,
      workBranch: readOptionalString(message, "workBranch") ?? null,
      launch: message.launch === true,
      clientRequestId:
        typeof message.clientRequestId === "string"
          ? message.clientRequestId
          : null,
    };
  }
  return null;
}

function unrecognizedIssueMessage(response: unknown): string {
  const result = isRecord(response) ? response.result : null;
  return `requirements.create returned an unrecognized issue result (${describeShape(result)})`;
}

function describeShape(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (!isRecord(value)) return typeof value;
  const keys = Object.keys(value).sort();
  return keys.length ? `keys: ${keys.join(", ")}` : "empty object";
}
