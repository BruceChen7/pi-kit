import fs from "node:fs";
import path from "node:path";

import {
  getFeatureBoardPath,
  parseFeatureBoardFromText,
} from "../feature-workflow/board.js";

export function applyBoardTextPatch(input: {
  repoRoot: string;
  nextBoardText: string;
}): { ok: true; summary: string } | { ok: false; error: string } {
  const boardPath = getFeatureBoardPath(input.repoRoot);
  const parsed = parseFeatureBoardFromText(input.nextBoardText, boardPath);
  if (parsed.errors.length > 0) {
    return {
      ok: false,
      error: `feature board parser errors: ${parsed.errors.join(" | ")}`,
    };
  }

  fs.mkdirSync(path.dirname(boardPath), { recursive: true });
  fs.writeFileSync(boardPath, `${input.nextBoardText}\n`, "utf-8");
  return {
    ok: true,
    summary: "board updated",
  };
}
