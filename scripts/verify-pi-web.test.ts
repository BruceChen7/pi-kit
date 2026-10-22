import { describe, expect, it } from "vitest";
import {
  buildPlan,
  classifyCommands,
  judge,
  parseArgs,
  runDirName,
} from "./verify-pi-web.mjs";

describe("parseArgs", () => {
  it("rejects an unknown command", () => {
    expect(parseArgs([])).toEqual({
      ok: false,
      error: 'expected a command (serve, doctor, stop), got ""',
    });
  });

  it("collects repeated --plugin flags and expects a repeated --expect-command", () => {
    const parsed = parseArgs([
      "serve",
      "--plugin",
      "plan-mode",
      "--plugin",
      "skill-toggle",
      "--port",
      "30243",
    ]);
    expect(parsed.ok).toBe(true);
    expect(parsed.options.plugins).toEqual(["plan-mode", "skill-toggle"]);
    expect(parsed.options.port).toBe(30243);
    expect(parsed.options.expectCommands).toEqual([]);
  });

  it("rejects a flag without a value", () => {
    expect(parseArgs(["serve", "--plugin"]).ok).toBe(false);
    expect(parseArgs(["serve", "--port"])).toEqual({
      ok: false,
      error: "--port needs a value",
    });
  });

  it("rejects an out-of-range port", () => {
    expect(parseArgs(["serve", "--plugin", "x", "--port", "70000"])).toEqual({
      ok: false,
      error: '--port must be 1-65535, got "70000"',
    });
  });
});

describe("runDirName", () => {
  it("names the run after the plugin set", () => {
    expect(runDirName(["plan-mode", "skill-toggle"], "20261021-193000")).toBe(
      "20261021-193000-plan-mode+skill-toggle",
    );
  });
});

describe("buildPlan", () => {
  it("links shared plus every plugin from the repo into the isolated agent dir", () => {
    const built = buildPlan(
      { plugins: ["plan-mode", "shared"], port: 30242, cwd: "/tmp/project" },
      "20261021-193000",
    );
    expect(built.ok).toBe(true);
    expect(built.plan.agentDir.endsWith("agent")).toBe(true);
    expect(built.plan.baseUrl).toBe("http://127.0.0.1:30242");
    expect(
      built.plan.extensionLinks.map((link: { link: string }) =>
        link.link.split("/").at(-1),
      ),
    ).toEqual(["shared", "plan-mode"]);
  });

  it("refuses a run with no plugin", () => {
    const built = buildPlan({ plugins: [], port: 30242, cwd: "/tmp" }, "stamp");
    expect(built).toEqual({
      ok: false,
      error: "at least one --plugin is required for serve",
    });
  });

  it("refuses a duplicate plugin", () => {
    const built = buildPlan(
      { plugins: ["plan-mode", "plan-mode"], port: 30242, cwd: "/tmp" },
      "stamp",
    );
    expect(built).toEqual({ ok: false, error: "duplicate --plugin plan-mode" });
  });
});

describe("classifyCommands", () => {
  const agentDir = "/tmp/run/agent";

  it("only counts commands whose source path is inside this run's agent dir", () => {
    const { loaded, other } = classifyCommands(
      [
        {
          name: "toggle-skill",
          sourceInfo: {
            path: "/tmp/run/agent/extensions/skill-toggle/index.ts",
          },
        },
        {
          name: "skill:research",
          sourceInfo: {
            path: "/Users/someone/.agents/skills/research/SKILL.md",
          },
        },
        { name: "builtin" },
      ],
      agentDir,
    );
    expect(loaded).toEqual([
      {
        name: "toggle-skill",
        plugin: "skill-toggle",
        path: "/tmp/run/agent/extensions/skill-toggle/index.ts",
      },
    ]);
    expect(other).toEqual(["skill:research", "builtin"]);
  });

  it("does not treat a sibling directory as inside the agent dir", () => {
    const { loaded } = classifyCommands(
      [
        {
          name: "x",
          sourceInfo: { path: "/tmp/run/agent/extensions-other/x/index.ts" },
        },
      ],
      agentDir,
    );
    expect(loaded).toEqual([]);
  });
});

describe("judge", () => {
  const loaded = [
    { name: "plan-mode", plugin: "plan-mode", path: "/a/plan-mode/index.ts" },
  ];

  it("passes when every plugin and expected command is present", () => {
    expect(
      judge({
        plugins: ["plan-mode"],
        expectedCommands: ["plan-mode"],
        loaded,
      }),
    ).toEqual({
      ok: true,
      reasons: [],
      missingPlugins: [],
      missingCommands: [],
    });
  });

  it("separates a plugin that never loaded from a missing command", () => {
    const verdict = judge({
      plugins: ["btw"],
      expectedCommands: ["plan-mode"],
      loaded,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons).toEqual(["plugin not loaded: btw"]);
  });

  it("reports a registered plugin whose expected command is absent", () => {
    const verdict = judge({
      plugins: ["plan-mode"],
      expectedCommands: ["toggle-skill"],
      loaded,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons).toEqual(["command not registered: toggle-skill"]);
  });
});
