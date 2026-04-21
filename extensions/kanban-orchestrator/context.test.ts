import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  resolveKanbanCardContext,
  resolveKanbanCardContextByWorktreePath,
} from "./context.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-kit-orchestrator-context-"),
  );
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveKanbanCardContext", () => {
  it("returns not-found when the card is missing", () => {
    const repoRoot = createTempDir();
    fs.mkdirSync(path.join(repoRoot, "workitems"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, "workitems", "features.kanban.md"),
      [
        "## Spec",
        "",
        "- [ ] Checkout V2 <!-- card-id: feat-checkout-v2; kind: feature -->",
      ].join("\n"),
      "utf-8",
    );

    const result = resolveKanbanCardContext({
      repoRoot,
      cardQuery: "feat-missing",
      sessionRegistryPath: path.join(
        repoRoot,
        "workitems",
        ".feature-workflow",
        "session-registry.json",
      ),
    });

    expect(result).toEqual({
      ok: false,
      error: "Unknown board card: feat-missing",
    });
  });

  it("returns merged board + sidecar + session context", () => {
    const repoRoot = createTempDir();
    fs.mkdirSync(path.join(repoRoot, "workitems", ".feature-cards"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(repoRoot, "workitems", ".feature-workflow"), {
      recursive: true,
    });

    fs.writeFileSync(
      path.join(repoRoot, "workitems", "features.kanban.md"),
      [
        "## In Progress",
        "",
        "- [ ] Checkout V2 <!-- card-id: feat-checkout-v2; kind: feature -->",
      ].join("\n"),
      "utf-8",
    );

    fs.writeFileSync(
      path.join(
        repoRoot,
        "workitems",
        ".feature-cards",
        "feat-checkout-v2.json",
      ),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          branch: "main--feat-checkout-v2",
          baseBranch: "main",
          mergeTarget: "main",
          title: "Checkout V2",
          kind: "feature",
          status: "in_progress",
          worktreePath: "/tmp/wt/main--feat-checkout-v2",
          sessionPath: null,
          parentCardId: null,
          parentBranch: null,
          specPath: null,
          planPath: null,
          validation: {
            lastCheckedAt: null,
            mergeState: "unknown",
          },
          timestamps: {
            createdAt: "2026-04-20T00:00:00.000Z",
            updatedAt: "2026-04-20T00:00:00.000Z",
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    fs.writeFileSync(
      path.join(
        repoRoot,
        "workitems",
        ".feature-workflow",
        "session-registry.json",
      ),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          cards: {
            "feat-checkout-v2": {
              chatJid: "chat:feat-checkout-v2",
              worktreePath: "/tmp/wt/main--feat-checkout-v2",
              lastActiveAt: "2026-04-20T00:00:00.000Z",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const result = resolveKanbanCardContext({
      repoRoot,
      cardQuery: "feat-checkout-v2",
      sessionRegistryPath: path.join(
        repoRoot,
        "workitems",
        ".feature-workflow",
        "session-registry.json",
      ),
    });

    expect(result).toEqual({
      ok: true,
      context: {
        cardId: "feat-checkout-v2",
        title: "Checkout V2",
        kind: "feature",
        lane: "In Progress",
        parentCardId: null,
        branch: "main--feat-checkout-v2",
        baseBranch: "main",
        mergeTarget: "main",
        worktreePath: "/tmp/wt/main--feat-checkout-v2",
        session: {
          chatJid: "chat:feat-checkout-v2",
          worktreePath: "/tmp/wt/main--feat-checkout-v2",
          lastActiveAt: "2026-04-20T00:00:00.000Z",
        },
      },
    });
  });

  it("resolves child context from worktree path", () => {
    const repoRoot = createTempDir();
    fs.mkdirSync(path.join(repoRoot, "workitems", ".feature-cards"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(repoRoot, "workitems", ".feature-workflow"), {
      recursive: true,
    });

    fs.writeFileSync(
      path.join(repoRoot, "workitems", "features.kanban.md"),
      [
        "## In Progress",
        "",
        "- [ ] Checkout V2 <!-- card-id: feat-checkout-v2; kind: feature -->",
        "  - [ ] Split pricing widget <!-- card-id: child-pricing-widget; kind: child; parent: feat-checkout-v2 -->",
      ].join("\n"),
      "utf-8",
    );

    fs.writeFileSync(
      path.join(
        repoRoot,
        "workitems",
        ".feature-cards",
        "child-pricing-widget.json",
      ),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          branch: "main--feat-checkout-v2--child-pricing-widget",
          baseBranch: "main--feat-checkout-v2",
          mergeTarget: "main--feat-checkout-v2",
          title: "Split pricing widget",
          kind: "child",
          status: "in_progress",
          worktreePath: "/tmp/wt/main--feat-checkout-v2--child-pricing-widget",
          sessionPath: null,
          parentCardId: "feat-checkout-v2",
          parentBranch: "main--feat-checkout-v2",
          specPath: null,
          planPath: null,
          validation: {
            lastCheckedAt: null,
            mergeState: "unknown",
          },
          timestamps: {
            createdAt: "2026-04-20T00:00:00.000Z",
            updatedAt: "2026-04-20T00:00:00.000Z",
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const result = resolveKanbanCardContextByWorktreePath({
      repoRoot,
      worktreePath: "/tmp/wt/main--feat-checkout-v2--child-pricing-widget/src",
      sessionRegistryPath: path.join(
        repoRoot,
        "workitems",
        ".feature-workflow",
        "session-registry.json",
      ),
    });

    expect(result).toEqual({
      ok: true,
      context: {
        cardId: "child-pricing-widget",
        title: "Split pricing widget",
        kind: "child",
        lane: "In Progress",
        parentCardId: "feat-checkout-v2",
        branch: "main--feat-checkout-v2--child-pricing-widget",
        baseBranch: "main--feat-checkout-v2",
        mergeTarget: "main--feat-checkout-v2",
        worktreePath: "/tmp/wt/main--feat-checkout-v2--child-pricing-widget",
        session: null,
      },
    });
  });
});
