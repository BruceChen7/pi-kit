import { randomUUID } from "node:crypto";

export const PLANNOTATOR_REQUEST_CHANNEL = "plannotator:request" as const;
export const PLANNOTATOR_REVIEW_RESULT_CHANNEL =
  "plannotator:review-result" as const;
export const DEFAULT_PLANNOTATOR_TIMEOUT_MS = 5_000;

export type PlannotatorAction =
  | "plan-review"
  | "review-status"
  | "code-review"
  | "annotate"
  | "annotate-last"
  | "archive";

export type PlannotatorHandledResponse<T> = {
  status: "handled";
  result: T;
};

export type PlannotatorUnavailableResponse = {
  status: "unavailable";
  error?: string;
};

export type PlannotatorErrorResponse = {
  status: "error";
  error: string;
};

export type PlannotatorResponse<T> =
  | PlannotatorHandledResponse<T>
  | PlannotatorUnavailableResponse
  | PlannotatorErrorResponse;

export type PlanReviewDecision = {
  approved: boolean;
  feedback?: string;
  savedPath?: string;
  agentSwitch?: string;
  permissionMode?: string;
};

export type PlanReviewStartResult = {
  status: "pending";
  reviewId: string;
};

export type ReviewResultEvent = {
  reviewId: string;
  approved: boolean;
  feedback?: string;
  savedPath?: string;
  agentSwitch?: string;
  permissionMode?: string;
};

export type ReviewStatusResult =
  | { status: "pending" }
  | ({ status: "completed" } & ReviewResultEvent)
  | { status: "missing" };

export type CodeReviewResult = {
  approved: boolean;
  feedback?: string;
  annotations?: unknown[];
  agentSwitch?: string;
};

export type AnnotationResult = {
  feedback: string;
  annotations?: unknown[];
  exit?: boolean;
};

export type ArchiveResult = {
  opened: boolean;
};

export type PlannotatorResponseMap = {
  "plan-review": PlannotatorResponse<PlanReviewStartResult>;
  "review-status": PlannotatorResponse<ReviewStatusResult>;
  "code-review": PlannotatorResponse<CodeReviewResult>;
  annotate: PlannotatorResponse<AnnotationResult>;
  "annotate-last": PlannotatorResponse<AnnotationResult>;
  archive: PlannotatorResponse<ArchiveResult>;
};

export type EventBus = {
  on: (channel: string, handler: (data: unknown) => void) => void;
  emit: (channel: string, data: unknown) => void;
};

export const createRequestPlannotator = (
  events: EventBus,
  options: { timeoutMs?: number } = {},
) => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PLANNOTATOR_TIMEOUT_MS;

  return <A extends keyof PlannotatorResponseMap>(
    action: A,
    payload: unknown,
  ): Promise<PlannotatorResponseMap[A]> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (response: PlannotatorResponseMap[A]) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(response);
      };

      const timer = setTimeout(() => {
        finish({
          status: "unavailable",
          error: "Plannotator request timed out.",
        } as PlannotatorResponseMap[A]);
      }, timeoutMs);

      events.emit(PLANNOTATOR_REQUEST_CHANNEL, {
        requestId: randomUUID(),
        action,
        payload,
        respond: (response: PlannotatorResponseMap[A]) => {
          finish(response);
        },
      });
    });
};

type ReviewResultListener = (result: ReviewResultEvent) => void;

export const createReviewResultStore = (events: EventBus) => {
  const statuses = new Map<string, ReviewStatusResult>();
  const listeners = new Set<ReviewResultListener>();

  events.on(PLANNOTATOR_REVIEW_RESULT_CHANNEL, (data) => {
    const result = data as Partial<ReviewResultEvent> | null;
    if (!result?.reviewId || typeof result.reviewId !== "string") {
      return;
    }

    const completed: ReviewStatusResult = {
      status: "completed",
      reviewId: result.reviewId,
      approved: Boolean(result.approved),
      feedback: result.feedback,
      savedPath: result.savedPath,
      agentSwitch: result.agentSwitch,
      permissionMode: result.permissionMode,
    };
    statuses.set(result.reviewId, completed);

    const event: ReviewResultEvent = {
      reviewId: result.reviewId,
      approved: Boolean(result.approved),
      feedback: result.feedback,
      savedPath: result.savedPath,
      agentSwitch: result.agentSwitch,
      permissionMode: result.permissionMode,
    };
    for (const listener of listeners) {
      listener(event);
    }
  });

  return {
    markPending(reviewId: string): void {
      statuses.set(reviewId, { status: "pending" });
    },
    markCompleted(result: ReviewResultEvent): void {
      statuses.set(result.reviewId, {
        status: "completed",
        ...result,
      });
    },
    getStatus(reviewId: string): ReviewStatusResult {
      return statuses.get(reviewId) ?? { status: "missing" };
    },
    onResult(listener: ReviewResultListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

export const waitForReviewResult = (
  reviewStore: ReturnType<typeof createReviewResultStore>,
  reviewId: string,
): Promise<Extract<ReviewStatusResult, { status: "completed" }>> => {
  const existing = reviewStore.getStatus(reviewId);
  if (existing.status === "completed") {
    return Promise.resolve(existing);
  }

  return new Promise((resolve) => {
    const unsubscribe = reviewStore.onResult((result) => {
      if (result.reviewId !== reviewId) {
        return;
      }

      unsubscribe();
      resolve({
        status: "completed",
        ...result,
      });
    });
  });
};

export const startPlanReview = async (
  requestPlannotator: ReturnType<typeof createRequestPlannotator>,
  reviewStore: ReturnType<typeof createReviewResultStore>,
  payload: {
    planContent: string;
    planFilePath?: string;
    origin?: string;
  },
): Promise<PlannotatorResponseMap["plan-review"]> => {
  const response = await requestPlannotator("plan-review", payload);
  if (
    response.status === "handled" &&
    response.result.status === "pending" &&
    response.result.reviewId
  ) {
    reviewStore.markPending(response.result.reviewId);
  }
  return response;
};

export const requestReviewStatus = (
  requestPlannotator: ReturnType<typeof createRequestPlannotator>,
  payload: {
    reviewId: string;
  },
): Promise<PlannotatorResponseMap["review-status"]> =>
  requestPlannotator("review-status", payload);

export const requestCodeReview = (
  requestPlannotator: ReturnType<typeof createRequestPlannotator>,
  payload: {
    cwd?: string;
    defaultBranch?: string;
    diffType?: string;
    prUrl?: string;
  },
): Promise<PlannotatorResponseMap["code-review"]> =>
  requestPlannotator("code-review", payload);

export const requestAnnotation = (
  requestPlannotator: ReturnType<typeof createRequestPlannotator>,
  payload: {
    filePath: string;
    markdown?: string;
    mode?: "annotate" | "annotate-folder" | "annotate-last";
    folderPath?: string;
  },
): Promise<PlannotatorResponseMap["annotate"]> =>
  requestPlannotator("annotate", payload);

export const formatPlanReviewMessage = (result: {
  approved: boolean;
  feedback?: string;
}): string => {
  if (result.approved) {
    if (!result.feedback?.trim()) {
      return "# Plan Review\n\nPlan approved. Proceed with implementation.";
    }

    return `# Plan Review\n\nPlan approved with notes:\n\n${result.feedback}\n\nProceed with implementation and incorporate these notes.`;
  }

  if (!result.feedback?.trim()) {
    return "Plan rejected. Please revise the plan and resubmit for review.";
  }

  return `${result.feedback}\n\nPlease revise the plan and resubmit for review.`;
};

export const formatCodeReviewMessage = (result: {
  approved: boolean;
  feedback?: string;
}): string | null => {
  if (result.approved) {
    return "# Code Review\n\nCode review completed — no changes requested.";
  }

  if (!result.feedback?.trim()) {
    return null;
  }

  return `${result.feedback}\n\nPlease address this feedback.`;
};

export const formatAnnotationMessage = (options: {
  filePath: string;
  feedback: string;
  isFolder?: boolean;
}): string | null => {
  const feedback = options.feedback.trim();
  if (!feedback) {
    return null;
  }

  const header = options.isFolder
    ? `# Markdown Annotations\n\nFolder: ${options.filePath}`
    : `# Markdown Annotations\n\nFile: ${options.filePath}`;

  return `${header}\n\n${feedback}\n\nPlease address the annotation feedback above.`;
};
