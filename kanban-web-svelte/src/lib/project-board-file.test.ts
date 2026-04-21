import { describe, expect, it } from "vitest";

import {
  buildInitialProjectBoard,
  createProjectBoardFile,
  readProjectBoardFile,
} from "./project-board-file";

type FakeWritable = {
  writtenText: string | null;
  write: (chunk: string) => Promise<void>;
  close: () => Promise<void>;
};

class FakeFileHandle {
  public writtenText: string | null = null;
  private readonly textValue: string | null;

  constructor(textValue: string | null = null) {
    this.textValue = textValue;
  }

  async getFile(): Promise<{ text: () => Promise<string> }> {
    const nextText = this.writtenText ?? this.textValue;
    if (nextText === null) {
      throw new Error("file missing");
    }

    return {
      text: async () => nextText,
    };
  }

  async createWritable(): Promise<FakeWritable> {
    return {
      writtenText: this.writtenText,
      write: async (chunk: string) => {
        this.writtenText = chunk;
      },
      close: async () => {},
    };
  }
}

class FakeDirectoryHandle {
  public readonly directories = new Map<string, FakeDirectoryHandle>();
  public readonly files = new Map<string, FakeFileHandle>();

  constructor(public readonly name: string) {}

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FakeDirectoryHandle> {
    const existing = this.directories.get(name);
    if (existing) {
      return existing;
    }

    if (!options?.create) {
      throw new Error(`directory missing: ${name}`);
    }

    const created = new FakeDirectoryHandle(name);
    this.directories.set(name, created);
    return created;
  }

  async getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FakeFileHandle> {
    const existing = this.files.get(name);
    if (existing) {
      return existing;
    }

    if (!options?.create) {
      throw new Error(`file missing: ${name}`);
    }

    const created = new FakeFileHandle();
    this.files.set(name, created);
    return created;
  }
}

describe("buildInitialProjectBoard", () => {
  it("creates an empty project board with inbox, in progress, and done lanes", () => {
    const board = buildInitialProjectBoard("demo-project");

    expect(board.path).toBe(".pi/kanban/board.json");
    expect(board.cards).toEqual([]);
    expect(board.errors).toEqual([]);
    expect(board.lanes.map((lane) => lane.name)).toEqual([
      "Inbox",
      "In Progress",
      "Done",
    ]);
  });
});

describe("project board files", () => {
  it("creates the nested board file and reads it back", async () => {
    const root = new FakeDirectoryHandle("demo-project");

    await createProjectBoardFile(root, buildInitialProjectBoard("demo-project"));

    const loaded = await readProjectBoardFile(root);

    expect(loaded.status).toBe("ready");
    if (loaded.status !== "ready") {
      throw new Error("expected board to be ready");
    }

    expect(loaded.board.lanes.map((lane) => lane.name)).toEqual([
      "Inbox",
      "In Progress",
      "Done",
    ]);
  });

  it("throws a clear error when the board file is invalid", async () => {
    const root = new FakeDirectoryHandle("demo-project");
    const piDirectory = await root.getDirectoryHandle(".pi", { create: true });
    const kanbanDirectory = await piDirectory.getDirectoryHandle("kanban", {
      create: true,
    });
    kanbanDirectory.files.set("board.json", new FakeFileHandle('{"foo":true}'));

    await expect(readProjectBoardFile(root)).rejects.toThrow(
      "Invalid project board file",
    );
  });
});
