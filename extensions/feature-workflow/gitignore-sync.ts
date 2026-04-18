import fs from "node:fs";
import path from "node:path";

const GITIGNORE_FILE = ".gitignore";

type SyncGitignoreSuccess = {
  ok: true;
  changed: boolean;
  skipped: boolean;
};

type SyncGitignoreFailure = {
  ok: false;
  message: string;
};

export type SyncGitignoreToWorktreeResult =
  | SyncGitignoreSuccess
  | SyncGitignoreFailure;

const trimToNull = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return String(error);
};

export const syncGitignoreToWorktree = (input: {
  repoRoot: string;
  worktreePath: string;
}): SyncGitignoreToWorktreeResult => {
  const repoRoot = trimToNull(input.repoRoot);
  const worktreePath = trimToNull(input.worktreePath);
  if (!repoRoot || !worktreePath) {
    return {
      ok: true,
      changed: false,
      skipped: true,
    };
  }

  const sourcePath = path.join(repoRoot, GITIGNORE_FILE);
  const targetPath = path.join(worktreePath, GITIGNORE_FILE);

  if (path.resolve(sourcePath) === path.resolve(targetPath)) {
    return {
      ok: true,
      changed: false,
      skipped: true,
    };
  }

  if (!fs.existsSync(sourcePath)) {
    return {
      ok: true,
      changed: false,
      skipped: true,
    };
  }

  try {
    const sourceContent = fs.readFileSync(sourcePath, "utf-8");
    const targetContent = fs.existsSync(targetPath)
      ? fs.readFileSync(targetPath, "utf-8")
      : null;

    if (targetContent === sourceContent) {
      return {
        ok: true,
        changed: false,
        skipped: false,
      };
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, sourceContent, "utf-8");

    return {
      ok: true,
      changed: true,
      skipped: false,
    };
  } catch (error) {
    return {
      ok: false,
      message: toErrorMessage(error),
    };
  }
};
