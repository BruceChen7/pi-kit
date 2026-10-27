import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  armForNewTask,
  type Catalog,
  decideGate,
  findRoute,
  isHiddenSkill,
  recordRouteAttempt,
  renderRouteResult,
  resolveCatalogPath,
  resolveStep,
  routePlaybooks,
  todoSeed,
  validateCatalog,
} from "./catalog.js";
import {
  buildModeParam,
  buildRouteParam,
  isPotetoInput,
  readPlaybooks,
  skillRoots,
} from "./index.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const catalogPath = join(repoRoot, "skills/poteto-playbooks/routes.json");
const fixturesPath = join(repoRoot, "extensions/poteto-route/fixtures.json");

type Fixture = { task: string; expect: string; note?: string };

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const loadCatalog = (): Catalog => {
  const validated = validateCatalog(
    JSON.parse(readFileSync(catalogPath, "utf8")),
  );
  if (!validated.ok) {
    throw new Error(`routes.json invalid: ${validated.problems.join("; ")}`);
  }
  return validated.catalog;
};

const roots = [join(repoRoot, ".pi/skills"), join(repoRoot, ".agents/skills")];

describe("catalog integrity", () => {
  const catalog = loadCatalog();

  it("resolves routes.json through the same skill roots the shell uses", () => {
    const found = resolveCatalogPath({
      roots: [join(repoRoot, "nope"), join(repoRoot, "skills")],
      exists: existsSync,
    });
    expect(found).toBe(catalogPath);
    expect(
      resolveCatalogPath({
        roots: [join(repoRoot, "nope")],
        exists: existsSync,
      }),
    ).toBeNull();
  });

  it("keeps route ids unique and disjoint from mode ids", () => {
    const routeIds = catalog.routes.map((route) => route.id);
    expect(new Set(routeIds).size).toBe(routeIds.length);
    for (const mode of catalog.modes) {
      expect(routeIds).not.toContain(mode.id);
    }
  });

  it("resolves every referenced skill on disk", () => {
    for (const route of catalog.routes) {
      const ids = [
        ...route.firstSteps,
        ...route.optionalSteps,
        ...route.closingSteps,
      ];
      for (const id of ids) {
        const resolved = resolveStep({ id, roots, readText });
        expect(resolved.ok, `${route.id} -> ${id}`).toBe(true);
      }
    }
  });

  it("resolves every playbook hint and mode playbook", () => {
    const baseDir = join(repoRoot, "skills/poteto-playbooks");
    for (const route of catalog.routes) {
      for (const hint of route.playbookHints) {
        expect(
          existsSync(join(baseDir, "playbooks", `${hint.playbook}.md`)),
          `${route.id} -> ${hint.playbook}`,
        ).toBe(true);
      }
    }
    for (const mode of catalog.modes) {
      expect(
        existsSync(join(baseDir, "playbooks", `${mode.playbook}.md`)),
        mode.id,
      ).toBe(true);
    }
  });

  it("accepts the same catalog through resolveCatalogPath order as poteto §0", () => {
    expect(skillRoots("/tmp/project")).toEqual([
      "/tmp/project/.pi/skills",
      "/tmp/project/.agents/skills",
      join(homedir(), ".agents/me-skills"),
    ]);
  });
});

describe("hidden skills", () => {
  it("marks disable-model-invocation skills as hidden but keeps their path", () => {
    for (const id of [
      "blast-radius",
      "benchmark-checklist",
      "create-verification-skill",
      "interrogate",
    ]) {
      const resolved = resolveStep({ id, roots, readText });
      expect(resolved.ok, id).toBe(true);
      if (!resolved.ok) continue;
      expect(resolved.step.hidden, id).toBe(true);
      expect(existsSync(resolved.step.path), resolved.step.path).toBe(true);
    }
  });

  it("reports the tried paths for an unknown id instead of degrading", () => {
    const resolved = resolveStep({ id: "no-such-skill", roots, readText });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.tried).toHaveLength(roots.length);
  });

  it("reads the hidden flag from frontmatter only", () => {
    expect(isHiddenSkill("---\nname: x\n---\nbody")).toBe(false);
    expect(
      isHiddenSkill("---\nname: x\ndisable-model-invocation: true\n---\n"),
    ).toBe(true);
    expect(isHiddenSkill("body mentions disable-model-invocation: true")).toBe(
      false,
    );
  });
});

describe("fixtures", () => {
  const catalog = loadCatalog();
  const fixtures = JSON.parse(readFileSync(fixturesPath, "utf8")) as Fixture[];

  it("keeps every expectation pointing at a real route", () => {
    for (const fixture of fixtures) {
      expect(findRoute(catalog, fixture.expect), fixture.task).toBeDefined();
    }
  });

  it("covers every route at least once", () => {
    const covered = new Set(fixtures.map((fixture) => fixture.expect));
    for (const route of catalog.routes) {
      expect(covered.has(route.id), route.id).toBe(true);
    }
  });
});

describe("route_task payload", () => {
  const catalog = loadCatalog();
  const route = findRoute(catalog, "bugfix");
  if (!route) throw new Error("missing bugfix route");

  const first = resolveStep({ id: "diagnosing-bugs", roots, readText });
  const closing = resolveStep({ id: "blast-radius", roots, readText });
  if (!first.ok || !closing.ok) throw new Error("missing skills");

  it("seeds the todo with route first", () => {
    expect(todoSeed(route, null)[0]).toBe("route: bugfix");
    expect(todoSeed(route, null)).toContain("/skill:blast-radius");
    expect(todoSeed(route, catalog.modes[0])[1]).toBe(
      `mode: ${catalog.modes[0].id}`,
    );
  });

  it("renders absolute paths, hidden notices and gates", () => {
    const text = renderRouteResult({
      route,
      mode: null,
      firstSteps: [first.step],
      optionalSteps: [],
      closingSteps: [closing.step],
      playbooks: [{ name: "diagnosing", text: "# Diagnosing\n\nbody" }],
      warnings: [],
    });
    expect(text).toContain(first.step.path);
    expect(text).toContain("先做这些 skill");
    expect(text).toContain("没有可复现路径时不得改代码");
    expect(text).toContain("body");
    for (const line of todoSeed(route, null)) {
      expect(text).toContain(`- ${line}`);
    }
  });

  it("hands closing steps the same absolute path and hidden flag", () => {
    const text = renderRouteResult({
      route,
      mode: null,
      firstSteps: [],
      optionalSteps: [],
      closingSteps: [closing.step],
      playbooks: [],
      warnings: [],
    });
    expect(text).toContain(closing.step.path);
    expect(text).toContain("disable-model-invocation: true");
    expect(text).not.toContain("收尾：/skill:");
  });

  it("surfaces missing optional steps as a warning, not a failure", () => {
    const text = renderRouteResult({
      route,
      mode: null,
      firstSteps: [first.step],
      optionalSteps: [],
      closingSteps: [closing.step],
      playbooks: [],
      warnings: ["swarm 找不到，查过：/x/.pi/skills/swarm/SKILL.md"],
    });
    expect(text).toContain("警告");
    expect(text).toContain("swarm 找不到");
    expect(text).toContain(first.step.path);
  });

  it("marks hidden steps in the rendered text", () => {
    const text = renderRouteResult({
      route,
      mode: null,
      firstSteps: [closing.step],
      optionalSteps: [],
      closingSteps: [],
      playbooks: [],
      warnings: [],
    });
    expect(text).toContain("disable-model-invocation: true");
  });

  it("asks for the mode playbook, not just the route hints", () => {
    const mode = catalog.modes.find((m) => m.id === "autonomous");
    if (!mode) throw new Error("missing autonomous mode");
    const perf = findRoute(catalog, "perf");
    if (!perf) throw new Error("missing perf route");

    expect(routePlaybooks(perf, null)).toEqual(["perf-issue"]);
    expect(routePlaybooks(perf, mode)).toEqual(["perf-issue", mode.playbook]);
    expect(routePlaybooks(route, null)).toEqual([]);
  });

  it("delivers the mode playbook body from the real catalog on disk", () => {
    const mode = catalog.modes.find((m) => m.id === "autonomous");
    const perf = findRoute(catalog, "perf");
    if (!mode || !perf) throw new Error("missing catalog entries");

    const read = readPlaybooks(
      join(repoRoot, "skills/poteto-playbooks"),
      routePlaybooks(perf, mode),
    );
    expect(read.problems).toEqual([]);
    expect(read.playbooks.map((entry) => entry.name)).toEqual([
      "perf-issue",
      mode.playbook,
    ]);
    expect(read.playbooks[1].text).toContain("autonomous-run");
  });
});

describe("gate", () => {
  it("blocks edit and write until a route exists", () => {
    for (const toolName of ["edit", "write"]) {
      expect(
        decideGate({ armed: true, routed: false, toolName }),
      ).toMatchObject({ block: true });
    }
  });

  it("opens up after route_task", () => {
    expect(
      decideGate({ armed: true, routed: true, toolName: "edit" }),
    ).toBeUndefined();
  });

  it("opens up even when route_task failed, so a wiring bug cannot brick the session", () => {
    const attempted = recordRouteAttempt(
      { armed: true, routed: false },
      "bugfix",
    );
    expect(decideGate({ ...attempted, toolName: "write" })).toBeUndefined();
  });

  it("re-arms on a new /poteto instead of inheriting the last route", () => {
    const routed = recordRouteAttempt({ armed: true, routed: false }, "bugfix");
    expect(decideGate({ ...routed, toolName: "edit" })).toBeUndefined();
    const nextTask = armForNewTask();
    expect(nextTask).toEqual({ armed: true, routed: false });
    expect(decideGate({ ...nextTask, toolName: "edit" })).toMatchObject({
      block: true,
    });
  });

  it("keeps mode optional when the catalog is missing", () => {
    const schema = Type.Object({
      route: buildRouteParam(null),
      mode: buildModeParam(null),
    });
    expect(Value.Check(schema, { route: "bugfix" })).toBe(true);
    expect(Value.Check(schema, { route: "bugfix", mode: "autonomous" })).toBe(
      true,
    );
  });

  it("stays out of the way when not armed", () => {
    expect(
      decideGate({ armed: false, routed: false, toolName: "write" }),
    ).toBeUndefined();
  });

  it("never blocks bash or read", () => {
    for (const toolName of ["bash", "read"]) {
      expect(
        decideGate({ armed: true, routed: false, toolName }),
      ).toBeUndefined();
    }
  });
});

describe("arming", () => {
  it("arms on /poteto and nothing else", () => {
    expect(isPotetoInput("/poteto 修一下登录 500")).toBe(true);
    expect(isPotetoInput("/poteto")).toBe(true);
    expect(isPotetoInput("/poteto-route status")).toBe(false);
    expect(isPotetoInput("跑一下 /poteto 流程")).toBe(false);
    expect(isPotetoInput("/potetox")).toBe(false);
  });
});

describe("prompt drift", () => {
  it("points the prompt at route_task and drops the old table", () => {
    const prompt = readFileSync(join(repoRoot, "prompts/poteto.md"), "utf8");
    expect(prompt).toContain("route_task");
    expect(prompt).not.toContain("| 类型     | 先做");
  });
});
