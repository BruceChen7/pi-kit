import fs from "node:fs";

import {
  branchExists,
  type GitRunner,
} from "../shared/git.js";

import type { FeatureBoard, FeatureBoardCard } from "./board.js";
import {
  laneToSidecarStatus,
  readFeatureCardSidecar,
  type FeatureCardSidecar,
} from "./board-sidecar.js";

export type FeatureBoardReconcileIssue = {
  cardId: string;
  severity: "error" | "warning" | "info";
  message: string;
  suggestedAction:
    | "none"
    | "create-feature"
    | "create-child"
    | "ensure-worktree"
    | "merge-into-target"
    | "resolve-parent";
};

export type FeatureBoardReconcileCard = {
  card: FeatureBoardCard;
  sidecar: FeatureCardSidecar | null;
  issues: FeatureBoardReconcileIssue[];
  branchExists: boolean;
  worktreeExists: boolean;
  mergedIntoTarget: boolean;
};

export type FeatureBoardReconcileResult = {
  ok: boolean;
  boardErrors: string[];
  cards: FeatureBoardReconcileCard[];
};

function isBranchMergedIntoTarget(runGit: GitRunner, branch: string, target: string): boolean {
  const result = runGit(["merge-base", "--is-ancestor", branch, target]);
  return result.exitCode === 0;
}

function reconcileCard(
  repoRoot: string,
  board: FeatureBoard,
  card: FeatureBoardCard,
  runGit: GitRunner,
): FeatureBoardReconcileCard {
  const sidecar = readFeatureCardSidecar(repoRoot, card.id);
  const issues: FeatureBoardReconcileIssue[] = [];
  const branchPresent = sidecar ? branchExists(runGit, sidecar.branch) : false;
  const worktreePresent =
    sidecar?.worktreePath?.trim().length
      ? fs.existsSync(sidecar.worktreePath)
      : false;
  const mergedIntoTarget =
    sidecar && branchPresent
      ? isBranchMergedIntoTarget(runGit, sidecar.branch, sidecar.mergeTarget)
      : false;

  if (!sidecar) {
    issues.push({
      cardId: card.id,
      severity: "info",
      message:
        card.kind === "feature"
          ? "Feature card has no sidecar yet."
          : "Child card has no sidecar yet.",
      suggestedAction:
        card.kind === "feature" ? "create-feature" : "create-child",
    });
  }

  if (card.kind === "child") {
    const parent = board.cards.find((entry) => entry.id === card.parentId) ?? null;
    if (!parent) {
      issues.push({
        cardId: card.id,
        severity: "error",
        message: "Child card is missing its parent feature card.",
        suggestedAction: "resolve-parent",
      });
    } else {
      const parentSidecar = readFeatureCardSidecar(repoRoot, parent.id);
      if (!parentSidecar) {
        issues.push({
          cardId: card.id,
          severity: "error",
          message: "Parent feature card has no sidecar yet.",
          suggestedAction: "resolve-parent",
        });
      }
    }
  }

  if (sidecar) {
    if (!branchPresent) {
      issues.push({
        cardId: card.id,
        severity: "warning",
        message: `Branch '${sidecar.branch}' does not exist locally.`,
        suggestedAction:
          card.kind === "feature" ? "create-feature" : "create-child",
      });
    }

    if (branchPresent && !worktreePresent) {
      issues.push({
        cardId: card.id,
        severity: "info",
        message: `Worktree missing for branch '${sidecar.branch}'.`,
        suggestedAction: "ensure-worktree",
      });
    }

    if (sidecar.status !== laneToSidecarStatus(card.lane)) {
      issues.push({
        cardId: card.id,
        severity: "info",
        message: `Board lane '${card.lane}' differs from sidecar status '${sidecar.status}'.`,
        suggestedAction: "none",
      });
    }

    if (card.lane === "Done" && !mergedIntoTarget) {
      issues.push({
        cardId: card.id,
        severity: "error",
        message: `Card is in Done, but branch '${sidecar.branch}' is not merged into '${sidecar.mergeTarget}'.`,
        suggestedAction: "merge-into-target",
      });
    }
  }

  if (card.kind === "feature" && card.lane === "Done") {
    const openChildren = board.cards.filter(
      (entry) => entry.parentId === card.id && entry.lane !== "Done",
    );
    if (openChildren.length > 0) {
      issues.push({
        cardId: card.id,
        severity: "error",
        message: `Feature card cannot be Done while child cards are unfinished: ${openChildren.map((entry) => entry.id).join(", ")}.`,
        suggestedAction: "none",
      });
    }
  }

  return {
    card,
    sidecar,
    issues,
    branchExists: branchPresent,
    worktreeExists: worktreePresent,
    mergedIntoTarget,
  };
}

export function reconcileFeatureBoard(
  repoRoot: string,
  board: FeatureBoard,
  runGit: GitRunner,
): FeatureBoardReconcileResult {
  const cards = board.cards.map((card) => reconcileCard(repoRoot, board, card, runGit));
  return {
    ok:
      board.errors.length === 0 &&
      cards.every((entry) => entry.issues.every((issue) => issue.severity !== "error")),
    boardErrors: [...board.errors],
    cards,
  };
}

export function buildFeatureBoardReconcileMessage(
  result: FeatureBoardReconcileResult,
): string {
  const parts: string[] = [];
  if (result.boardErrors.length > 0) {
    parts.push(`board errors: ${result.boardErrors.join(" | ")}`);
  }

  const issueCount = result.cards.reduce(
    (sum, card) => sum + card.issues.length,
    0,
  );
  parts.push(`cards: ${result.cards.length}`);
  parts.push(`issues: ${issueCount}`);

  const importantIssues = result.cards.flatMap((card) =>
    card.issues
      .filter((issue) => issue.severity !== "info")
      .slice(0, 2)
      .map((issue) => `${issue.cardId}: ${issue.message}`),
  );
  if (importantIssues.length > 0) {
    parts.push(importantIssues.slice(0, 3).join(" | "));
  }

  return `feature board reconcile: ${parts.join(" | ")}`;
}
