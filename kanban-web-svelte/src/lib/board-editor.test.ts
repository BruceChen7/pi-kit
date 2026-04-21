import { describe, expect, it } from "vitest";

import { addChildCard, addFeatureCard } from "./board-editor";
import type { BoardSnapshot } from "./types";

function createBoard(cards: BoardSnapshot["cards"] = []): BoardSnapshot {
  return {
    path: ".pi/kanban/board.json",
    lanes: [
      {
        name: "Inbox",
        cards: cards.filter((card) => card.lane === "Inbox"),
      },
      {
        name: "In Progress",
        cards: cards.filter((card) => card.lane === "In Progress"),
      },
      {
        name: "Done",
        cards: cards.filter((card) => card.lane === "Done"),
      },
    ],
    cards,
    errors: [],
  };
}

describe("board-editor", () => {
  it("adds a feature to the end of the inbox with a readable id", () => {
    const board = createBoard();

    const result = addFeatureCard(board, "Login Flow");

    expect(result.card).toMatchObject({
      id: "feature-login-flow",
      title: "Login Flow",
      kind: "feature",
      parentId: null,
      lane: "Inbox",
      depth: 0,
      lineNumber: 1,
    });
    expect(result.board.cards).toEqual([result.card]);
    expect(result.board.lanes[0]?.cards).toEqual([result.card]);
  });

  it("adds a child under the selected feature and keeps the feature scope", () => {
    const feature = {
      id: "feature-login-flow",
      title: "Login Flow",
      kind: "feature" as const,
      parentId: null,
      lane: "Inbox" as const,
      lineNumber: 1,
      depth: 0 as const,
    };
    const board = createBoard([feature]);

    const result = addChildCard(board, "feature-login-flow", "Implement form");

    expect(result.card).toMatchObject({
      id: "child-implement-form",
      title: "Implement form",
      kind: "child",
      parentId: "feature-login-flow",
      lane: "Inbox",
      depth: 1,
      lineNumber: 2,
    });
    expect(result.board.cards).toEqual([feature, result.card]);
    expect(result.board.lanes[0]?.cards).toEqual([feature, result.card]);
  });

  it("deduplicates ids when the same title already exists", () => {
    const board = createBoard([
      {
        id: "feature-login-flow",
        title: "Login Flow",
        kind: "feature",
        parentId: null,
        lane: "Inbox",
        lineNumber: 1,
        depth: 0,
      },
    ]);

    const result = addFeatureCard(board, "Login Flow");

    expect(result.card.id).toBe("feature-login-flow-2");
  });

  it("rejects blank titles", () => {
    expect(() => addFeatureCard(createBoard(), "   ")).toThrow(
      "Title is required",
    );
  });

  it("rejects child creation when the parent feature is missing", () => {
    expect(() =>
      addChildCard(createBoard(), "feature-missing", "Implement form"),
    ).toThrow("Select a feature before adding a child.");
  });
});
