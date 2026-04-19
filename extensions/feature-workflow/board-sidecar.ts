import fs from "node:fs";
import path from "node:path";

import type { FeatureBoard, FeatureBoardCard, FeatureBoardCardKind } from "./board.js";

export type FeatureBoardCardStatus =
  | "inbox"
  | "spec"
  | "ready"
  | "in_progress"
  | "review"
  | "done";

export type FeatureCardSidecar = {
  schemaVersion: 1;
  cardId: string;
  kind: FeatureBoardCardKind;
  title: string;
  branch: string;
  baseBranch: string;
  parentCardId: string | null;
  parentBranch: string | null;
  mergeTarget: string;
  status: FeatureBoardCardStatus;
  worktreePath: string;
  sessionPath: string | null;
  specPath: string | null;
  planPath: string | null;
  validation: {
    lastCheckedAt: string | null;
    mergeState: "unknown" | "unmerged" | "merged";
  };
  timestamps: {
    createdAt: string;
    updatedAt: string;
  };
};

export type FeatureBoardIndex = {
  schemaVersion: 1;
  boardPath: string;
  cards: Record<string, string>;
};

const SIDECAR_DIR_RELATIVE_PATH = path.join("workitems", ".feature-cards");
const BOARD_INDEX_RELATIVE_PATH = path.join(
  "workitems",
  ".feature-workflow",
  "board-index.json",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function trimToNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function laneToSidecarStatus(
  lane: FeatureBoardCard["lane"],
): FeatureBoardCardStatus {
  switch (lane) {
    case "Inbox":
      return "inbox";
    case "Spec":
      return "spec";
    case "Ready":
      return "ready";
    case "In Progress":
      return "in_progress";
    case "Review":
      return "review";
    case "Done":
      return "done";
  }
}

export function getFeatureCardSidecarDir(repoRoot: string): string {
  return path.join(repoRoot, SIDECAR_DIR_RELATIVE_PATH);
}

export function getFeatureBoardIndexPath(repoRoot: string): string {
  return path.join(repoRoot, BOARD_INDEX_RELATIVE_PATH);
}

export function getFeatureCardSidecarPath(repoRoot: string, cardId: string): string {
  return path.join(getFeatureCardSidecarDir(repoRoot), `${cardId}.json`);
}

export function readFeatureCardSidecar(
  repoRoot: string,
  cardId: string,
): FeatureCardSidecar | null {
  const sidecarPath = getFeatureCardSidecarPath(repoRoot, cardId);
  if (!fs.existsSync(sidecarPath)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(sidecarPath, "utf-8")) as unknown;
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  if (parsed.schemaVersion !== 1) return null;

  const branch = trimToNull(parsed.branch);
  const baseBranch = trimToNull(parsed.baseBranch);
  const mergeTarget = trimToNull(parsed.mergeTarget);
  const title = trimToNull(parsed.title);
  const kind = trimToNull(parsed.kind) as FeatureBoardCardKind | null;
  const createdAt = trimToNull(parsed.timestamps && (parsed.timestamps as Record<string, unknown>).createdAt);
  const updatedAt = trimToNull(parsed.timestamps && (parsed.timestamps as Record<string, unknown>).updatedAt);
  if (
    !branch ||
    !baseBranch ||
    !mergeTarget ||
    !title ||
    (kind !== "feature" && kind !== "child") ||
    !createdAt ||
    !updatedAt
  ) {
    return null;
  }

  const status = trimToNull(parsed.status) as FeatureBoardCardStatus | null;
  if (
    status !== "inbox" &&
    status !== "spec" &&
    status !== "ready" &&
    status !== "in_progress" &&
    status !== "review" &&
    status !== "done"
  ) {
    return null;
  }

  const validation = isRecord(parsed.validation) ? parsed.validation : {};
  return {
    schemaVersion: 1,
    cardId,
    kind,
    title,
    branch,
    baseBranch,
    parentCardId: trimToNull(parsed.parentCardId),
    parentBranch: trimToNull(parsed.parentBranch),
    mergeTarget,
    status,
    worktreePath: trimToNull(parsed.worktreePath) ?? "",
    sessionPath: trimToNull(parsed.sessionPath),
    specPath: trimToNull(parsed.specPath),
    planPath: trimToNull(parsed.planPath),
    validation: {
      lastCheckedAt: trimToNull(validation.lastCheckedAt),
      mergeState:
        validation.mergeState === "merged"
          ? "merged"
          : validation.mergeState === "unmerged"
            ? "unmerged"
            : "unknown",
    },
    timestamps: {
      createdAt,
      updatedAt,
    },
  };
}

export function writeFeatureCardSidecar(
  repoRoot: string,
  board: FeatureBoard,
  sidecar: FeatureCardSidecar,
): void {
  if (!board.cards.some((card) => card.id === sidecar.cardId)) {
    throw new Error(`Cannot write sidecar for missing board card '${sidecar.cardId}'`);
  }

  const sidecarDir = getFeatureCardSidecarDir(repoRoot);
  fs.mkdirSync(sidecarDir, { recursive: true });
  const sidecarPath = getFeatureCardSidecarPath(repoRoot, sidecar.cardId);
  fs.writeFileSync(`${sidecarPath}`, `${JSON.stringify(sidecar, null, 2)}\n`, "utf-8");
}

export function buildFeatureBoardIndex(
  repoRoot: string,
  board: FeatureBoard,
): FeatureBoardIndex {
  const cards: Record<string, string> = {};
  for (const card of board.cards) {
    cards[card.id] = getFeatureCardSidecarPath(repoRoot, card.id);
  }
  return {
    schemaVersion: 1,
    boardPath: board.path,
    cards,
  };
}

export function writeFeatureBoardIndex(
  repoRoot: string,
  board: FeatureBoard,
): FeatureBoardIndex {
  const indexPath = getFeatureBoardIndexPath(repoRoot);
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  const index = buildFeatureBoardIndex(repoRoot, board);
  fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf-8");
  return index;
}
