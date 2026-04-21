import type { BoardCard, BoardSnapshot } from "./types";

const INBOX_LANE = "Inbox";

export function addFeatureCard(
  board: BoardSnapshot,
  title: string,
): { board: BoardSnapshot; card: BoardCard } {
  const normalizedTitle = normalizeTitle(title);
  const card: BoardCard = {
    id: buildUniqueId(board, "feature", normalizedTitle),
    title: normalizedTitle,
    kind: "feature",
    parentId: null,
    lane: INBOX_LANE,
    lineNumber: nextLineNumber(board),
    depth: 0,
  };

  return {
    card,
    board: appendCard(board, card),
  };
}

export function addChildCard(
  board: BoardSnapshot,
  featureId: string,
  title: string,
): { board: BoardSnapshot; card: BoardCard } {
  const feature = board.cards.find(
    (card) => card.kind === "feature" && card.id === featureId,
  );
  if (!feature) {
    throw new Error("Select a feature before adding a child.");
  }

  const normalizedTitle = normalizeTitle(title);
  const card: BoardCard = {
    id: buildUniqueId(board, "child", normalizedTitle),
    title: normalizedTitle,
    kind: "child",
    parentId: feature.id,
    lane: INBOX_LANE,
    lineNumber: nextLineNumber(board),
    depth: 1,
  };

  return {
    card,
    board: appendCard(board, card),
  };
}

function normalizeTitle(title: string): string {
  const normalized = title.trim();
  if (!normalized) {
    throw new Error("Title is required");
  }

  return normalized;
}

function buildUniqueId(
  board: BoardSnapshot,
  prefix: "feature" | "child",
  title: string,
): string {
  const baseSlug = slugify(title);
  let candidate = `${prefix}-${baseSlug}`;
  let suffix = 2;

  while (board.cards.some((card) => card.id === candidate)) {
    candidate = `${prefix}-${baseSlug}-${suffix}`;
    suffix += 1;
  }

  return candidate;
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "card";
}

function nextLineNumber(board: BoardSnapshot): number {
  return Math.max(0, ...board.cards.map((card) => card.lineNumber)) + 1;
}

function appendCard(board: BoardSnapshot, card: BoardCard): BoardSnapshot {
  let laneFound = false;
  const nextLanes = board.lanes.map((lane) => {
    if (lane.name !== INBOX_LANE) {
      return lane;
    }

    laneFound = true;
    return {
      ...lane,
      cards: [...lane.cards, card],
    };
  });

  if (!laneFound) {
    throw new Error("Inbox lane is required");
  }

  return {
    ...board,
    cards: [...board.cards, card],
    lanes: nextLanes,
  };
}
