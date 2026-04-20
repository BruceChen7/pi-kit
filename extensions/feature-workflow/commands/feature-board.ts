import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

import { branchExists, type GitRunner } from "../../shared/git.js";

import { buildBaseBranchCandidates } from "../base-branches.js";
import {
  type FeatureBoard,
  type FeatureBoardCard,
  findFeatureBoardCard,
  readFeatureBoard,
} from "../board.js";
import {
  buildFeatureBoardReconcileMessage,
  reconcileFeatureBoard,
} from "../board-reconcile.js";
import {
  type FeatureCardSidecar,
  laneToSidecarStatus,
  readFeatureCardSidecar,
  writeFeatureBoardIndex,
  writeFeatureCardSidecar,
} from "../board-sidecar.js";
import { resolveFeatureCommandRuntime } from "../runtime.js";
import type { FeatureRecord } from "../storage.js";
import {
  createFeatureWorktree,
  ensureFeatureWorktree,
} from "../worktree-gateway.js";
import {
  commandLog,
  maybeSwitchToWorktreeSession,
  notifyAndLogWtError,
  resolveInferredBaseBranch,
  trimToNull,
} from "./shared.js";

function buildBoardStatusMessage(board: FeatureBoard): string {
  return `feature board status: path=${board.path} cards=${board.cards.length} errors=${board.errors.length}`;
}

function buildFeatureCardBranch(baseBranch: string, cardId: string): string {
  return `${baseBranch}--${cardId}`;
}

function buildChildCardBranch(parentBranch: string, cardId: string): string {
  return `${parentBranch}--${cardId}`;
}

function resolveDefaultFeatureBaseBranch(input: { runGit: GitRunner }): string {
  const { currentBranch, localBranches, inference } = resolveInferredBaseBranch(
    {
      runGit: input.runGit,
    },
  );
  const candidates = buildBaseBranchCandidates({
    currentBranch,
    localBranches,
    inferredBaseBranch: inference.kind === "resolved" ? inference.branch : null,
  });

  return candidates[0] ?? currentBranch ?? "main";
}

async function resolveBoardCardQuery(input: {
  args: string[];
  ctx: ExtensionCommandContext;
  board: FeatureBoard;
}): Promise<string | null> {
  const inline = trimToNull(input.args.join(" "));
  if (inline) {
    return inline;
  }

  if (!input.ctx.hasUI) {
    return null;
  }

  const option = await input.ctx.ui.select(
    "Board card:",
    input.board.cards.map((card) => card.id),
  );
  return trimToNull(option);
}

function buildFeatureRecordFromSidecar(
  sidecar: FeatureCardSidecar,
  nowIso: string,
): FeatureRecord {
  return {
    slug: sidecar.branch,
    branch: sidecar.branch,
    worktreePath: sidecar.worktreePath,
    status: "active",
    createdAt: sidecar.timestamps.createdAt,
    updatedAt: nowIso,
  };
}

function buildFeatureSidecar(input: {
  card: FeatureBoardCard;
  branch: string;
  baseBranch: string;
  mergeTarget: string;
  parentBranch: string | null;
  worktreePath: string;
  existing: FeatureCardSidecar | null;
  nowIso: string;
}): FeatureCardSidecar {
  const createdAt = input.existing?.timestamps.createdAt ?? input.nowIso;
  return {
    schemaVersion: 1,
    cardId: input.card.id,
    kind: input.card.kind,
    title: input.card.title,
    branch: input.branch,
    baseBranch: input.baseBranch,
    parentCardId: input.card.parentId,
    parentBranch: input.parentBranch,
    mergeTarget: input.mergeTarget,
    status: laneToSidecarStatus(input.card.lane),
    worktreePath: input.worktreePath,
    sessionPath: input.existing?.sessionPath ?? null,
    specPath: input.existing?.specPath ?? null,
    planPath: input.existing?.planPath ?? null,
    validation: {
      lastCheckedAt: input.existing?.validation.lastCheckedAt ?? null,
      mergeState: input.existing?.validation.mergeState ?? "unknown",
    },
    timestamps: {
      createdAt,
      updatedAt: input.nowIso,
    },
  };
}

export async function runFeatureBoardStatusCommand(
  _pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const runtime = resolveFeatureCommandRuntime({ pi: _pi, ctx });
  if (!runtime) {
    return;
  }

  const board = readFeatureBoard(runtime.repoRoot);
  const level = board.errors.length > 0 ? "warning" : "info";
  ctx.ui.notify(buildBoardStatusMessage(board), level);

  if (board.errors.length > 0) {
    ctx.ui.notify(
      `feature board parser errors: ${board.errors.join(" | ")}`,
      "warning",
    );
  }
}

export async function runFeatureBoardReconcileCommand(
  _pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const runtime = resolveFeatureCommandRuntime({ pi: _pi, ctx });
  if (!runtime) {
    return;
  }

  const board = readFeatureBoard(runtime.repoRoot);
  const result = reconcileFeatureBoard(runtime.repoRoot, board, runtime.runGit);
  ctx.ui.notify(
    buildFeatureBoardReconcileMessage(result),
    result.ok ? "info" : "warning",
  );
}

export async function runFeatureBoardApplyCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string[],
): Promise<void> {
  commandLog.debug("feature-board-apply invoked", {
    cwd: ctx.cwd,
    args,
  });

  const runtime = resolveFeatureCommandRuntime({ pi, ctx });
  if (!runtime) {
    return;
  }

  const { repoRoot, runGit, runWt, config } = runtime;
  const board = readFeatureBoard(repoRoot);
  if (board.errors.length > 0) {
    ctx.ui.notify(
      `feature board parser errors: ${board.errors.join(" | ")}`,
      "error",
    );
    return;
  }

  const query = await resolveBoardCardQuery({ args, ctx, board });
  if (!query) {
    ctx.ui.notify("feature-board-apply requires <card-id|title>", "error");
    return;
  }

  const card = findFeatureBoardCard(board, query);
  if (!card) {
    ctx.ui.notify(`Unknown board card: ${query}`, "error");
    return;
  }

  const existing = readFeatureCardSidecar(repoRoot, card.id);

  let baseBranch = "";
  let mergeTarget = "";
  let parentBranch: string | null = null;
  let branch = existing?.branch ?? "";

  if (card.kind === "feature") {
    baseBranch =
      existing?.baseBranch ?? resolveDefaultFeatureBaseBranch({ runGit });
    mergeTarget = existing?.mergeTarget ?? baseBranch;
    branch = branch || buildFeatureCardBranch(baseBranch, card.id);
  } else {
    const parentId = card.parentId;
    if (!parentId) {
      ctx.ui.notify(
        `Child board card '${card.id}' is missing parent metadata`,
        "error",
      );
      return;
    }

    const parentSidecar = readFeatureCardSidecar(repoRoot, parentId);
    if (!parentSidecar) {
      ctx.ui.notify(
        `Parent feature '${parentId}' has no sidecar yet. Apply parent first.`,
        "error",
      );
      return;
    }

    parentBranch = parentSidecar.branch;
    baseBranch = existing?.baseBranch ?? parentBranch;
    mergeTarget = existing?.mergeTarget ?? parentBranch;
    branch = branch || buildChildCardBranch(parentBranch, card.id);
  }

  const branchPresent = branchExists(runGit, branch);
  const worktreeResult = branchPresent
    ? await ensureFeatureWorktree(runWt, {
        branch,
        fallbackWorktreePath: existing?.worktreePath ?? "",
      })
    : await createFeatureWorktree(runWt, {
        branch,
        base: baseBranch,
      });

  if (worktreeResult.ok === false) {
    notifyAndLogWtError({
      ctx,
      message: worktreeResult.message,
      scope: "feature-board-apply worktree failed",
      meta: {
        repoRoot,
        cardId: card.id,
        branch,
        baseBranch,
      },
    });
    return;
  }

  const nowIso = new Date().toISOString();
  const nextSidecar = buildFeatureSidecar({
    card,
    branch,
    baseBranch,
    mergeTarget,
    parentBranch,
    worktreePath: worktreeResult.worktreePath,
    existing,
    nowIso,
  });

  writeFeatureCardSidecar(repoRoot, board, nextSidecar);
  writeFeatureBoardIndex(repoRoot, board);

  await maybeSwitchToWorktreeSession({
    ctx,
    record: buildFeatureRecordFromSidecar(nextSidecar, nowIso),
    worktreePath: nextSidecar.worktreePath,
    enabled: config.defaults.autoSwitchToWorktreeSession,
  });

  ctx.ui.notify(`Board card applied: ${card.id} -> ${branch}`, "info");
}
