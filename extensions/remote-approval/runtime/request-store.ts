export type RemoteRequestKind = "approval" | "idle_continue";

export type RemoteRequestStatus =
  | "pending"
  | "approved"
  | "always"
  | "denied"
  | "dismissed"
  | "continue_waiting_input"
  | "continued"
  | "expired"
  | "failed"
  | "superseded";

export type RequestResolutionSource = "local" | "remote" | "system";

export type RemoteRequest = {
  requestId: string;
  kind: RemoteRequestKind;
  sessionId: string;
  sessionLabel: string;
  createdAt: number;
  status: RemoteRequestStatus;
  resolutionSource?: RequestResolutionSource;
  telegramMessageId?: number;
  replyPromptMessageId?: number;
  toolName?: string;
  toolInputPreview?: string;
  contextPreview: string[];
  fullContextAvailable: boolean;
};

type CreateRequestInput = Omit<
  RemoteRequest,
  "createdAt" | "status" | "resolutionSource"
>;

type ResolveResult = {
  applied: boolean;
  request: RemoteRequest | null;
};

const isResolved = (status: RemoteRequestStatus): boolean =>
  status !== "pending";

export const createRequestStore = (now: () => number = Date.now) => {
  const requests = new Map<string, RemoteRequest>();
  const latestPendingIdleBySession = new Map<string, string>();

  const supersedeIdle = (requestId: string): void => {
    const request = requests.get(requestId);
    if (
      !request ||
      request.kind !== "idle_continue" ||
      isResolved(request.status)
    ) {
      return;
    }
    request.status = "superseded";
    request.resolutionSource = "system";
  };

  return {
    create(input: CreateRequestInput): RemoteRequest {
      if (input.kind === "idle_continue") {
        const previousRequestId = latestPendingIdleBySession.get(
          input.sessionId,
        );
        if (previousRequestId) {
          supersedeIdle(previousRequestId);
        }
      }

      const request: RemoteRequest = {
        ...input,
        createdAt: now(),
        status: "pending",
      };
      requests.set(request.requestId, request);

      if (request.kind === "idle_continue") {
        latestPendingIdleBySession.set(request.sessionId, request.requestId);
      }

      return request;
    },

    get(requestId: string): RemoteRequest | null {
      return requests.get(requestId) ?? null;
    },

    resolve(
      requestId: string,
      status: Exclude<RemoteRequestStatus, "pending">,
      source: RequestResolutionSource,
    ): ResolveResult {
      const request = requests.get(requestId) ?? null;
      if (!request) {
        return { applied: false, request: null };
      }
      if (isResolved(request.status)) {
        return { applied: false, request };
      }

      request.status = status;
      request.resolutionSource = source;
      if (
        request.kind === "idle_continue" &&
        latestPendingIdleBySession.get(request.sessionId) === requestId
      ) {
        latestPendingIdleBySession.delete(request.sessionId);
      }
      return { applied: true, request };
    },

    getLatestPendingIdleRequest(sessionId: string): RemoteRequest | null {
      const requestId = latestPendingIdleBySession.get(sessionId);
      if (!requestId) {
        return null;
      }
      const request = requests.get(requestId) ?? null;
      if (!request || isResolved(request.status)) {
        latestPendingIdleBySession.delete(sessionId);
        return null;
      }
      return request;
    },
  };
};
