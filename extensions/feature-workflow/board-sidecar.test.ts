import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseFeatureBoardFromText } from "./board.js";
import {
  laneToSidecarStatus,
  readFeatureCardSidecar,
  writeFeatureBoardIndex,
  writeFeatureCardSidecar,
} from "./board-sidecar.js";

const tempDirs: string[] = [];

function createTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-board-sidecar-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("feature board sidecars", () => {
  it("maps board lanes to sidecar statuses", () => {
    expect(laneToSidecarStatus("In Progress")).toBe("in_progress");
    expect(laneToSidecarStatus("Done")).toBe("done");
  });

  it("writes and reads a card sidecar for an existing board card", () => {
    const repoRoot = createTempRepo();
    const board = parseFeatureBoardFromText(`
## Ready

- [ ] Checkout V2 <!-- card-id: feat-checkout-v2; kind: feature -->
`.trim());

    writeFeatureCardSidecar(repoRoot, board, {
      schemaVersion: 1,
      cardId: "feat-checkout-v2",
      kind: "feature",
      title: "Checkout V2",
      branch: "main--feat-checkout-v2",
      baseBranch: "main",
      parentCardId: null,
      parentBranch: null,
      mergeTarget: "main",
      status: "ready",
      worktreePath: "/tmp/wt",
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

    expect(readFeatureCardSidecar(repoRoot, "feat-checkout-v2")).toMatchObject({
      branch: "main--feat-checkout-v2",
      mergeTarget: "main",
      status: "ready",
    });
  });

  it("rejects sidecar writes for missing board cards", () => {
    const repoRoot = createTempRepo();
    const board = parseFeatureBoardFromText(`
## Ready

- [ ] Checkout V2 <!-- card-id: feat-checkout-v2; kind: feature -->
`.trim());

    expect(() =>
      writeFeatureCardSidecar(repoRoot, board, {
        schemaVersion: 1,
        cardId: "missing",
        kind: "feature",
        title: "Missing",
        branch: "main--missing",
        baseBranch: "main",
        parentCardId: null,
        parentBranch: null,
        mergeTarget: "main",
        status: "ready",
        worktreePath: "",
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
      }),
    ).toThrow(/missing board card/);
  });

  it("writes board index entries for all cards", () => {
    const repoRoot = createTempRepo();
    const board = parseFeatureBoardFromText(`
## Spec

- [ ] Checkout V2 <!-- card-id: feat-checkout-v2; kind: feature -->
  - [ ] Pricing <!-- card-id: child-pricing; kind: child; parent: feat-checkout-v2 -->
`.trim());

    const index = writeFeatureBoardIndex(repoRoot, board);
    expect(Object.keys(index.cards)).toEqual([
      "feat-checkout-v2",
      "child-pricing",
    ]);
  });
});
