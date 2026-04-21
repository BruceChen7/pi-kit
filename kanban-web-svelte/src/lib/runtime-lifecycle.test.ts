import { describe, expect, it } from "vitest";

import type { BoardSnapshot, ChildLifecycleEvent } from "./types";
import { deriveChildLifecycleReaction } from "./runtime-lifecycle";

const board: BoardSnapshot = {
  path: "workitems/features.kanban.md",
  errors: [],
  lanes: [
    { name: "Inbox", cards: [] },
    { name: "Spec", cards: [] },
    { name: "Ready", cards: [] },
    {
      name: "In Progress",
      cards: [
        {
          id: "C-1",
          title: "Child active",
          kind: "child",
          parentId: "F-1",
          lane: "In Progress",
          lineNumber: 1,
          depth: 1,
        },
      ],
    },
    { name: "Review", cards: [] },
    { name: "Done", cards: [] },
  ],
  cards: [
    {
      id: "F-1",
      title: "Feature one",
      kind: "feature",
      parentId: null,
      lane: "Spec",
      lineNumber: 1,
      depth: 0,
    },
    {
      id: "C-1",
      title: "Child active",
      kind: "child",
      parentId: "F-1",
      lane: "In Progress",
      lineNumber: 2,
      depth: 1,
    },
  ],
};

function makeEvent(type: ChildLifecycleEvent["type"]): ChildLifecycleEvent {
  return {
    type,
    cardId: "C-1",
    summary: type,
    ts: "2026-04-20T00:00:00.000Z",
  };
}

describe("runtime lifecycle", () => {
  it("focuses terminal on child-running", () => {
    expect(deriveChildLifecycleReaction(board, makeEvent("child-running"))).toEqual({
      focusChildId: "C-1",
      nextTab: "terminal",
      targetLane: null,
    });
  });

  it("moves child to review only on child-completed", () => {
    expect(deriveChildLifecycleReaction(board, makeEvent("child-completed"))).toEqual({
      focusChildId: "C-1",
      nextTab: "handoff",
      targetLane: "Review",
    });
  });

  it("switches to logs on child-failed", () => {
    expect(deriveChildLifecycleReaction(board, makeEvent("child-failed"))).toEqual({
      focusChildId: "C-1",
      nextTab: "logs",
      targetLane: null,
    });
  });
});
