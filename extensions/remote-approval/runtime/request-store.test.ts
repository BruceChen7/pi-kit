import { describe, expect, it } from "vitest";

import { createRequestStore } from "./request-store.ts";

describe("remote-approval request store", () => {
  it("creates pending approval requests", () => {
    const store = createRequestStore(() => 1000);

    const request = store.create({
      requestId: "apr_1",
      kind: "approval",
      sessionId: "session-1",
      sessionLabel: "repo · session-1",
      toolName: "bash",
      toolInputPreview: "rm -rf tmp",
      contextPreview: ["preview"],
      fullContextAvailable: true,
    });

    expect(request).toMatchObject({
      requestId: "apr_1",
      kind: "approval",
      sessionId: "session-1",
      status: "pending",
      createdAt: 1000,
    });
    expect(store.get("apr_1")).toEqual(request);
  });

  it("resolves exactly once and ignores late outcomes", () => {
    const store = createRequestStore(() => 1000);
    store.create({
      requestId: "apr_1",
      kind: "approval",
      sessionId: "session-1",
      sessionLabel: "repo · session-1",
      fullContextAvailable: false,
      contextPreview: [],
    });

    const first = store.resolve("apr_1", "approved", "local");
    const second = store.resolve("apr_1", "denied", "remote");

    expect(first.applied).toBe(true);
    expect(first.request?.status).toBe("approved");
    expect(first.request?.resolutionSource).toBe("local");
    expect(second.applied).toBe(false);
    expect(second.request?.status).toBe("approved");
    expect(second.request?.resolutionSource).toBe("local");
  });

  it("supersedes the previous pending idle request for the same session", () => {
    const store = createRequestStore(() => 1000);
    const first = store.create({
      requestId: "idle_1",
      kind: "idle_continue",
      sessionId: "session-1",
      sessionLabel: "repo · session-1",
      fullContextAvailable: false,
      contextPreview: [],
    });

    const second = store.create({
      requestId: "idle_2",
      kind: "idle_continue",
      sessionId: "session-1",
      sessionLabel: "repo · session-1",
      fullContextAvailable: true,
      contextPreview: ["latest"],
    });

    expect(first.status).toBe("superseded");
    expect(first.resolutionSource).toBe("system");
    expect(second.status).toBe("pending");
    expect(store.get("idle_1")?.status).toBe("superseded");
    expect(store.getLatestPendingIdleRequest("session-1")?.requestId).toBe(
      "idle_2",
    );
  });
});
