import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { applyBoardTextPatch } from "./board-patch.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-board-patch-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("applyBoardTextPatch", () => {
  it("writes board markdown and validates parser", () => {
    const repoRoot = createTempDir();
    const boardPath = path.join(repoRoot, "workitems", "features.kanban.md");

    const result = applyBoardTextPatch({
      repoRoot,
      nextBoardText: [
        "## Spec",
        "",
        "- [ ] Checkout V2 <!-- card-id: feat-checkout-v2; kind: feature -->",
      ].join("\n"),
    });

    expect(result).toEqual({
      ok: true,
      summary: "board updated",
    });
    expect(fs.existsSync(boardPath)).toBe(true);
    expect(fs.readFileSync(boardPath, "utf-8")).toContain("Checkout V2");
  });

  it("rejects invalid board markdown", () => {
    const repoRoot = createTempDir();

    const result = applyBoardTextPatch({
      repoRoot,
      nextBoardText: "- [ ] Missing lane and metadata",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/parser errors/i);
    }
  });
});
