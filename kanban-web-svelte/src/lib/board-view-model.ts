import type { ActionState, BoardCard, BoardSnapshot } from "./types";

export type SelectionState = {
  selectedFeatureId: string | null;
  selectedChildId: string | null;
};

export type FeatureOverview = {
  feature: BoardCard | null;
  children: BoardCard[];
  childIds: string[];
  runningCount: number;
  reviewCount: number;
  blockedCount: number;
  recentAction: ActionState | null;
};

export type OverviewActionTargets = {
  runningChildId: string | null;
  reviewChildId: string | null;
  blockedChildId: string | null;
  dispatchChildId: string | null;
};

export function deriveSelectionState(
  board: BoardSnapshot | null,
  selection: SelectionState,
): SelectionState {
  if (!board) {
    return {
      selectedFeatureId: null,
      selectedChildId: null,
    };
  }

  const cardById = new Map(board.cards.map((card) => [card.id, card]));
  const selectedChild = selection.selectedChildId
    ? cardById.get(selection.selectedChildId) ?? null
    : null;
  const selectedFeature = selection.selectedFeatureId
    ? cardById.get(selection.selectedFeatureId) ?? null
    : null;

  if (selectedChild?.kind === "child") {
    return {
      selectedFeatureId: selectedChild.parentId,
      selectedChildId: selectedChild.id,
    };
  }

  if (selectedFeature?.kind === "feature") {
    return {
      selectedFeatureId: selectedFeature.id,
      selectedChildId: null,
    };
  }

  return {
    selectedFeatureId: null,
    selectedChildId: null,
  };
}

export function deriveFeatureOverview(
  board: BoardSnapshot | null,
  selectedFeatureId: string | null,
  input: {
    latestStatusByCard: Record<string, ActionState>;
    actionLog: ActionState[];
  },
): FeatureOverview {
  if (!board || !selectedFeatureId) {
    return emptyFeatureOverview();
  }

  const feature =
    board.cards.find(
      (card) => card.id === selectedFeatureId && card.kind === "feature",
    ) ?? null;

  if (!feature) {
    return emptyFeatureOverview();
  }

  const children = board.cards.filter(
    (card) => card.kind === "child" && card.parentId === selectedFeatureId,
  );
  const childIds = children.map((card) => card.id);
  const childIdSet = new Set(childIds);
  const recentAction =
    input.actionLog.find((entry) => childIdSet.has(entry.cardId)) ?? null;

  return {
    feature,
    children,
    childIds,
    runningCount: children.filter((card) => card.lane === "In Progress").length,
    reviewCount: children.filter((card) => card.lane === "Review").length,
    blockedCount: children.filter(
      (card) => input.latestStatusByCard[card.id]?.status === "failed",
    ).length,
    recentAction,
  };
}

export function deriveOverviewActionTargets(
  children: BoardCard[],
  latestStatusByCard: Record<string, ActionState>,
): OverviewActionTargets {
  return {
    runningChildId:
      children.find((card) => card.lane === "In Progress")?.id ?? null,
    reviewChildId: children.find((card) => card.lane === "Review")?.id ?? null,
    blockedChildId:
      children.find((card) => latestStatusByCard[card.id]?.status === "failed")
        ?.id ?? null,
    dispatchChildId: children.find((card) => card.lane === "Ready")?.id ?? null,
  };
}

export function deriveVisibleActionLog(
  actionLog: ActionState[],
  board: BoardSnapshot | null,
  selectedFeatureId: string | null,
  selectedChildId: string | null,
): ActionState[] {
  if (selectedChildId) {
    return actionLog.filter((entry) => entry.cardId === selectedChildId);
  }

  if (!board || !selectedFeatureId) {
    return actionLog;
  }

  const childIds = new Set(
    board.cards
      .filter(
        (card) => card.kind === "child" && card.parentId === selectedFeatureId,
      )
      .map((card) => card.id),
  );

  return actionLog.filter((entry) => childIds.has(entry.cardId));
}

function emptyFeatureOverview(): FeatureOverview {
  return {
    feature: null,
    children: [],
    childIds: [],
    runningCount: 0,
    reviewCount: 0,
    blockedCount: 0,
    recentAction: null,
  };
}
