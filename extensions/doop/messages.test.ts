import { describe, expect, it } from "vitest";
import {
  drainPending,
  formatWake,
  pendingFromMessage,
  pushPending,
} from "./messages.js";

const comment = (overrides: Record<string, unknown> = {}) => ({
  type: "comment",
  comment: {
    id: "c1",
    text: "make the CTA solid",
    from: "rich",
    at: 1,
    frameId: "f1",
    ...overrides,
  },
});

describe("pendingFromMessage", () => {
  it("queues a root comment from someone else", () => {
    expect(pendingFromMessage(comment(), "pi")).toEqual({
      kind: "comment",
      id: "c1",
      from: "rich",
      text: "make the CTA solid",
      frameId: "f1",
    });
  });

  it("ignores this agent's own comment, whatever the case", () => {
    expect(pendingFromMessage(comment({ from: "Pi" }), "pi")).toBeUndefined();
    expect(pendingFromMessage(comment({ from: "PI" }), "pi")).toBeUndefined();
  });

  it("ignores a resolved thread so finishing a job cannot start another", () => {
    expect(
      pendingFromMessage(comment({ resolvedAt: 99 }), "pi"),
    ).toBeUndefined();
  });

  it("ignores a reply: the worklist folds replies into their root", () => {
    expect(
      pendingFromMessage(comment({ parentId: "root" }), "pi"),
    ).toBeUndefined();
  });

  it("drops a comment without an id, author or text", () => {
    expect(pendingFromMessage(comment({ id: "" }), "pi")).toBeUndefined();
    expect(pendingFromMessage(comment({ text: "  " }), "pi")).toBeUndefined();
    expect(pendingFromMessage(comment({ from: "" }), "pi")).toBeUndefined();
  });

  it("queues task feedback", () => {
    expect(
      pendingFromMessage(
        {
          type: "feedback",
          feedback: { id: "f1", text: "use the brand blue" },
        },
        "pi",
      ),
    ).toEqual({ kind: "feedback", id: "f1", text: "use the brand blue" });
  });

  it("queues an unclaimed canvas card by its title", () => {
    expect(
      pendingFromMessage(
        { type: "task", task: { id: "t1", title: "Sketch a login screen" } },
        "pi",
      ),
    ).toEqual({ kind: "card", id: "t1", prompt: "Sketch a login screen" });
  });

  it("ignores a card another agent claimed or one that ended", () => {
    expect(
      pendingFromMessage(
        { type: "task", task: { id: "t1", title: "x", agentName: "doop" } },
        "pi",
      ),
    ).toBeUndefined();
    expect(
      pendingFromMessage(
        { type: "task", task: { id: "t1", title: "x", endedAt: 5 } },
        "pi",
      ),
    ).toBeUndefined();
  });

  it("ignores frames that are not about work", () => {
    expect(pendingFromMessage({ type: "init" }, "pi")).toBeUndefined();
    expect(pendingFromMessage({ type: "presence:join" }, "pi")).toBeUndefined();
    expect(pendingFromMessage("nonsense", "pi")).toBeUndefined();
    expect(pendingFromMessage(null, "pi")).toBeUndefined();
  });
});

describe("pushPending", () => {
  it("keeps one entry per kind:id so a replayed frame is a no-op", () => {
    const first = pushPending([], {
      kind: "comment",
      id: "c1",
      from: "rich",
      text: "a",
    });
    const twice = pushPending(first, {
      kind: "comment",
      id: "c1",
      from: "rich",
      text: "a",
    });
    expect(twice).toHaveLength(1);
  });

  it("keeps a comment and a card with the same id apart", () => {
    const withComment = pushPending([], {
      kind: "comment",
      id: "x",
      from: "rich",
      text: "a",
    });
    expect(
      pushPending(withComment, { kind: "card", id: "x", prompt: "b" }),
    ).toHaveLength(2);
  });
});

describe("drainPending", () => {
  it("returns everything and leaves an empty queue", () => {
    const queue = pushPending([], { kind: "card", id: "t1", prompt: "a" });
    const { items, rest } = drainPending(queue);
    expect(items).toHaveLength(1);
    expect(rest).toEqual([]);
  });
});

describe("formatWake", () => {
  it("names the canvas, the count and the closing steps", () => {
    const text = formatWake(
      [
        {
          kind: "comment",
          id: "c1",
          from: "rich",
          text: "solid CTA",
          frameId: "f1",
        },
        { kind: "card", id: "t1", prompt: "sketch login" },
      ],
      "U43rjP-JxT",
    );
    expect(text).toContain("U43rjP-JxT");
    expect(text).toContain("2 items");
    expect(text).toContain("comment c1 on frame f1");
    expect(text).toContain("reply_to_comment");
    expect(text).toContain("resolve_comment");
  });

  it("says nothing to do for an empty queue", () => {
    expect(formatWake([], "U43rjP-JxT")).toContain("nothing to do");
  });

  it("clips a long comment instead of pasting a wall", () => {
    const text = formatWake(
      [{ kind: "comment", id: "c1", from: "rich", text: "x".repeat(500) }],
      "c",
    );
    expect(text).toContain("…");
    expect(text).not.toContain("x".repeat(400));
  });
});
