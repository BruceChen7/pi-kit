import type { BoardLane, BoardSnapshot } from "./types";

const BOARD_DIRECTORY_SEGMENTS = [".pi", "kanban"] as const;
const BOARD_FILE_NAME = "board.json";

export type ProjectBoardReadResult =
  | {
      status: "ready";
      board: BoardSnapshot;
    }
  | {
      status: "missing";
    };

type FileHandleLike = {
  getFile(): Promise<{
    text(): Promise<string>;
  }>;
  createWritable(): Promise<{
    write(chunk: string): Promise<void>;
    close(): Promise<void>;
  }>;
};

type DirectoryHandleLike = {
  name: string;
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<DirectoryHandleLike>;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileHandleLike>;
};

export function buildInitialProjectBoard(_projectName: string): BoardSnapshot {
  const laneNames: BoardLane[] = ["Inbox", "In Progress", "Done"];

  return {
    path: ".pi/kanban/board.json",
    lanes: laneNames.map((name) => ({
      name,
      cards: [],
    })),
    cards: [],
    errors: [],
  };
}

export async function readProjectBoardFile(
  projectDirectory: DirectoryHandleLike,
): Promise<ProjectBoardReadResult> {
  try {
    const boardFile = await getBoardFileHandle(projectDirectory, false);
    const file = await boardFile.getFile();
    const parsed = JSON.parse(await file.text()) as unknown;
    if (!isBoardSnapshot(parsed)) {
      throw new Error("Invalid project board file");
    }

    return {
      status: "ready",
      board: parsed,
    };
  } catch (error) {
    if (isMissingEntryError(error)) {
      return {
        status: "missing",
      };
    }

    throw error;
  }
}

export async function createProjectBoardFile(
  projectDirectory: DirectoryHandleLike,
  board: BoardSnapshot,
): Promise<void> {
  const boardFile = await getBoardFileHandle(projectDirectory, true);
  const writable = await boardFile.createWritable();
  await writable.write(JSON.stringify(board, null, 2));
  await writable.close();
}

async function getBoardFileHandle(
  projectDirectory: DirectoryHandleLike,
  create: boolean,
): Promise<FileHandleLike> {
  let currentDirectory = projectDirectory;

  for (const segment of BOARD_DIRECTORY_SEGMENTS) {
    currentDirectory = await currentDirectory.getDirectoryHandle(segment, {
      create,
    });
  }

  return currentDirectory.getFileHandle(BOARD_FILE_NAME, {
    create,
  });
}

function isMissingEntryError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes("missing");
}

function isBoardSnapshot(value: unknown): value is BoardSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<BoardSnapshot>;
  return (
    typeof candidate.path === "string" &&
    Array.isArray(candidate.lanes) &&
    Array.isArray(candidate.cards) &&
    Array.isArray(candidate.errors)
  );
}
