import type {
  DiffxCommentStats,
  DiffxReviewComment,
  DiffxReviewSession,
} from "./types.ts";

export class DiffxClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiffxClientError";
  }
}

const truncate = (value: string, max = 300): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

const buildUrl = (baseUrl: string, pathname: string): string =>
  new URL(pathname, `${baseUrl.replace(/\/$/, "")}/`).toString();

const getTimeoutSignal = (
  timeoutMs: number,
): { signal: AbortSignal; cancel: () => void } => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
};

async function requestJson<T>(input: {
  baseUrl: string;
  pathname: string;
  method?: string;
  body?: unknown;
  timeoutMs: number;
}): Promise<T> {
  const { signal, cancel } = getTimeoutSignal(input.timeoutMs);
  try {
    const response = await fetch(buildUrl(input.baseUrl, input.pathname), {
      method: input.method ?? "GET",
      headers:
        input.body === undefined
          ? undefined
          : {
              "Content-Type": "application/json",
            },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      signal,
    });

    if (!response.ok) {
      const bodyText = truncate(await response.text());
      throw new DiffxClientError(
        `${input.method ?? "GET"} ${input.pathname} failed: ${response.status} ${response.statusText}${bodyText ? ` - ${bodyText}` : ""}`,
      );
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof DiffxClientError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new DiffxClientError(
        `${input.method ?? "GET"} ${input.pathname} timed out after ${input.timeoutMs}ms`,
      );
    }
    throw new DiffxClientError(
      `${input.method ?? "GET"} ${input.pathname} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    cancel();
  }
}

export const getComments = async (
  sessionOrUrl: DiffxReviewSession | string,
  timeoutMs: number,
): Promise<DiffxReviewComment[]> => {
  const baseUrl =
    typeof sessionOrUrl === "string" ? sessionOrUrl : sessionOrUrl.url;
  return requestJson<DiffxReviewComment[]>({
    baseUrl,
    pathname: "/api/comments",
    timeoutMs,
  });
};

export const addReply = async (
  sessionOrUrl: DiffxReviewSession | string,
  commentId: string,
  body: string,
  timeoutMs: number,
): Promise<DiffxReviewComment> => {
  const baseUrl =
    typeof sessionOrUrl === "string" ? sessionOrUrl : sessionOrUrl.url;
  return requestJson<DiffxReviewComment>({
    baseUrl,
    pathname: `/api/comments/${encodeURIComponent(commentId)}/replies`,
    method: "POST",
    body: { body },
    timeoutMs,
  });
};

export const updateComment = async (
  sessionOrUrl: DiffxReviewSession | string,
  commentId: string,
  fields: { body?: string; status?: DiffxReviewComment["status"] },
  timeoutMs: number,
): Promise<DiffxReviewComment> => {
  const baseUrl =
    typeof sessionOrUrl === "string" ? sessionOrUrl : sessionOrUrl.url;
  return requestJson<DiffxReviewComment>({
    baseUrl,
    pathname: `/api/comments/${encodeURIComponent(commentId)}`,
    method: "PUT",
    body: fields,
    timeoutMs,
  });
};

export const resolveComment = async (
  sessionOrUrl: DiffxReviewSession | string,
  commentId: string,
  timeoutMs: number,
): Promise<DiffxReviewComment> =>
  updateComment(sessionOrUrl, commentId, { status: "resolved" }, timeoutMs);

export const getCommentStats = (
  comments: DiffxReviewComment[],
): DiffxCommentStats => {
  let open = 0;
  let resolved = 0;

  for (const comment of comments) {
    if (comment.status === "resolved") {
      resolved += 1;
    } else {
      open += 1;
    }
  }

  return {
    total: comments.length,
    open,
    resolved,
  };
};
