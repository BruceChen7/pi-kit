import {
  type FeatureBoardCard,
  findFeatureBoardCard,
  readFeatureBoard,
  readFeatureCardSidecar,
} from "./feature-workflow-local.js";

import {
  readSessionRegistry,
  type SessionRegistryCardEntry,
} from "./session-registry.js";

export type KanbanCardContext = {
  cardId: string;
  title: string;
  kind: FeatureBoardCard["kind"];
  lane: FeatureBoardCard["lane"];
  parentCardId: string | null;
  branch: string | null;
  baseBranch: string | null;
  mergeTarget: string | null;
  worktreePath: string | null;
  session: SessionRegistryCardEntry | null;
};

export type ResolveKanbanCardContextResult =
  | { ok: true; context: KanbanCardContext }
  | { ok: false; error: string };

export function resolveKanbanCardContext(input: {
  repoRoot: string;
  cardQuery: string;
  sessionRegistryPath: string;
}): ResolveKanbanCardContextResult {
  const board = readFeatureBoard(input.repoRoot);
  if (board.errors.length > 0) {
    return {
      ok: false,
      error: `feature board parser errors: ${board.errors.join(" | ")}`,
    };
  }

  const card = findFeatureBoardCard(board, input.cardQuery);
  if (!card) {
    return {
      ok: false,
      error: `Unknown board card: ${input.cardQuery}`,
    };
  }

  const sidecar = readFeatureCardSidecar(input.repoRoot, card.id);
  const registry = readSessionRegistry(input.sessionRegistryPath);

  return {
    ok: true,
    context: {
      cardId: card.id,
      title: card.title,
      kind: card.kind,
      lane: card.lane,
      parentCardId: card.parentId,
      branch: sidecar?.branch ?? null,
      baseBranch: sidecar?.baseBranch ?? null,
      mergeTarget: sidecar?.mergeTarget ?? null,
      worktreePath: sidecar?.worktreePath ?? null,
      session: registry.cards[card.id] ?? null,
    },
  };
}
