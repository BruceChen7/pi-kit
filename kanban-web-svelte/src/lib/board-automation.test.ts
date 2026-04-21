import { describe, expect, it } from "vitest";
import {
  applyLaneTransition,
  deriveAutoDispatchCardIds,
  deriveAutomationReaction,
  serializeBoardSnapshot,
} from "./board-automation";
import type { ActionState, BoardSnapshot } from "./types";

const board: BoardSnapshot = {
  path: "workitems/features.kanban.md",
  errors: [],
  lanes: [
    {
      name: "Spec",
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
      ],
    },
    {
      name: "Ready",
      cards: [
        {
          id: "C-1",
          title: "Child ready",
          kind: "child",
          parentId: "F-1",
          lane: "Ready",
          lineNumber: 2,
          depth: 1,
        },
      ],
    },
    {
      name: "In Progress",
      cards: [
        {
          id: "C-2",
          title: "Child active",
          kind: "child",
          parentId: "F-1",
          lane: "In Progress",
          lineNumber: 3,
          depth: 1,
        },
      ],
    },
    {
      name: "Review",
      cards: [
        {
          id: "C-3",
          title: "Child review",
          kind: "child",
          parentId: "F-1",
          lane: "Review",
          lineNumber: 4,
          depth: 1,
        },
      ],
    },
    { name: "Inbox", cards: [] },
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
      title: "Child ready",
      kind: "child",
      parentId: "F-1",
      lane: "Ready",
      lineNumber: 2,
      depth: 1,
    },
    {
      id: "C-2",
      title: "Child active",
      kind: "child",
      parentId: "F-1",
      lane: "In Progress",
      lineNumber: 3,
      depth: 1,
    },
    {
      id: "C-3",
      title: "Child review",
      kind: "child",
      parentId: "F-1",
      lane: "Review",
      lineNumber: 4,
      depth: 1,
    },
  ],
};

describe("board automation", () => {
  it("serializes feature-first board text with repeated lane sections for cross-lane children", () => {
    expect(serializeBoardSnapshot(board)).toBe(
      [
        "## Spec",
        "",
        "- [ ] Feature one <!-- card-id: F-1; kind: feature -->",
        "",
        "## Ready",
        "",
        "  - [ ] Child ready <!-- card-id: C-1; kind: child; parent: F-1 -->",
        "",
        "## In Progress",
        "",
        "  - [ ] Child active <!-- card-id: C-2; kind: child; parent: F-1 -->",
        "",
        "## Review",
        "",
        "  - [ ] Child review <!-- card-id: C-3; kind: child; parent: F-1 -->",
      ].join("\n"),
    );
  });

  it("moves a child card to a new lane and rebuilds lane buckets", () => {
    const next = applyLaneTransition(board, {
      cardId: "C-1",
      targetLane: "In Progress",
    });

    expect(next.cards.find((card) => card.id === "C-1")?.lane).toBe(
      "In Progress",
    );
    expect(next.lanes.find((lane) => lane.name === "Ready")?.cards).toEqual([]);
    expect(
      next.lanes
        .find((lane) => lane.name === "In Progress")
        ?.cards.map((card) => card.id),
    ).toEqual(["C-1", "C-2"]);
  });

  it("detects children that newly entered in progress or lack an action state", () => {
    const previous = applyLaneTransition(board, {
      cardId: "C-1",
      targetLane: "Ready",
    });
    const current = applyLaneTransition(board, {
      cardId: "C-1",
      targetLane: "In Progress",
    });

    expect(
      deriveAutoDispatchCardIds(previous, current, {
        "C-2": {
          requestId: "req-running",
          action: "apply",
          cardId: "C-2",
          worktreeKey: "C-2",
          status: "running",
          summary: "running",
          startedAt: null,
          finishedAt: null,
          durationMs: null,
        },
      }),
    ).toEqual(["C-1"]);
  });

  it("reacts to running, success, and failed child action states", () => {
    const running: ActionState = {
      requestId: "req-1",
      action: "apply",
      cardId: "C-2",
      worktreeKey: "C-2",
      status: "running",
      summary: "running",
      startedAt: null,
      finishedAt: null,
      durationMs: null,
    };
    const success: ActionState = {
      ...running,
      requestId: "req-2",
      status: "success",
      summary: "completed",
    };
    const failed: ActionState = {
      ...running,
      requestId: "req-3",
      status: "failed",
      summary: "boom",
    };

    expect(deriveAutomationReaction(board, running)).toEqual({
      focusChildId: "C-2",
      nextTab: "terminal",
      targetLane: null,
    });
    expect(deriveAutomationReaction(board, success)).toEqual({
      focusChildId: "C-2",
      nextTab: null,
      targetLane: null,
    });
    expect(deriveAutomationReaction(board, failed)).toEqual({
      focusChildId: "C-2",
      nextTab: "logs",
      targetLane: null,
    });
  });
});
