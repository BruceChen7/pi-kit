import { describe, expect, it } from "vitest";
import { readSquadReport } from "./io.ts";
import type { SquadAgentState, SquadReport, SquadState } from "./shared.ts";
import {
  buildAgentCommand,
  buildChildPrompt,
  buildSplitPlan,
  formatAgentList,
  formatReport,
  normalizeDisplayText,
  parseSquadReportJSON,
  publicSquadDetails,
  reportFileName,
  resolveSplitTarget,
  shellQuote,
  validateExplicitModel,
  validateStartParams,
  verifyManifestAgent,
} from "./shared.ts";

// ─── normalizeDisplayText ────────────────────────────────────────────

describe("normalizeDisplayText", () => {
  it("trims and truncates to maxLength", () => {
    expect(normalizeDisplayText("  hello world  ", 5)).toBe("hello");
  });

  it("replaces control characters with spaces", () => {
    expect(normalizeDisplayText("abc\u0000def\u001fghi", 20)).toBe(
      "abc def ghi",
    );
  });

  it("collapses whitespace", () => {
    expect(normalizeDisplayText("a   b\t\tc", 10)).toBe("a b c");
  });

  it("handles empty string", () => {
    expect(normalizeDisplayText("", 10)).toBe("");
  });

  it("handles maxLength shorter than string", () => {
    expect(normalizeDisplayText("abcdefghij", 3)).toBe("abc");
  });

  it("handles multi-byte characters", () => {
    expect(normalizeDisplayText("你好世界", 2)).toBe("你好");
  });
});

// ─── shellQuote ──────────────────────────────────────────────────────

describe("shellQuote", () => {
  it("wraps simple string in single quotes", () => {
    expect(shellQuote("hello")).toBe("'hello'");
  });

  it("handles single quotes inside string", () => {
    expect(shellQuote("it's")).toBe(`'it'"'"'s'`);
  });

  it("handles empty string", () => {
    expect(shellQuote("")).toBe("''");
  });
});

// ─── reportFileName ──────────────────────────────────────────────────

describe("reportFileName", () => {
  it("generates correct filename", () => {
    expect(reportFileName("abc-1")).toBe("report-abc-1.json");
  });
});

// ─── buildChildPrompt ────────────────────────────────────────────────

describe("buildChildPrompt", () => {
  it("includes task, label, scope, instructions", () => {
    const result = buildChildPrompt(
      "Investigate auth failure",
      "Agent A",
      "auth module",
      "Check login flow",
    );
    expect(result).toContain("Investigate auth failure");
    expect(result).toContain("Agent A");
    expect(result).toContain("auth module");
    expect(result).toContain("Check login flow");
  });

  it("includes non-negotiable boundaries", () => {
    const result = buildChildPrompt("t", "l", "s", "i");
    expect(result).toContain("read-only");
    expect(result).toContain("herdr_squad_report");
    expect(result).toContain("Do not edit");
  });
});

// ─── validateStartParams ─────────────────────────────────────────────

function fakeCrypto() {
  let counter = 0;
  return {
    randomUUID: () => {
      counter++;
      return `00000000-0000-4000-a000-${String(counter).padStart(12, "0")}`;
    },
    randomBytes: () =>
      Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef", "hex"),
  };
}

describe("validateStartParams", () => {
  const validParams = {
    task: "Investigate checkout failure",
    count: 2,
    assignments: [
      { label: "Frontend", scope: "checkout page", prompt: "Check UI flow" },
      { label: "Backend", scope: "order API", prompt: "Check API logic" },
    ],
    title: "Checkout Investigation",
  };

  const validEnv = { HERDR_ENV: "1", HERDR_PANE_ID: "pane-42" };
  const crypto = fakeCrypto();

  it("returns validated params for valid input", () => {
    const result = validateStartParams(validParams, validEnv, crypto, () => ({
      source: "pi-default" as const,
    }));

    expect(result.task).toBe("Investigate checkout failure");
    expect(result.normalizedAssignments).toHaveLength(2);
    expect(result.parentPaneId).toBe("pane-42");
    expect(result.squadId).toBeTruthy();
    expect(result.shortId).toBeTruthy();
    expect(result.title).toBe("Checkout Investigation");
    expect(result.tabLabel).toContain("Checkout Investigation");
    expect(result.manifestAgents).toHaveLength(2);
    expect(result.agents).toHaveLength(2);
  });

  it("throws when HERDR_ENV is not set", () => {
    expect(() =>
      validateStartParams(validParams, {}, crypto, () => ({
        source: "pi-default" as const,
      })),
    ).toThrow("Herdr squads are available only inside a Herdr-managed Pi pane");
  });

  it("throws when count is out of range", () => {
    expect(() =>
      validateStartParams(
        { ...validParams, count: 0 },
        validEnv,
        crypto,
        () => ({ source: "pi-default" as const }),
      ),
    ).toThrow("count must be an integer from 1 through 4");
  });

  it("throws when count does not match assignments length", () => {
    expect(() =>
      validateStartParams(
        { ...validParams, count: 3 },
        validEnv,
        crypto,
        () => ({ source: "pi-default" as const }),
      ),
    ).toThrow("Expected exactly 3 assignments");
  });

  it("throws when task is empty", () => {
    expect(() =>
      validateStartParams(
        { ...validParams, task: "" },
        validEnv,
        crypto,
        () => ({ source: "pi-default" as const }),
      ),
    ).toThrow("task must not be empty");
  });

  it("throws when labels have duplicates", () => {
    expect(() =>
      validateStartParams(
        {
          ...validParams,
          assignments: [
            { label: "Same", scope: "area1", prompt: "p1" },
            { label: "Same", scope: "area2", prompt: "p2" },
          ],
        },
        validEnv,
        crypto,
        () => ({ source: "pi-default" as const }),
      ),
    ).toThrow("Assignment labels must be unique");
  });

  it("throws when scopes have duplicates", () => {
    expect(() =>
      validateStartParams(
        {
          ...validParams,
          assignments: [
            { label: "A", scope: "same scope", prompt: "p1" },
            { label: "B", scope: "same scope", prompt: "p2" },
          ],
        },
        validEnv,
        crypto,
        () => ({ source: "pi-default" as const }),
      ),
    ).toThrow("Assignment scopes must not be exact duplicates");
  });

  it("throws when HERDR_PANE_ID is missing", () => {
    expect(() =>
      validateStartParams(validParams, { HERDR_ENV: "1" }, crypto, () => ({
        source: "pi-default" as const,
      })),
    ).toThrow("HERDR_PANE_ID is unavailable");
  });

  it("resolves model from explicit param", () => {
    const result = validateStartParams(
      { ...validParams, model: "openai-codex/gpt-5.6-terra" },
      validEnv,
      crypto,
      () => ({ source: "pi-default" as const }),
    );
    expect(result.model).toBe("openai-codex/gpt-5.6-terra");
    expect(result.modelSource).toBe("explicit");
  });

  it("resolves model from config when no explicit model", () => {
    const result = validateStartParams(validParams, validEnv, crypto, () => ({
      model: "claude-sonnet-4",
      source: "global" as const,
    }));
    expect(result.model).toBe("claude-sonnet-4");
    expect(result.modelSource).toBe("global");
  });

  it("falls back to pi-default when no model configured", () => {
    const result = validateStartParams(validParams, validEnv, crypto, () => ({
      source: "pi-default" as const,
    }));
    expect(result.model).toBeUndefined();
    expect(result.modelSource).toBe("pi-default");
  });
});

// ─── parseSquadReportJSON ────────────────────────────────────────────

describe("parseSquadReportJSON", () => {
  it("returns undefined for invalid JSON", () => {
    expect(parseSquadReportJSON("not-json")).toBeUndefined();
  });

  it("returns undefined for non-object JSON", () => {
    expect(parseSquadReportJSON('"string"')).toBeUndefined();
    expect(parseSquadReportJSON("42")).toBeUndefined();
    expect(parseSquadReportJSON("null")).toBeUndefined();
  });

  it("returns undefined when required fields are missing", () => {
    expect(parseSquadReportJSON('{"version":1}')).toBeUndefined();
    expect(
      parseSquadReportJSON('{"version":1,"squadId":"sq-1"}'),
    ).toBeUndefined();
  });

  it("returns undefined when version is not 1", () => {
    const invalidVersion = {
      version: 2 as 1,
      squadId: "sq-1",
      agentId: "ag-1",
      label: "A",
      scope: "s",
      createdAt: "2025-01-01",
      findings: "f",
      evidence: [],
      risksOrUnknowns: [],
      recommendedNextStep: "n",
    };
    expect(
      parseSquadReportJSON(JSON.stringify(invalidVersion)),
    ).toBeUndefined();
  });

  it("returns report for valid JSON", () => {
    const report: SquadReport = {
      version: 1,
      squadId: "sq-1",
      agentId: "ag-1",
      label: "Agent A",
      scope: "test",
      createdAt: "2025-01-01T00:00:00.000Z",
      findings: "Found nothing",
      evidence: ["file.ts"],
      risksOrUnknowns: ["risk1"],
      recommendedNextStep: "Stop",
    };
    const result = parseSquadReportJSON(JSON.stringify(report));
    expect(result).toBeDefined();
    expect(result?.squadId).toBe("sq-1");
    expect(result?.findings).toBe("Found nothing");
  });

  it("returns undefined when evidence is not string array", () => {
    const base = {
      version: 1 as 1,
      squadId: "sq-1",
      agentId: "ag-1",
      label: "A",
      scope: "s",
      createdAt: "2025-01-01",
      findings: "f",
      evidence: [],
      risksOrUnknowns: [],
      recommendedNextStep: "n",
    };
    expect(
      parseSquadReportJSON(JSON.stringify({ ...base, evidence: [42] })),
    ).toBeUndefined();
    expect(
      parseSquadReportJSON(JSON.stringify({ ...base, evidence: "not-array" })),
    ).toBeUndefined();
  });

  it("returns undefined when risksOrUnknowns is not string array", () => {
    const base = {
      version: 1 as 1,
      squadId: "sq-1",
      agentId: "ag-1",
      label: "A",
      scope: "s",
      createdAt: "2025-01-01",
      findings: "f",
      evidence: [],
      risksOrUnknowns: [],
      recommendedNextStep: "n",
    };
    expect(
      parseSquadReportJSON(
        JSON.stringify({ ...base, risksOrUnknowns: [true] }),
      ),
    ).toBeUndefined();
  });
});

// ─── readSquadReport (IO integration) ────────────────────────────────

describe("readSquadReport", () => {
  it("returns undefined when file does not exist", async () => {
    expect(await readSquadReport("/nonexistent/path.json")).toBeUndefined();
  });

  it("reads and parses a valid report file", async () => {
    const { writeFile, rm, mkdtemp } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "test-herdr-"));
    const file = join(dir, "test.json");
    const validReport = {
      version: 1,
      squadId: "sq-1",
      agentId: "ag-1",
      label: "A",
      scope: "s",
      createdAt: "2025-01-01T00:00:00.000Z",
      findings: "f",
      evidence: [],
      risksOrUnknowns: [],
      recommendedNextStep: "n",
    };
    await writeFile(file, JSON.stringify(validReport));
    expect((await readSquadReport(file))?.squadId).toBe("sq-1");
    await rm(dir, { recursive: true, force: true });
  });
});

// ─── formatAgentList ─────────────────────────────────────────────────

describe("formatAgentList", () => {
  it("lists all agents with label, scope, paneId", () => {
    const state: SquadState = {
      version: 1,
      squadId: "sq-abc123",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      cwd: "/some/cwd",
      workspaceId: "ws-1",
      tabId: "tab-1",
      tabLabel: "Investigation · sq-abc123",
      rootPaneId: "pane-root",
      runDir: "/tmp/pi-herdr-squad-xxx",
      task: "Investigate",
      title: "My Investigation",
      model: "claude-sonnet-4",
      modelSource: "global",
      status: "running",
      agents: [
        {
          agentId: "abc-1",
          label: "Agent A",
          paneLabel: "Agent A · abc-1",
          scope: "auth module",
          paneId: "pane-1",
          reportPath: "/tmp/report-abc-1.json",
          promptPath: "/tmp/prompt-abc-1.md",
          lastAgentStatus: "running",
        },
        {
          agentId: "abc-2",
          label: "Agent B",
          paneLabel: "Agent B · abc-2",
          scope: "billing",
          paneId: "pane-2",
          reportPath: "/tmp/report-abc-2.json",
          promptPath: "/tmp/prompt-abc-2.md",
          lastAgentStatus: "running",
        },
      ],
    };
    const result = formatAgentList(state);
    expect(result).toContain("Agent A");
    expect(result).toContain("auth module");
    expect(result).toContain("pane-1");
    expect(result).toContain("Agent B");
    expect(result).toContain("billing");
    expect(result).toContain("pane-2");
  });

  it("shows 'not created' when paneId is empty", () => {
    const state: SquadState = {
      version: 1,
      squadId: "sq-xyz",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      cwd: "/cwd",
      workspaceId: "ws-1",
      tabId: "tab-1",
      tabLabel: "Test · sq-xyz",
      rootPaneId: "pane-root",
      runDir: "/tmp/pi-herdr-squad-xxx",
      task: "Test",
      title: "Test",
      modelSource: "pi-default",
      status: "launching",
      agents: [
        {
          agentId: "xyz-1",
          label: "Agent X",
          paneLabel: "Agent X · xyz-1",
          scope: "scope-1",
          paneId: "",
          reportPath: "/tmp/report.json",
          promptPath: "/tmp/prompt.md",
        },
      ],
    };
    expect(formatAgentList(state)).toContain("not created");
  });
});

// ─── publicSquadDetails ──────────────────────────────────────────────

describe("publicSquadDetails", () => {
  it("returns a plain object with squad metadata and agent summaries", () => {
    const state: SquadState = {
      version: 1,
      squadId: "sq-abc123",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      cwd: "/cwd",
      workspaceId: "ws-1",
      tabId: "tab-1",
      tabLabel: "Investigation · sq-abc123",
      rootPaneId: "pane-root",
      runDir: "/tmp/xxx",
      task: "Investigate",
      title: "My Investigation",
      model: "claude-sonnet-4",
      modelSource: "global",
      status: "running",
      agents: [
        {
          agentId: "abc-1",
          label: "Agent A",
          paneLabel: "Agent A · abc-1",
          scope: "auth",
          paneId: "pane-1",
          reportPath: "/tmp/r1.json",
          promptPath: "/tmp/p1.md",
          lastAgentStatus: "running",
        },
      ],
      failure: "something went wrong",
    };
    const details = publicSquadDetails(state);
    expect(details.squadId).toBe("sq-abc123");
    expect(details.status).toBe("running");
    expect(details.agents).toHaveLength(1);
    expect(details.agents[0].label).toBe("Agent A");
    expect(details.agents[0].paneId).toBe("pane-1");
    expect(details.failure).toBe("something went wrong");
  });

  it("excludes agent internals like reportPath and promptPath", () => {
    const state: SquadState = {
      version: 1,
      squadId: "sq-xyz",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      cwd: "/cwd",
      workspaceId: "ws-1",
      tabId: "tab-1",
      tabLabel: "Test · sq-xyz",
      rootPaneId: "pane-root",
      runDir: "/tmp/xxx",
      task: "Test",
      title: "Test",
      modelSource: "pi-default",
      status: "launching",
      agents: [
        {
          agentId: "xyz-1",
          label: "A",
          paneLabel: "A · xyz-1",
          scope: "s",
          paneId: "",
          reportPath: "/tmp/secret-report.json",
          promptPath: "/tmp/secret-prompt.md",
        },
      ],
    };
    const details = publicSquadDetails(state);
    expect(details.agents[0]).not.toHaveProperty("reportPath");
    expect(details.agents[0]).not.toHaveProperty("promptPath");
    expect(details.agents[0]).not.toHaveProperty("agentId");
  });
});

// ─── formatReport ────────────────────────────────────────────────────

describe("formatReport", () => {
  it("formats a complete report into sections", () => {
    const report: SquadReport = {
      version: 1,
      squadId: "sq-abc",
      agentId: "ag-1",
      label: "Agent A",
      scope: "auth module",
      createdAt: "2025-01-01T00:00:00.000Z",
      findings: "Found a bug in login",
      evidence: ["src/auth/login.ts:42", "src/auth/session.ts:15"],
      risksOrUnknowns: ["Rate limiting behavior untested"],
      recommendedNextStep: "Add rate limiting tests",
    };
    const result = formatReport(report, "/tmp/report.json");
    expect(result).toContain("Agent A");
    expect(result).toContain("auth module");
    expect(result).toContain("Found a bug in login");
    expect(result).toContain("src/auth/login.ts:42");
    expect(result).toContain("Rate limiting behavior untested");
    expect(result).toContain("Add rate limiting tests");
    expect(result).toContain("/tmp/report.json");
  });

  it("returns empty string for undefined report", () => {
    expect(formatReport(undefined, "/path")).toBe("");
  });

  it("shows 'None reported' when evidence and risks are empty", () => {
    const report: SquadReport = {
      version: 1,
      squadId: "sq-abc",
      agentId: "ag-1",
      label: "A",
      scope: "s",
      createdAt: "2025-01-01T00:00:00.000Z",
      findings: "Nothing",
      evidence: [],
      risksOrUnknowns: [],
      recommendedNextStep: "Stop",
    };
    const result = formatReport(report, "/path");
    expect(result).toContain("None reported");
  });
});

// ─── verifyManifestAgent ─────────────────────────────────────────────

describe("verifyManifestAgent", () => {
  const validManifest: import("./shared.ts").SquadManifest = {
    version: 1,
    squadId: "sq-abc123",
    agents: [
      { agentId: "abc-1", token: "token-abc", label: "A", scope: "auth" },
      { agentId: "abc-2", token: "token-xyz", label: "B", scope: "billing" },
    ],
  };

  it("returns agent when credentials match", () => {
    const agent = verifyManifestAgent(
      validManifest,
      "sq-abc123",
      "abc-1",
      "token-abc",
    );
    expect(agent).toBeDefined();
    expect(agent?.label).toBe("A");
  });

  it("returns undefined when version mismatch", () => {
    expect(
      verifyManifestAgent(
        { ...validManifest, version: 2 as 1 },
        "sq-abc123",
        "abc-1",
        "token-abc",
      ),
    ).toBeUndefined();
  });

  it("returns undefined when squadId mismatch", () => {
    expect(
      verifyManifestAgent(validManifest, "wrong-squad", "abc-1", "token-abc"),
    ).toBeUndefined();
  });

  it("returns undefined when agentId not found", () => {
    expect(
      verifyManifestAgent(
        validManifest,
        "sq-abc123",
        "nonexistent",
        "token-abc",
      ),
    ).toBeUndefined();
  });

  it("returns undefined when token mismatch", () => {
    expect(
      verifyManifestAgent(validManifest, "sq-abc123", "abc-1", "wrong-token"),
    ).toBeUndefined();
  });

  it("returns undefined when agents array is empty", () => {
    expect(
      verifyManifestAgent(
        { ...validManifest, agents: [] },
        "sq-abc123",
        "abc-1",
        "token-abc",
      ),
    ).toBeUndefined();
  });
});

// ─── validateExplicitModel ───────────────────────────────────────────

describe("validateExplicitModel", () => {
  it("returns trimmed value for valid input", () => {
    expect(validateExplicitModel("  gpt-4  ")).toBe("gpt-4");
  });

  it("throws when value is empty after trim", () => {
    expect(() => validateExplicitModel("  ")).toThrow(
      "Explicit model value is empty or exceeds 200 characters",
    );
  });

  it("throws when value exceeds 200 characters", () => {
    expect(() => validateExplicitModel("x".repeat(201))).toThrow(
      "Explicit model value is empty or exceeds 200 characters",
    );
  });

  it("accepts value at exactly 200 characters", () => {
    const value = "x".repeat(200);
    expect(validateExplicitModel(value)).toBe(value);
  });
});

// ─── buildSplitPlan ──────────────────────────────────────────────────

describe("buildSplitPlan", () => {
  it("returns empty for count 0", () => {
    expect(buildSplitPlan(0)).toEqual([]);
  });

  it("returns empty for count 1", () => {
    expect(buildSplitPlan(1)).toEqual([]);
  });

  it("returns two splits for count 2 (in-tab mode)", () => {
    const plan = buildSplitPlan(2);
    expect(plan).toHaveLength(2);
    expect(plan[0].direction).toBe("right");
    expect(plan[0].targetIndex).toBe(0);
    expect(plan[0].targetRef).toBe("parent");
    expect(plan[1].direction).toBe("down");
    expect(plan[1].targetIndex).toBe(1);
    expect(plan[1].targetRef).toBe(0);
  });

  it("returns right + bottom splits for count 3", () => {
    const plan = buildSplitPlan(3);
    expect(plan).toHaveLength(2);
    expect(plan[0].direction).toBe("right");
    expect(plan[0].targetIndex).toBe(1);
    expect(plan[1].direction).toBe("down");
    expect(plan[1].targetIndex).toBe(2);
  });

  it("includes dependsOnAgentOne for count 4 third split", () => {
    const plan = buildSplitPlan(4);
    expect(plan).toHaveLength(3);
    expect(plan[2].dependsOnAgentOne).toBe(true);
    expect(plan[2].direction).toBe("down");
    expect(plan[2].targetIndex).toBe(3);
  });

  it("count 2 plan has consistent dependency chain", () => {
    const plan = buildSplitPlan(2);
    // Step 0: split parent pane right → agent[0]'s pane
    expect(plan[0].targetRef).toBe("parent");
    expect(plan[0].targetIndex).toBe(0);
    // Step 1: split agent[0]'s pane down → agent[1]'s pane
    expect(plan[1].targetRef).toBe(0);
    expect(plan[1].targetIndex).toBe(1);
    // Both agents are created exactly once
    const agentIndices = plan.map((op) => op.targetIndex);
    expect(new Set(agentIndices)).toEqual(new Set([0, 1]));
  });
});

// ─── resolveSplitTarget ──────────────────────────────────────────────

describe("resolveSplitTarget", () => {
  const parentPaneId = "parent-42";
  const rootPaneId = "root-1";
  const agents: SquadAgentState[] = [
    { paneId: "pane-0" } as SquadAgentState,
    { paneId: "pane-1" } as SquadAgentState,
  ];
  const emptyAgents: SquadAgentState[] = [];

  it("returns parentPaneId when targetRef is 'parent'", () => {
    expect(
      resolveSplitTarget(
        { direction: "right", targetIndex: 0, targetRef: "parent" },
        parentPaneId,
        emptyAgents,
        rootPaneId,
      ),
    ).toBe("parent-42");
  });

  it("returns agents[N].paneId when targetRef is a number", () => {
    expect(
      resolveSplitTarget(
        { direction: "down", targetIndex: 1, targetRef: 0 },
        parentPaneId,
        agents,
        rootPaneId,
      ),
    ).toBe("pane-0");
  });

  it("throws when targetRef agent has no paneId", () => {
    expect(() =>
      resolveSplitTarget(
        { direction: "down", targetIndex: 1, targetRef: 0 },
        parentPaneId,
        [{ paneId: "" } as SquadAgentState],
        rootPaneId,
      ),
    ).toThrow("not yet created");
  });

  it("returns agents[1].paneId when dependsOnAgentOne is true", () => {
    expect(
      resolveSplitTarget(
        { direction: "down", targetIndex: 3, dependsOnAgentOne: true },
        parentPaneId,
        agents,
        rootPaneId,
      ),
    ).toBe("pane-1");
  });

  it("falls back to rootPaneId when no special target", () => {
    expect(
      resolveSplitTarget(
        { direction: "right", targetIndex: 1 },
        parentPaneId,
        emptyAgents,
        rootPaneId,
      ),
    ).toBe("root-1");
  });
});

// ─── buildAgentCommand ───────────────────────────────────────────────

describe("buildAgentCommand", () => {
  it("builds a shell-quoted command with env vars and model", () => {
    const cmd = buildAgentCommand(
      "/tmp/run",
      "sq-123",
      "ag-1",
      "tok-abc",
      "Agent A",
      "/tmp/prompt.md",
      "claude-sonnet-4",
    );
    expect(cmd).toContain("HERDR_SQUAD_DIR=/tmp/run");
    expect(cmd).toContain("HERDR_SQUAD_ID=sq-123");
    expect(cmd).toContain("HERDR_SQUAD_AGENT_ID=ag-1");
    expect(cmd).toContain("HERDR_SQUAD_TOKEN=tok-abc");
    expect(cmd).toContain("claude-sonnet-4");
    expect(cmd).toContain("Squad Agent A");
    expect(cmd).toContain("/tmp/prompt.md");
    expect(cmd).toContain("read,grep,find,ls,herdr_squad_report");
  });

  it("omits --model when not provided", () => {
    const cmd = buildAgentCommand(
      "/tmp/run",
      "sq-123",
      "ag-1",
      "tok-abc",
      "Agent A",
      "/tmp/prompt.md",
    );
    expect(cmd).not.toContain("--model");
  });
});
