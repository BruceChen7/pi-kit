import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import multiEditExtension from "./index.js";

type RegisteredTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: unknown,
    ctx: { cwd: string },
  ) => Promise<{
    content: Array<{ text: string }>;
    details?: Record<string, unknown>;
  }>;
};

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-kit-multi-edit-"));
  tempDirs.push(dir);
  return dir;
}

function registerToolForTest(): RegisteredTool {
  const tools = new Map<string, RegisteredTool>();
  const pi = {
    registerTool: vi.fn((tool: RegisteredTool) => tools.set(tool.name, tool)),
  };

  multiEditExtension(pi as Parameters<typeof multiEditExtension>[0]);

  const tool = tools.get("edit");
  if (!tool) throw new Error("Expected edit tool to be registered");
  return tool;
}

async function executeEdit(
  tool: RegisteredTool,
  cwd: string,
  params: Record<string, unknown>,
) {
  return tool.execute(
    "test-call",
    params,
    new AbortController().signal,
    undefined,
    { cwd },
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("multi-edit tool", () => {
  it("keeps single replacement compatible with the built-in edit parameters", async () => {
    const cwd = await createTempDir();
    await writeFile(join(cwd, "note.txt"), "hello old world\n", "utf8");

    const result = await executeEdit(registerToolForTest(), cwd, {
      path: "note.txt",
      oldText: "old",
      newText: "new",
    });

    expect(result.content[0]?.text).toContain("Edited note.txt");
    expect(await readFile(join(cwd, "note.txt"), "utf8")).toBe(
      "hello new world\n",
    );
  });

  it("applies multi edits across files after a successful preflight", async () => {
    const cwd = await createTempDir();
    await writeFile(join(cwd, "a.txt"), "alpha one\n", "utf8");
    await writeFile(join(cwd, "b.txt"), "beta two\n", "utf8");

    const result = await executeEdit(registerToolForTest(), cwd, {
      multi: [
        { path: "a.txt", oldText: "one", newText: "1" },
        { path: "b.txt", oldText: "two", newText: "2" },
      ],
    });

    expect(result.content[0]?.text).toContain("Applied 2 edit(s) successfully");
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("alpha 1\n");
    expect(await readFile(join(cwd, "b.txt"), "utf8")).toBe("beta 2\n");
  });

  it("applies patch add, update, and delete operations", async () => {
    const cwd = await createTempDir();
    await writeFile(join(cwd, "existing.txt"), "before\n", "utf8");
    await writeFile(join(cwd, "remove.txt"), "delete me\n", "utf8");

    const result = await executeEdit(registerToolForTest(), cwd, {
      patch: `*** Begin Patch
*** Update File: existing.txt
-before
+after
*** Add File: added.txt
+created
*** Delete File: remove.txt
*** End Patch`,
    });

    expect(result.content[0]?.text).toContain(
      "Applied patch with 3 operation(s)",
    );
    expect(await readFile(join(cwd, "existing.txt"), "utf8")).toBe("after\n");
    expect(await readFile(join(cwd, "added.txt"), "utf8")).toBe("created\n");
    await expect(readFile(join(cwd, "remove.txt"), "utf8")).rejects.toThrow();
  });

  it("does not mutate real files when preflight fails", async () => {
    const cwd = await createTempDir();
    await writeFile(join(cwd, "a.txt"), "old\n", "utf8");

    await expect(
      executeEdit(registerToolForTest(), cwd, {
        multi: [
          { path: "a.txt", oldText: "old", newText: "new" },
          { path: "a.txt", oldText: "missing", newText: "x" },
        ],
      }),
    ).rejects.toThrow("Preflight failed before mutating files");

    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("old\n");
  });
});
