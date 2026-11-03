import { describe, expect, it } from "vitest";
import {
  type DoopComment,
  formatWorklist,
  parseComments,
  summarize,
  toWorklist,
} from "./worklist.js";

function comment(overrides: Partial<DoopComment> = {}): DoopComment {
  return {
    id: "c1",
    text: "make the CTA solid",
    from: "rich",
    at: 1,
    frameId: "f1",
    elementId: "cta",
    html: '<button data-doop-id="cta">Book</button>',
    ...overrides,
  };
}

const build = (comments: DoopComment[], agentName = "pi") =>
  toWorklist({ canvasId: "U43rjP-JxT", comments, agentName });

describe("anchorOf", () => {
  it("prefers the element anchor when both ids are present", () => {
    const list = build([comment()]);
    expect(list.items[0]?.anchor).toEqual({
      kind: "element",
      frameId: "f1",
      elementId: "cta",
      html: '<button data-doop-id="cta">Book</button>',
    });
  });

  it("falls back to the frame when there is no element id", () => {
    const list = build([comment({ elementId: undefined, x: 40, y: 12 })]);
    expect(list.items[0]?.anchor).toEqual({
      kind: "frame",
      frameId: "f1",
      x: 40,
      y: 12,
    });
  });

  it("treats a point on the canvas as its own anchor", () => {
    const list = build([
      comment({
        frameId: undefined,
        elementId: undefined,
        pageId: "p1",
        x: 5,
        y: 6,
      }),
    ]);
    expect(list.items[0]?.anchor).toEqual({
      kind: "canvas",
      pageId: "p1",
      x: 5,
      y: 6,
    });
  });
});

describe("toWorklist", () => {
  it("drops resolved threads and counts them as skipped", () => {
    const list = build([
      comment({ id: "done", resolvedAt: 9 }),
      comment({ id: "open" }),
    ]);
    expect(list.items.map((item) => item.id)).toEqual(["open"]);
    expect(list.skipped).toBe(1);
  });

  it("folds replies into their root instead of listing them separately", () => {
    const list = build([
      comment({ id: "root", at: 1 }),
      comment({ id: "r1", parentId: "root", from: "sam", at: 2 }),
      comment({ id: "r2", parentId: "r1", from: "sam", at: 3 }),
    ]);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.replies).toBe(2);
    expect(list.items[0]?.text).toBe("make the CTA solid");
  });

  it("skips a thread the agent opened when no human replied", () => {
    const list = build([comment({ id: "mine", from: "pi" })]);
    expect(list.items).toEqual([]);
    expect(list.skipped).toBe(1);
  });

  it("keeps a thread the agent opened once a human replied to it", () => {
    const list = build([
      comment({ id: "mine", from: "pi", at: 1 }),
      comment({ id: "r1", parentId: "mine", from: "rich", at: 2 }),
    ]);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.replies).toBe(1);
  });

  it("does not count the agent's own replies in the reply count", () => {
    const list = build([
      comment({ id: "root", at: 1 }),
      comment({ id: "r1", parentId: "root", from: "pi", at: 2 }),
    ]);
    expect(list.items[0]?.replies).toBe(0);
  });

  it("orders oldest first so old requests clear before new ones", () => {
    const list = build([
      comment({ id: "new", at: 30 }),
      comment({ id: "old", at: 10 }),
      comment({ id: "mid", at: 20 }),
    ]);
    expect(list.items.map((item) => item.id)).toEqual(["old", "mid", "new"]);
  });

  it("keeps one item per id when the log repeats one", () => {
    const list = build([
      comment({ id: "dup", at: 1 }),
      comment({ id: "dup", at: 5 }),
    ]);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.at).toBe(1);
  });

  it("skips a comment with no usable anchor", () => {
    const list = build([comment({ frameId: undefined, elementId: undefined })]);
    expect(list.items).toEqual([]);
    expect(list.skipped).toBe(1);
  });

  it("ignores a reply whose root fell out of the window", () => {
    const list = build([comment({ id: "r1", parentId: "gone" })]);
    expect(list.items).toEqual([]);
    expect(list.skipped).toBe(0);
  });

  it("carries the @mention target when a human aimed the comment at a role", () => {
    const list = build([
      comment({ forAgent: true, targetAgent: "Accessibility" }),
    ]);
    expect(list.items[0]?.forAgent).toBe(true);
    expect(list.items[0]?.targetAgent).toBe("Accessibility");
  });

  it("returns an empty list for an empty canvas", () => {
    expect(build([])).toEqual({
      canvasId: "U43rjP-JxT",
      items: [],
      skipped: 0,
    });
  });
});

describe("parseComments", () => {
  it("rejects a payload that is not an array", () => {
    const parsed = parseComments({ nope: true });
    expect(parsed).toEqual({
      ok: false,
      detail: "get_comments did not return an array",
    });
  });

  it("drops entries missing the fields the worklist needs", () => {
    const parsed = parseComments([
      { id: "ok", text: "t", from: "rich", at: 1, frameId: "f1" },
      { id: "no-text", from: "rich", at: 2 },
      "not an object",
      { id: "no-at", text: "t", from: "rich" },
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.comments.map((c) => c.id)).toEqual(["ok"]);
  });

  it("fails when every entry is malformed", () => {
    const parsed = parseComments([{ id: 1 }, null]);
    expect(parsed).toEqual({
      ok: false,
      detail: "all 2 comments were malformed",
    });
  });
});

describe("formatWorklist", () => {
  it("says there is nothing to do without inventing work", () => {
    const text = formatWorklist(build([comment({ resolvedAt: 3 })]), "pi");
    expect(text).toContain("0 open comments");
    expect(text).toContain("1 skipped");
    expect(text).toContain("Nothing to do");
  });

  it("names the comment, its anchor and the element html", () => {
    const text = formatWorklist(build([comment()]), "pi");
    expect(text).toContain("comment c1");
    expect(text).toContain("element cta in frame f1");
    expect(text).toContain("anchor html:");
    expect(text).toContain('agent_name "pi"');
  });

  it("clips long text instead of pasting a wall of it", () => {
    const text = formatWorklist(
      build([comment({ text: "x".repeat(500) })]),
      "pi",
    );
    expect(text).toContain("…");
    expect(text).not.toContain("x".repeat(300));
  });

  it("summarizes open and skipped counts for the footer", () => {
    expect(
      summarize(build([comment(), comment({ id: "done", resolvedAt: 1 })])),
    ).toBe("1 open · 1 skipped");
  });
});
