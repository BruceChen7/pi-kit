import { describe, expect, it, vi } from "vitest";

type EventHandler = (data: unknown) => void;

type FakeEvents = {
  on: (channel: string, handler: EventHandler) => void;
  emit: (channel: string, data: unknown) => void;
};

const createFakeEvents = () => {
  const handlers = new Map<string, EventHandler[]>();

  const events: FakeEvents = {
    on(channel, handler) {
      const list = handlers.get(channel) ?? [];
      list.push(handler);
      handlers.set(channel, list);
    },
    emit(channel, data) {
      for (const handler of handlers.get(channel) ?? []) {
        handler(data);
      }
    },
  };

  return { events, handlers };
};

describe("requestPlannotator", () => {
  it("resolves handled responses from the shared event channel", async () => {
    const { createRequestPlannotator } = await import("./plannotator-api.js");
    const { events } = createFakeEvents();

    events.on("plannotator:request", (data) => {
      const request = data as {
        action: string;
        payload: Record<string, unknown>;
        respond: (response: unknown) => void;
      };
      expect(request.action).toBe("code-review");
      expect(request.payload).toEqual({ cwd: "/repo" });
      request.respond({
        status: "handled",
        result: {
          approved: false,
          feedback: "Please add tests.",
        },
      });
    });

    const requestPlannotator = createRequestPlannotator(events, {
      timeoutMs: 50,
    });

    await expect(
      requestPlannotator("code-review", { cwd: "/repo" }),
    ).resolves.toEqual({
      status: "handled",
      result: {
        approved: false,
        feedback: "Please add tests.",
      },
    });
  });

  it("returns unavailable when no Plannotator listener responds before timeout", async () => {
    const { createRequestPlannotator } = await import("./plannotator-api.js");
    const { events } = createFakeEvents();
    const requestPlannotator = createRequestPlannotator(events, {
      timeoutMs: 10,
    });

    await expect(
      requestPlannotator("annotate", { filePath: "README.md" }),
    ).resolves.toEqual({
      status: "unavailable",
      error: "Plannotator request timed out.",
    });
  });
});

describe("createReviewResultStore", () => {
  it("tracks pending and completed plan review results", async () => {
    const { createReviewResultStore } = await import("./plannotator-api.js");
    const { events } = createFakeEvents();
    const store = createReviewResultStore(events);

    store.markPending("review-1");
    expect(store.getStatus("review-1")).toEqual({ status: "pending" });

    events.emit("plannotator:review-result", {
      reviewId: "review-1",
      approved: false,
      feedback: "Add a rollback plan.",
    });

    expect(store.getStatus("review-1")).toEqual({
      status: "completed",
      reviewId: "review-1",
      approved: false,
      feedback: "Add a rollback plan.",
    });
  });

  it("preserves annotations from async review-result events", async () => {
    const { createReviewResultStore } = await import("./plannotator-api.js");
    const { events } = createFakeEvents();
    const store = createReviewResultStore(events);
    const annotations = [{ file: "src/app.ts", line: 12, text: "Add a test." }];

    events.emit("plannotator:review-result", {
      reviewId: "review-annotations",
      approved: false,
      annotations,
    });

    expect(store.getStatus("review-annotations")).toEqual({
      status: "completed",
      reviewId: "review-annotations",
      approved: false,
      annotations,
    });
  });

  it("marks plan reviews pending when the shared API returns a reviewId", async () => {
    const {
      createRequestPlannotator,
      createReviewResultStore,
      startPlanReview,
    } = await import("./plannotator-api.js");
    const { events } = createFakeEvents();
    const store = createReviewResultStore(events);
    const requestPlannotator = createRequestPlannotator(events, {
      timeoutMs: 50,
    });

    events.on("plannotator:request", (data) => {
      const request = data as {
        action: string;
        respond: (response: unknown) => void;
      };
      expect(request.action).toBe("plan-review");
      request.respond({
        status: "handled",
        result: {
          status: "pending",
          reviewId: "review-3",
        },
      });
    });

    const response = await startPlanReview(requestPlannotator, store, {
      planContent: "# Plan",
    });

    expect(response).toEqual({
      status: "handled",
      result: {
        status: "pending",
        reviewId: "review-3",
      },
    });
    expect(store.getStatus("review-3")).toEqual({ status: "pending" });
  });

  it("marks code reviews pending when the shared API returns a reviewId", async () => {
    const {
      createRequestPlannotator,
      createReviewResultStore,
      startCodeReview,
    } = await import("./plannotator-api.js");
    const { events } = createFakeEvents();
    const store = createReviewResultStore(events);
    const requestPlannotator = createRequestPlannotator(events, {
      timeoutMs: 50,
    });

    events.on("plannotator:request", (data) => {
      const request = data as {
        action: string;
        respond: (response: unknown) => void;
      };
      expect(request.action).toBe("code-review");
      request.respond({
        status: "handled",
        result: {
          status: "pending",
          reviewId: "review-4",
        },
      });
    });

    const response = await startCodeReview(requestPlannotator, store, {
      cwd: "/repo",
    });

    expect(response).toEqual({
      status: "handled",
      result: {
        status: "pending",
        reviewId: "review-4",
      },
    });
    expect(store.getStatus("review-4")).toEqual({ status: "pending" });
  });

  it("notifies subscribers when a review result arrives", async () => {
    const { createReviewResultStore } = await import("./plannotator-api.js");
    const { events } = createFakeEvents();
    const store = createReviewResultStore(events);
    const listener = vi.fn();

    store.onResult(listener);
    events.emit("plannotator:review-result", {
      reviewId: "review-2",
      approved: true,
      feedback: "Ship it.",
    });

    expect(listener).toHaveBeenCalledWith({
      reviewId: "review-2",
      approved: true,
      feedback: "Ship it.",
    });
  });

  it("notifies subscribers with annotations from review results", async () => {
    const { createReviewResultStore } = await import("./plannotator-api.js");
    const { events } = createFakeEvents();
    const store = createReviewResultStore(events);
    const listener = vi.fn();
    const annotations = [{ file: "src/app.ts", line: 12, text: "Add a test." }];

    store.onResult(listener);
    events.emit("plannotator:review-result", {
      reviewId: "review-annotations",
      approved: false,
      annotations,
    });

    expect(listener).toHaveBeenCalledWith({
      reviewId: "review-annotations",
      approved: false,
      annotations,
    });
  });

  it("waits for a matching review result event", async () => {
    const { createReviewResultStore, waitForReviewResult } = await import(
      "./plannotator-api.js"
    );
    const { events } = createFakeEvents();
    const store = createReviewResultStore(events);

    const waitPromise = waitForReviewResult(store, "review-9");

    events.emit("plannotator:review-result", {
      reviewId: "review-8",
      approved: false,
      feedback: "Ignore this one.",
    });
    events.emit("plannotator:review-result", {
      reviewId: "review-9",
      approved: true,
      feedback: "Ship it.",
    });

    await expect(waitPromise).resolves.toEqual({
      status: "completed",
      reviewId: "review-9",
      approved: true,
      feedback: "Ship it.",
    });
  });
});

describe("review status requests", () => {
  it("queries review-status over the shared event channel", async () => {
    const { createRequestPlannotator, requestReviewStatus } = await import(
      "./plannotator-api.js"
    );
    const { events } = createFakeEvents();

    events.on("plannotator:request", (data) => {
      const request = data as {
        action: string;
        payload: Record<string, unknown>;
        respond: (response: unknown) => void;
      };
      expect(request.action).toBe("review-status");
      expect(request.payload).toEqual({ reviewId: "review-42" });
      request.respond({
        status: "handled",
        result: {
          status: "completed",
          reviewId: "review-42",
          approved: true,
          feedback: "Ship it.",
        },
      });
    });

    const requestPlannotator = createRequestPlannotator(events, {
      timeoutMs: 50,
    });

    await expect(
      requestReviewStatus(requestPlannotator, { reviewId: "review-42" }),
    ).resolves.toEqual({
      status: "handled",
      result: {
        status: "completed",
        reviewId: "review-42",
        approved: true,
        feedback: "Ship it.",
      },
    });
  });
});

describe("feedback formatting", () => {
  it("formats code review feedback for the coding agent", async () => {
    const { formatCodeReviewMessage } = await import("./plannotator-api.js");

    expect(
      formatCodeReviewMessage({
        approved: false,
        feedback: "Please add tests.",
      }),
    ).toBe("Please add tests.\n\nPlease address this feedback.");
  });

  it("formats plan review rejection feedback for the coding agent", async () => {
    const { formatPlanReviewMessage } = await import("./plannotator-api.js");

    expect(
      formatPlanReviewMessage({
        reviewId: "review-5",
        approved: false,
        feedback: "Split rollout and add rollback steps.",
      }),
    ).toBe(
      "Split rollout and add rollback steps.\n\nPlease revise the plan and resubmit for review.",
    );
  });

  it("formats annotation feedback with a file header", async () => {
    const { formatAnnotationMessage } = await import("./plannotator-api.js");

    expect(
      formatAnnotationMessage({
        filePath: "/repo/README.md",
        feedback: "Clarify the setup steps.",
      }),
    ).toBe(
      "# Markdown Annotations\n\nFile: /repo/README.md\n\nClarify the setup steps.\n\nPlease address the annotation feedback above.",
    );
  });

  it("formats annotation feedback when only inline annotations are returned", async () => {
    const { formatAnnotationMessage } = await import("./plannotator-api.js");

    expect(
      formatAnnotationMessage({
        filePath: "/repo/README.md",
        feedback: "",
        annotations: [{ id: "note-1" }],
      }),
    ).toBe(
      "# Markdown Annotations\n\nFile: /repo/README.md\n\nAnnotation completed with inline comments. Please address the annotation feedback above.",
    );
  });
});
