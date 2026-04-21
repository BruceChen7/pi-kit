import { describe, expect, it } from "vitest";

import type { ActionState, BoardSnapshot } from "./types";
import {
  deriveFeatureOverview,
  deriveOverviewActionTargets,
  deriveSelectionState,
  deriveVisibleActionLog,
} from "./board-view-model";

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
      name: "In Progress",
      cards: [
        {
          id: "C-1",
          title: "Child running",
          kind: "child",
          parentId: "F-1",
          lane: "In Progress",
          lineNumber: 2,
          depth: 1,
        },
      ],
    },
    {
      name: "Review",
      cards: [
        {
          id: "C-2",
          title: "Child review",
          kind: "child",
          parentId: "F-1",
          lane: "Review",
          lineNumber: 3,
          depth: 1,
        },
      ],
    },
    {
      name: "Ready",
      cards: [
        {
          id: "C-3",
          title: "Child blocked",
          kind: "child",
          parentId: "F-1",
          lane: "Ready",
          lineNumber: 4,
          depth: 1,
        },
      ],
    },
    {
      name: "Done",
      cards: [
        {
          id: "F-2",
          title: "Feature two",
          kind: "feature",
          parentId: null,
          lane: "Done",
          lineNumber: 5,
          depth: 0,
        },
      ],
    },
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
      title: "Child running",
      kind: "child",
      parentId: "F-1",
      lane: "In Progress",
      lineNumber: 2,
      depth: 1,
    },
    {
      id: "C-2",
      title: "Child review",
      kind: "child",
      parentId: "F-1",
      lane: "Review",
      lineNumber: 3,
      depth: 1,
    },
    {
      id: "C-3",
      title: "Child blocked",
      kind: "child",
      parentId: "F-1",
      lane: "Ready",
      lineNumber: 4,
      depth: 1,
    },
    {
      id: "F-2",
      title: "Feature two",
      kind: "feature",
      parentId: null,
      lane: "Done",
      lineNumber: 5,
      depth: 0,
    },
  ],
};

const actionLog: ActionState[] = [
  {
    requestId: "r3",
    action: "apply",
    cardId: "C-3",
    worktreeKey: "C-3",
    status: "failed",
    summary: "blocked by missing dependency",
    startedAt: null,
    finishedAt: null,
    durationMs: null,
  },
  {
    requestId: "r2",
    action: "apply",
    cardId: "C-2",
    worktreeKey: "C-2",
    status: "success",
    summary: "ready for review",
    startedAt: null,
    finishedAt: null,
    durationMs: null,
  },
  {
    requestId: "r1",
    action: "apply",
    cardId: "C-1",
    worktreeKey: "C-1",
    status: "running",
    summary: "executing child",
    startedAt: null,
    finishedAt: null,
    durationMs: null,
  },
];

describe("board view model", () => {
  it("selects a parent feature when a child is selected", () => {
    expect(
      deriveSelectionState(board, {
        selectedFeatureId: null,
        selectedChildId: "C-2",
      }),
    ).toEqual({
      selectedFeatureId: "F-1",
      selectedChildId: "C-2",
    });
  });

  it("clears stale child selection while keeping a valid feature selection", () => {
    expect(
      deriveSelectionState(board, {
        selectedFeatureId: "F-1",
        selectedChildId: "missing-child",
      }),
    ).toEqual({
      selectedFeatureId: "F-1",
      selectedChildId: null,
    });
  });

  it("derives feature overview counts and recent action from current board state", () => {
    expect(
      deriveFeatureOverview(board, "F-1", {
        latestStatusByCard: {
          "C-3": actionLog[0],
        },
        actionLog,
      }),
    ).toMatchObject({
      runningCount: 1,
      reviewCount: 1,
      blockedCount: 1,
      recentAction: actionLog[0],
      childIds: ["C-1", "C-2", "C-3"],
    });
  });

  it("filters inspector logs to the selected child before falling back to feature scope", () => {
    expect(deriveVisibleActionLog(actionLog, board, "F-1", "C-2")).toEqual([
      actionLog[1],
    ]);

    expect(deriveVisibleActionLog(actionLog, board, "F-1", null)).toEqual(
      actionLog,
    );
  });

  it("derives overview action targets for running, review, blocked, and ready cards", () => {
    expect(
      deriveOverviewActionTargets(
        board.cards.filter((card) => card.parentId === "F-1"),
        {
          "C-3": actionLog[0],
        },
      ),
    ).toEqual({
      runningChildId: "C-1",
      reviewChildId: "C-2",
      blockedChildId: "C-3",
      dispatchChildId: "C-3",
    });
  });
});
