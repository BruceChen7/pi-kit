import type { BoardSnapshot, ChildLifecycleEvent } from "./types";
import type { InspectorTab } from "./ui-types";
import type { BoardLane } from "./types";

export type ChildLifecycleReaction = {
  focusChildId: string | null;
  nextTab: InspectorTab | null;
  targetLane: BoardLane | null;
};

export function deriveChildLifecycleReaction(
  board: BoardSnapshot | null,
  event: ChildLifecycleEvent,
): ChildLifecycleReaction {
  if (!board) {
    return {
      focusChildId: null,
      nextTab: null,
      targetLane: null,
    };
  }

  const card = board.cards.find((entry) => entry.id === event.cardId) ?? null;
  if (!card || card.kind !== "child") {
    return {
      focusChildId: null,
      nextTab: null,
      targetLane: null,
    };
  }

  if (event.type === "child-running") {
    return {
      focusChildId: card.id,
      nextTab: "terminal",
      targetLane: null,
    };
  }

  if (event.type === "child-completed") {
    return {
      focusChildId: card.id,
      nextTab: "handoff",
      targetLane: "Review",
    };
  }

  return {
    focusChildId: card.id,
    nextTab: "logs",
    targetLane: null,
  };
}
