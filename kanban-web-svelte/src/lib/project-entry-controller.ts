import type { ProjectBoardReadResult } from "./project-board-file";
import type { BoardSnapshot } from "./types";

export type ProjectOpenCandidate<THandle> = {
  id: string;
  name: string;
  handle: THandle;
  lastUsedAt: string;
};

export type ProjectOpenResult<THandle> =
  | {
      status: "ready";
      project: ProjectOpenCandidate<THandle>;
      board: BoardSnapshot;
    }
  | {
      status: "init-required";
      project: ProjectOpenCandidate<THandle>;
    }
  | {
      status: "access-error";
      message: string;
    };

export async function openProjectWorkspace<THandle>(input: {
  candidate: ProjectOpenCandidate<THandle>;
  mode: "restore" | "select" | "recent";
  ensureAccess: (candidate: ProjectOpenCandidate<THandle>) => Promise<boolean>;
  readBoard: (
    candidate: ProjectOpenCandidate<THandle>,
  ) => Promise<ProjectBoardReadResult>;
}): Promise<ProjectOpenResult<THandle>> {
  const hasAccess = await input.ensureAccess(input.candidate);
  if (!hasAccess) {
    return {
      status: "access-error",
      message:
        input.mode === "restore"
          ? "Unable to restore the last project. Please select a folder again."
          : "Unable to open that project. Please select a folder again.",
    };
  }

  const board = await input.readBoard(input.candidate);
  if (board.status === "missing") {
    return {
      status: "init-required",
      project: input.candidate,
    };
  }

  return {
    status: "ready",
    project: input.candidate,
    board: board.board,
  };
}
