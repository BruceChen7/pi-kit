import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  discoverTasks,
  type ImportTaskModule,
  isTaskDefinition,
  isTaskDefinitionFile,
} from "./index.ts";
import { cleanupDir, tempDir } from "./tasks/test-utils.ts";

const validTask = {
  id: "alpha-task",
  every: "1h",
  handler: async () => {},
};

/** Create a fixture directory holding placeholder files/dirs for discovery. */
function fixtureDir(files: string[], dirs: string[] = []): string {
  const dir = tempDir("task-discovery-");
  for (const file of files) {
    writeFileSync(join(dir, file), "// fixture placeholder\n", "utf-8");
  }
  for (const name of dirs) {
    mkdirSync(join(dir, name));
  }
  return dir;
}

/**
 * Discovery owns module loading through an injected loader, so tests can drive
 * it with in-memory namespaces and record exactly which files were imported.
 */
function fakeLoader(
  modules: Record<string, unknown>,
  imported: string[],
): ImportTaskModule {
  return async (fileUrl) => {
    const name = basename(fileURLToPath(fileUrl));
    imported.push(name);
    if (!(name in modules)) {
      throw new Error(`module ${name} is not loadable`);
    }
    return { default: modules[name] };
  };
}

describe("isTaskDefinitionFile", () => {
  it("accepts plain task modules", () => {
    expect(isTaskDefinitionFile("bookmarks.ts")).toBe(true);
    expect(isTaskDefinitionFile("knowledge-wiki-daily.ts")).toBe(true);
  });

  it("rejects vitest test modules in the tasks directory", () => {
    expect(isTaskDefinitionFile("bookmarks.test.ts")).toBe(false);
    expect(isTaskDefinitionFile("bookmarks.spec.ts")).toBe(false);
  });

  it("rejects non-TypeScript entries", () => {
    expect(isTaskDefinitionFile("notes.md")).toBe(false);
    expect(isTaskDefinitionFile("bookmarks.ts.bak")).toBe(false);
  });
});

describe("isTaskDefinition", () => {
  it("accepts a minimal task definition", () => {
    expect(isTaskDefinition(validTask)).toBe(true);
  });

  it("accepts definitions with extra optional fields", () => {
    expect(isTaskDefinition({ ...validTask, description: "runs hourly" })).toBe(
      true,
    );
  });

  it("rejects a module-namespace default export (jiti CJS interop)", () => {
    // `import()` of a helper module without a default export yields
    // module.exports as `default` under pi's jiti loader — not a task.
    expect(isTaskDefinition({ pickTask: () => {} })).toBe(false);
    expect(isTaskDefinition({ tempDir: () => {}, cleanupDir: () => {} })).toBe(
      false,
    );
  });

  it("rejects values missing required fields", () => {
    expect(isTaskDefinition(undefined)).toBe(false);
    expect(isTaskDefinition(null)).toBe(false);
    expect(isTaskDefinition("alpha-task")).toBe(false);
    expect(
      isTaskDefinition({ id: "alpha-task", handler: async () => {} }),
    ).toBe(false);
    expect(
      isTaskDefinition({ id: "alpha-task", every: "1h", handler: "nope" }),
    ).toBe(false);
    expect(isTaskDefinition({ ...validTask, id: "" })).toBe(false);
  });
});

describe("discoverTasks", () => {
  it("registers only task definitions and never imports test modules", async () => {
    const dir = fixtureDir(
      [
        "alpha.ts",
        "alpha.test.ts",
        "alpha.spec.ts",
        "helper.ts",
        "broken.ts",
        "notes.md",
      ],
      ["sub"],
    );
    const imported: string[] = [];
    const loader = fakeLoader(
      {
        "alpha.ts": validTask,
        // Helper modules beside tasks export named helpers, not a task.
        "helper.ts": { pickTask: () => {} },
      },
      imported,
    );

    try {
      const tasks = await discoverTasks(dir, loader);

      expect(tasks.map((t) => t.id)).toEqual(["alpha-task"]);
      expect(imported.sort()).toEqual(["alpha.ts", "broken.ts", "helper.ts"]);
    } finally {
      cleanupDir(dir);
    }
  });

  it("keeps discovering tasks when a sibling module fails to load", async () => {
    const dir = fixtureDir(["broken.ts", "zeta.ts"]);
    const imported: string[] = [];
    const loader = fakeLoader(
      { "zeta.ts": { ...validTask, id: "zeta-task" } },
      imported,
    );

    try {
      const tasks = await discoverTasks(dir, loader);

      expect(tasks.map((t) => t.id)).toEqual(["zeta-task"]);
    } finally {
      cleanupDir(dir);
    }
  });

  it("returns no tasks for an empty directory", async () => {
    const dir = fixtureDir([]);

    try {
      const tasks = await discoverTasks(dir, async () => ({
        default: undefined,
      }));

      expect(tasks).toEqual([]);
    } finally {
      cleanupDir(dir);
    }
  });
});
