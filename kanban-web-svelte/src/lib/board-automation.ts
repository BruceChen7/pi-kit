import type { InspectorTab } from "./ui-types";
import type { ActionState, BoardCard, BoardLane, BoardSnapshot } from "./types";

export type AutomationReaction = {
  focusChildId: string | null;
  nextTab: InspectorTab | null;
  targetLane: BoardLane | null;
};

const LANE_ORDER: BoardLane[] = [
  "Inbox",
  "Spec",
  "Ready",
  "In Progress",
  "Review",
  "Done",
];

export function serializeBoardSnapshot(board: BoardSnapshot): string {
  const features = board.cards.filter((card) => card.kind === "feature");
  const lines: string[] = [];

  for (const feature of features) {
    pushLaneHeader(lines, feature.lane);
    lines.push(renderCard(feature));

    const children = board.cards.filter(
      (card) => card.kind === "child" && card.parentId === feature.id,
    );

    for (const child of children) {
      pushLaneHeader(lines, child.lane);
      lines.push(renderCard(child));
    }
  }

  return lines.join("\n");
}

export function applyLaneTransition(
  board: BoardSnapshot,
  input: {
    cardId: string;
    targetLane: BoardLane;
  },
): BoardSnapshot {
  const nextCards = board.cards.map((card) =>
    card.id === input.cardId ? { ...card, lane: input.targetLane } : card,
  );

  return {
    ...board,
    cards: nextCards,
    lanes: LANE_ORDER.map((lane) => ({
      name: lane,
      cards: nextCards.filter((card) => card.lane === lane),
    })),
  };
}

export function deriveAutoDispatchCardIds(
  previousBoard: BoardSnapshot | null,
  currentBoard: BoardSnapshot | null,
  latestStatusByCard: Record<string, ActionState>,
): string[] {
  if (!currentBoard) {
    return [];
  }

  const previousLaneByCard = new Map(
    previousBoard?.cards.map((card) => [card.id, card.lane]) ?? [],
  );

  return currentBoard.cards
    .filter((card) => card.kind === "child" && card.lane === "In Progress")
    .filter((card) => {
      const latest = latestStatusByCard[card.id];
      if (latest?.status === "queued" || latest?.status === "running") {
        return false;
      }

      const previousLane = previousLaneByCard.get(card.id) ?? null;
      return previousLane !== "In Progress" || !latest;
    })
    .map((card) => card.id);
}

export function deriveAutomationReaction(
  board: BoardSnapshot | null,
  state: ActionState,
): AutomationReaction {
  if (!board) {
    return {
      focusChildId: null,
      nextTab: null,
      targetLane: null,
    };
  }

  const card = board.cards.find((entry) => entry.id === state.cardId) ?? null;
  if (!card || card.kind !== "child") {
    return {
      focusChildId: null,
      nextTab: null,
      targetLane: null,
    };
  }

  if (state.status === "queued" || state.status === "running") {
    return {
      focusChildId: card.id,
      nextTab: "terminal",
      targetLane: null,
    };
  }

  if (state.status === "success") {
    return {
      focusChildId: card.id,
      nextTab: null,
      targetLane: null,
    };
  }

  if (state.status === "failed") {
    return {
      focusChildId: card.id,
      nextTab: "logs",
      targetLane: null,
    };
  }

  return {
    focusChildId: card.id,
    nextTab: null,
    targetLane: null,
  };
}

function renderCard(card: BoardCard): string {
  if (card.kind === "feature") {
    return `- [ ] ${card.title} <!-- card-id: ${card.id}; kind: feature -->`;
  }

  return `  - [ ] ${card.title} <!-- card-id: ${card.id}; kind: child; parent: ${card.parentId ?? ""} -->`;
}

function pushLaneHeader(lines: string[], lane: BoardLane): void {
  if (lines.length > 0) {
    lines.push("");
  }
  lines.push(`## ${lane}`);
  lines.push("");
}
