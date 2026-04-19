import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createRepoGitRunner, runGit } from "../shared/git.js";
import { parseFeatureBoardFromText } from "./board.js";
import { writeFeatureCardSidecar } from "./board-sidecar.js";
import {
  buildFeatureBoardReconcileMessage,
  reconcileFeatureBoard,
} from "./board-reconcile.js";

const tempDirs: string[] = [];

function createTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-board-reconcile-"));
  tempDirs.push(dir);
  runGit(dir, ["init"]);
  fs.writeFileSync(path.join(dir, "README.md"), "test\n", "utf-8");
  runGit(dir, ["add", "README.md"]);
  runGit(dir, ["commit", "-m", "init"]);
  runGit(dir, ["branch", "-M", "main"]);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("feature board reconcile", () => {
  it("suggests create action when a feature card has no sidecar", () => {
    const repoRoot = createTempRepo();
    const board = parseFeatureBoardFromText(
      `
## Spec

- [ ] Checkout V2 <!-- card-id: feat-checkout-v2; kind: feature -->
`.trim(),
    );

    const result = reconcileFeatureBoard(
      repoRoot,
      board,
      createRepoGitRunner(repoRoot),
    );

    expect(result.ok).toBe(true);
    expect(result.cards[0]?.issues[0]).toMatchObject({
      suggestedAction: "create-feature",
    });
  });

  it("flags done cards whose branch is not merged into target", () => {
    const repoRoot = createTempRepo();
    runGit(repoRoot, ["checkout", "-b", "main--checkout-v2"]);
    fs.writeFileSync(path.join(repoRoot, "feature.txt"), "x\n", "utf-8");
    runGit(repoRoot, ["add", "feature.txt"]);
    runGit(repoRoot, ["commit", "-m", "feature"]);
    runGit(repoRoot, ["checkout", "main"]);

    const board = parseFeatureBoardFromText(
      `
## Done

- [ ] Checkout V2 <!-- card-id: feat-checkout-v2; kind: feature -->
`.trim(),
    );

    writeFeatureCardSidecar(repoRoot, board, {
      schemaVersion: 1,
      cardId: "feat-checkout-v2",
      kind: "feature",
      title: "Checkout V2",
      branch: "main--checkout-v2",
      baseBranch: "main",
      parentCardId: null,
      parentBranch: null,
      mergeTarget: "main",
      status: "done",
      worktreePath: repoRoot,
      sessionPath: null,
      specPath: null,
      planPath: null,
      validation: {
        lastCheckedAt: null,
        mergeState: "unknown",
      },
      timestamps: {
        createdAt: "2026-04-19T00:00:00.000Z",
        updatedAt: "2026-04-19T00:00:00.000Z",
      },
    });

    const result = reconcileFeatureBoard(
      repoRoot,
      board,
      createRepoGitRunner(repoRoot),
    );

    expect(result.ok).toBe(false);
    expect(buildFeatureBoardReconcileMessage(result)).toContain(
      "not merged into 'main'",
    );
  });

  it("blocks parent done state while children are unfinished", () => {
    const repoRoot = createTempRepo();
    const board = parseFeatureBoardFromText(
      `
## Done

- [ ] Checkout V2 <!-- card-id: feat-checkout-v2; kind: feature -->

## Review

  - [ ] Pricing <!-- card-id: child-pricing; kind: child; parent: feat-checkout-v2 -->
`.trim(),
    );

    const result = reconcileFeatureBoard(
      repoRoot,
      board,
      createRepoGitRunner(repoRoot),
    );

    expect(result.ok).toBe(false);
    expect(
      result.cards.find((card) => card.card.id === "feat-checkout-v2")?.issues,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("child cards are unfinished"),
        }),
      ]),
    );
  });
});
