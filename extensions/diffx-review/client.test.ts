import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addReply,
  DiffxClientError,
  getCommentStats,
  getComments,
  resolveComment,
} from "./client.ts";
import type { DiffxReviewComment } from "./types.ts";

const sampleComments: DiffxReviewComment[] = [
  {
    id: "c1",
    filePath: "src/a.ts",
    side: "additions",
    lineNumber: 10,
    lineContent: "+ const value = 1",
    body: "rename this",
    status: "open",
    createdAt: 1,
    replies: [],
  },
  {
    id: "c2",
    filePath: "src/b.ts",
    side: "deletions",
    lineNumber: 20,
    lineContent: "- const value = 2",
    body: "keep this check",
    status: "resolved",
    createdAt: 2,
    replies: [],
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("diffx-review client", () => {
  it("fetches comments and computes stats", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(sampleComments), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const comments = await getComments("http://127.0.0.1:3433", 1000);
    expect(comments).toEqual(sampleComments);
    expect(getCommentStats(comments)).toEqual({
      total: 2,
      open: 1,
      resolved: 1,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3433/api/comments",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("posts replies and resolves comments", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ...sampleComments[0],
            replies: [{ id: "r1", body: "fixed", createdAt: 3 }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ...sampleComments[0],
            status: "resolved",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const replied = await addReply(
      "http://127.0.0.1:3433",
      "c1",
      "fixed",
      1000,
    );
    const resolved = await resolveComment("http://127.0.0.1:3433", "c1", 1000);

    expect(replied.replies).toHaveLength(1);
    expect(resolved.status).toBe("resolved");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:3433/api/comments/c1/replies",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:3433/api/comments/c1",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("surfaces non-2xx responses as client errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("boom", {
            status: 500,
            statusText: "Internal Server Error",
          }),
      ),
    );

    await expect(getComments("http://127.0.0.1:3433", 1000)).rejects.toThrow(
      DiffxClientError,
    );
  });
});
