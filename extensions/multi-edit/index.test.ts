import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import multiEditExtension from "./index.js";

type Renderable = {
  render: (width: number) => string[];
};

type RegisteredTool = {
  name: string;
  renderCall?: (args: Record<string, unknown>, theme: TestTheme) => Renderable;
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

type TestTheme = {
  fg: (_color: string, text: string) => string;
  bold: (text: string) => string;
};

const testTheme: TestTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

function renderText(component: Renderable): string {
  return component.render(200).join("\n");
}

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

  multiEditExtension(pi as unknown as Parameters<typeof multiEditExtension>[0]);

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
  it("renders plugin identity and edit mode for tool calls", () => {
    const tool = registerToolForTest();
    const renderCall = tool.renderCall;

    expect(renderCall).toBeDefined();
    if (!renderCall) return;

    const cases: Array<{ args: Record<string, unknown>; expected: string }> = [
      {
        args: { path: "note.txt" },
        expected: "edit ⚡ multi-edit single note.txt",
      },
      {
        args: {
          multi: [
            { path: "a.txt", oldText: "one", newText: "1" },
            { path: "b.txt", oldText: "two", newText: "2" },
          ],
        },
        expected: "edit ⚡ multi-edit multi 2 edits / 2 files",
      },
      {
        args: { patch: "*** Begin Patch\n*** End Patch" },
        expected: "edit ⚡ multi-edit patch",
      },
      {
        args: {
          multi: [{ path: "a.txt", oldText: "one", newText: "1" }],
          patch: "",
          path: "",
          oldText: "",
          newText: "",
        },
        expected: "edit ⚡ multi-edit multi 1 edits / 1 files",
      },
    ];

    for (const { args, expected } of cases) {
      expect(renderText(renderCall(args, testTheme))).toContain(expected);
    }
  });

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

  it("treats empty optional fields as absent placeholders", async () => {
    const cases = [
      {
        name: "multi with empty patch/path/oldText/newText",
        params: {
          multi: [{ path: "note.txt", oldText: "before", newText: "after" }],
          newText: "",
          oldText: "",
          patch: "",
          path: "",
        },
        resultText: "Edited note.txt",
        expectedContent: "after\n",
      },
      {
        name: "patch with an empty multi array",
        params: {
          multi: [],
          newText: "",
          oldText: "",
          patch: `*** Begin Patch
*** Update File: note.txt
-before
+after
*** End Patch`,
          path: "",
        },
        resultText: "Applied patch with 1 operation(s)",
        expectedContent: "after\n",
      },
    ];

    for (const { name, params, resultText, expectedContent } of cases) {
      const cwd = await createTempDir();
      await writeFile(join(cwd, "note.txt"), "before\n", "utf8");

      const result = await executeEdit(registerToolForTest(), cwd, params);

      expect(result.content[0]?.text, name).toContain(resultText);
      expect(await readFile(join(cwd, "note.txt"), "utf8"), name).toBe(
        expectedContent,
      );
    }
  });

  it("still rejects a patch combined with a non-empty multi", async () => {
    const cwd = await createTempDir();
    await writeFile(join(cwd, "note.txt"), "before\n", "utf8");

    await expect(
      executeEdit(registerToolForTest(), cwd, {
        multi: [{ path: "note.txt", oldText: "before", newText: "after" }],
        patch: "*** Begin Patch\n*** End Patch",
      }),
    ).rejects.toThrow("mutually exclusive");

    expect(await readFile(join(cwd, "note.txt"), "utf8")).toBe("before\n");
  });

  it("supports single edits that delete text via an empty newText", async () => {
    const cwd = await createTempDir();
    await writeFile(join(cwd, "note.txt"), "before\n", "utf8");

    const result = await executeEdit(registerToolForTest(), cwd, {
      path: "note.txt",
      oldText: "before",
      newText: "",
    });

    expect(result.content[0]?.text).toContain("Edited note.txt");
    expect(await readFile(join(cwd, "note.txt"), "utf8")).toBe("\n");
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

  it("serializes concurrent same-file edits so both land", async () => {
    // Pi executes sibling tool calls from one assistant message in parallel.
    // Two concurrent edit calls on the same file must both land; without the
    // per-file mutation queue both read the same original content and the
    // last write silently drops the other edit.
    const cwd = await createTempDir();
    await writeFile(join(cwd, "note.txt"), "one two\n", "utf8");

    const tool = registerToolForTest();
    const [r1, r2] = await Promise.all([
      executeEdit(tool, cwd, {
        path: "note.txt",
        oldText: "one",
        newText: "1",
      }),
      executeEdit(tool, cwd, {
        path: "note.txt",
        oldText: "two",
        newText: "2",
      }),
    ]);

    expect(r1.content[0]?.text).toContain("Edited note.txt");
    expect(r2.content[0]?.text).toContain("Edited note.txt");
    expect(await readFile(join(cwd, "note.txt"), "utf8")).toBe("1 2\n");
  });

  it("serializes concurrent same-file patch updates so both land", async () => {
    const cwd = await createTempDir();
    await writeFile(join(cwd, "note.txt"), "one\ntwo\n", "utf8");

    const tool = registerToolForTest();
    const patchFor = (oldText: string, newText: string) => ({
      patch: `*** Begin Patch
*** Update File: note.txt
-${oldText}
+${newText}
*** End Patch`,
    });
    const [r1, r2] = await Promise.all([
      executeEdit(tool, cwd, patchFor("one", "1")),
      executeEdit(tool, cwd, patchFor("two", "2")),
    ]);

    expect(r1.content[0]?.text).toContain("Applied patch with 1 operation(s)");
    expect(r2.content[0]?.text).toContain("Applied patch with 1 operation(s)");
    expect(await readFile(join(cwd, "note.txt"), "utf8")).toBe("1\n2\n");
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

  it("does not report unapplied edits as 'Edited' when preflight fails", async () => {
    // Regression: the preflight failure report used to print
    // "✓ Edit N/M (...): Edited ..." for edits that only passed the virtual
    // simulation, implying they were written. The model then saw the file
    // unchanged and concluded the batch had been "silently reverted".
    const cwd = await createTempDir();
    await writeFile(
      join(cwd, "plan.md"),
      "line one\nline two\nline three\n",
      "utf8",
    );

    let error: Error | undefined;
    try {
      await executeEdit(registerToolForTest(), cwd, {
        multi: [
          { path: "plan.md", oldText: "line one", newText: "ONE" },
          { path: "plan.md", oldText: "missing line", newText: "X" },
        ],
      });
    } catch (err) {
      error = err as Error;
    }

    expect(error).toBeDefined();
    const message = error?.message ?? "";
    expect(message).toContain("Preflight failed before mutating files");
    // The preflight-passing edit was simulated only — never written. It must
    // not carry the "✓ ... Edited" wording of a real write.
    expect(message).not.toMatch(/✓ Edit \d+\/\d+ .*: Edited/);
    // ... and must be explicitly marked as not applied.
    expect(message).toContain("not applied");
    // The failing edit still reports the reason.
    expect(message).toContain("Could not find the exact text");
    // Nothing was written.
    expect(await readFile(join(cwd, "plan.md"), "utf8")).toBe(
      "line one\nline two\nline three\n",
    );
  });
});
