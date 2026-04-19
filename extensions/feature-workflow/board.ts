import fs from "node:fs";
import path from "node:path";

export const FEATURE_BOARD_RELATIVE_PATH = path.join(
  "workitems",
  "features.kanban.md",
);

export type FeatureBoardLane =
  | "Inbox"
  | "Spec"
  | "Ready"
  | "In Progress"
  | "Review"
  | "Done";

export type FeatureBoardCardKind = "feature" | "child";

export type FeatureBoardCard = {
  id: string;
  title: string;
  kind: FeatureBoardCardKind;
  parentId: string | null;
  lane: FeatureBoardLane;
  lineNumber: number;
  depth: 0 | 1;
};

export type FeatureBoard = {
  path: string;
  lanes: Array<{
    name: FeatureBoardLane;
    cards: FeatureBoardCard[];
  }>;
  cards: FeatureBoardCard[];
  errors: string[];
};

const LANE_NAMES: FeatureBoardLane[] = [
  "Inbox",
  "Spec",
  "Ready",
  "In Progress",
  "Review",
  "Done",
];

const ITEM_PATTERN = /^(\s*)- \[[ xX]\] (.*)$/;

function trimToNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseMetadata(raw: string): Record<string, string> {
  const metadata: Record<string, string> = {};
  const parts = raw.split(";");
  for (const part of parts) {
    const [keyRaw, ...rest] = part.split(":");
    const key = trimToNull(keyRaw)?.toLowerCase() ?? null;
    const value = trimToNull(rest.join(":"));
    if (!key || !value) continue;
    metadata[key] = value;
  }
  return metadata;
}

function normalizeLaneName(value: string): FeatureBoardLane | null {
  const trimmed = value.trim();
  return LANE_NAMES.find((lane) => lane === trimmed) ?? null;
}

function parseBoardItem(
  line: string,
): { indent: string; content: string } | null {
  const match = line.match(ITEM_PATTERN);
  if (!match) return null;
  return {
    indent: match[1] ?? "",
    content: match[2] ?? "",
  };
}

function readBoardTitleAndMetadata(content: string): {
  title: string;
  metadata: Record<string, string>;
} {
  const commentMatch = content.match(/<!--(.*?)-->\s*$/);
  if (!commentMatch) {
    return { title: content.trim(), metadata: {} };
  }

  const commentStart = commentMatch.index ?? content.length;
  const title = content.slice(0, commentStart).trim();
  const metadata = parseMetadata(commentMatch[1] ?? "");
  return { title, metadata };
}

export function getFeatureBoardPath(repoRoot: string): string {
  return path.join(repoRoot, FEATURE_BOARD_RELATIVE_PATH);
}

export function parseFeatureBoardFromText(
  text: string,
  boardPath: string = FEATURE_BOARD_RELATIVE_PATH,
): FeatureBoard {
  const lanes = new Map<FeatureBoardLane, FeatureBoardCard[]>();
  for (const lane of LANE_NAMES) {
    lanes.set(lane, []);
  }

  const cards: FeatureBoardCard[] = [];
  const errors: string[] = [];
  const lines = text.split(/\r?\n/);
  let currentLane: FeatureBoardLane | null = null;
  let currentParent: FeatureBoardCard | null = null;

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const laneMatch = line.match(/^##\s+(.+?)\s*$/);
    if (laneMatch) {
      const laneName = normalizeLaneName(laneMatch[1] ?? "");
      if (laneName) {
        currentLane = laneName;
      }
      return;
    }

    const parsedItem = parseBoardItem(line);
    if (!parsedItem) return;

    if (!currentLane) {
      errors.push(`Line ${lineNumber}: card appears outside a recognized lane`);
      return;
    }

    const depth = parsedItem.indent.length === 0 ? 0 : 1;
    if (parsedItem.indent.length !== 0 && parsedItem.indent.length !== 2) {
      errors.push(
        `Line ${lineNumber}: invalid indentation, expected 0 or 2 spaces`,
      );
      return;
    }

    const { title, metadata } = readBoardTitleAndMetadata(parsedItem.content);
    const id = trimToNull(metadata["card-id"]);
    const kind = trimToNull(metadata.kind) as FeatureBoardCardKind | null;
    const explicitParent = trimToNull(metadata.parent);

    if (!id) {
      errors.push(`Line ${lineNumber}: missing card-id metadata`);
      return;
    }
    if (!title) {
      errors.push(`Line ${lineNumber}: missing card title`);
      return;
    }
    if (kind !== "feature" && kind !== "child") {
      errors.push(`Line ${lineNumber}: invalid kind '${metadata.kind ?? ""}'`);
      return;
    }

    if (depth === 0 && kind !== "feature") {
      errors.push(`Line ${lineNumber}: top-level cards must be kind feature`);
      return;
    }
    if (depth === 1 && kind !== "child") {
      errors.push(`Line ${lineNumber}: nested cards must be kind child`);
      return;
    }

    if (depth === 0) {
      if (explicitParent) {
        errors.push(`Line ${lineNumber}: top-level feature cannot declare parent`);
        return;
      }
      const card: FeatureBoardCard = {
        id,
        title,
        kind,
        parentId: null,
        lane: currentLane,
        lineNumber,
        depth,
      };
      currentParent = card;
      cards.push(card);
      lanes.get(currentLane)?.push(card);
      return;
    }

    if (!currentParent) {
      errors.push(`Line ${lineNumber}: child card appears before any parent feature`);
      return;
    }
    if (!explicitParent) {
      errors.push(`Line ${lineNumber}: child card missing parent metadata`);
      return;
    }
    if (explicitParent !== currentParent.id) {
      errors.push(
        `Line ${lineNumber}: child parent '${explicitParent}' does not match current feature '${currentParent.id}'`,
      );
      return;
    }

    const childCard: FeatureBoardCard = {
      id,
      title,
      kind,
      parentId: explicitParent,
      lane: currentLane,
      lineNumber,
      depth,
    };
    cards.push(childCard);
    lanes.get(currentLane)?.push(childCard);
  });

  const seenIds = new Set<string>();
  for (const card of cards) {
    if (seenIds.has(card.id)) {
      errors.push(`Duplicate card-id '${card.id}'`);
      continue;
    }
    seenIds.add(card.id);
  }

  return {
    path: boardPath,
    lanes: LANE_NAMES.map((lane) => ({ name: lane, cards: lanes.get(lane) ?? [] })),
    cards,
    errors,
  };
}

export function readFeatureBoard(repoRoot: string): FeatureBoard {
  const boardPath = getFeatureBoardPath(repoRoot);
  if (!fs.existsSync(boardPath)) {
    return {
      path: boardPath,
      lanes: LANE_NAMES.map((lane) => ({ name: lane, cards: [] })),
      cards: [],
      errors: [`Board file not found: ${FEATURE_BOARD_RELATIVE_PATH}`],
    };
  }

  const text = fs.readFileSync(boardPath, "utf-8");
  return parseFeatureBoardFromText(text, boardPath);
}

export function findFeatureBoardCard(
  board: FeatureBoard,
  query: string,
): FeatureBoardCard | null {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const byId = board.cards.find((card) => card.id === trimmed);
  if (byId) return byId;

  const byTitle = board.cards.filter((card) => card.title === trimmed);
  if (byTitle.length === 1) {
    return byTitle[0] ?? null;
  }

  return null;
}
