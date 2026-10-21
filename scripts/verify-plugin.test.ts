import { describe, expect, it } from "vitest";
import {
  collectNotifies,
  commandNameOf,
  evaluateDoctor,
  evaluateRun,
  evaluateToolRun,
  findRegisteredCommand,
  formatSummary,
  parseArgs,
} from "./verify-plugin.mjs";

const PLUGIN_DIR = "/repo/extensions/plan-mode";

const okOptions = (argv) => {
  const parsed = parseArgs(argv);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.options;
};

describe("parseArgs", () => {
  it("requires a mode", () => {
    expect(parseArgs([])).toEqual({
      ok: false,
      error: 'expected a mode (doctor, tool, command), got ""',
    });
  });

  it("requires --plugin", () => {
    expect(parseArgs(["doctor"]).ok).toBe(false);
  });

  it("collects repeated command and expectation flags in order", () => {
    const options = okOptions([
      "command",
      "--plugin",
      "plan-mode",
      "--command",
      "/plan-mode plan",
      "--command",
      "/plan-mode act",
      "--expect",
      "Plan Mode: Plan",
      "--expect",
      "Plan Mode: Act",
      "--reject",
      "error",
    ]);

    expect(options.commands).toEqual(["/plan-mode plan", "/plan-mode act"]);
    expect(options.expects).toEqual(["Plan Mode: Plan", "Plan Mode: Act"]);
    expect(options.rejects).toEqual(["error"]);
    expect(options.settleMs).toBe(1200);
    expect(options.timeoutMs).toBe(30000);
  });

  it("requires --tool in tool mode", () => {
    expect(parseArgs(["tool", "--plugin", "confluence"])).toEqual({
      ok: false,
      error: "tool mode needs --tool",
    });
  });

  it("requires at least one --command in command mode", () => {
    expect(parseArgs(["command", "--plugin", "plan-mode"])).toEqual({
      ok: false,
      error: "command mode needs at least one --command",
    });
  });

  it("rejects expectation flags outside command mode", () => {
    expect(
      parseArgs([
        "tool",
        "--plugin",
        "confluence",
        "--tool",
        "x",
        "--expect",
        "y",
      ]),
    ).toEqual({
      ok: false,
      error: "--expect/--reject only apply to command mode",
    });
  });

  it("rejects unknown and valueless flags", () => {
    expect(parseArgs(["doctor", "--nope"]).ok).toBe(false);
    expect(parseArgs(["doctor", "--plugin"]).ok).toBe(false);
    expect(parseArgs(["doctor", "--plugin", "x", "--settle-ms", "0"]).ok).toBe(
      false,
    );
  });
});

describe("commandNameOf", () => {
  it("drops the slash and arguments", () => {
    expect(commandNameOf("/plan-mode status")).toBe("plan-mode");
    expect(commandNameOf("/agents")).toBe("agents");
    expect(commandNameOf("  //qmd-doctor  ")).toBe("qmd-doctor");
  });
});

describe("findRegisteredCommand", () => {
  const commands = [
    {
      name: "plan-mode",
      source: "extension",
      sourceInfo: { path: PLUGIN_DIR },
    },
    {
      name: "fix-tests",
      source: "prompt",
      sourceInfo: { path: "/repo/prompts/fix-tests.md" },
    },
  ];

  it("accepts a command from the requested extension", () => {
    expect(findRegisteredCommand(commands, "plan-mode", PLUGIN_DIR).ok).toBe(
      true,
    );
  });

  it("rejects a command that comes from another path", () => {
    const result = findRegisteredCommand(
      commands,
      "plan-mode",
      "/repo/extensions/subagent",
    );

    expect(result.ok).toBe(false);
    expect(result.findings[0]).toContain("not /repo/extensions/subagent");
  });

  it("rejects a missing command", () => {
    expect(
      findRegisteredCommand(commands, "not-there", PLUGIN_DIR).findings,
    ).toEqual(['command "not-there" is not registered']);
  });

  it("rejects a command that is not registered by an extension", () => {
    const result = findRegisteredCommand(commands, "fix-tests", undefined);

    expect(result.ok).toBe(false);
    expect(result.findings[0]).toContain("not an extension");
  });
});

describe("collectNotifies", () => {
  it("keeps only notify messages at or after the mark", () => {
    const records = [
      { method: "notify", message: "before" },
      { method: "setStatus", statusKey: "plan-mode" },
      { method: "setWidget", widgetKey: "plan-mode-todos" },
      { method: "notify", message: "Plan Mode: Act" },
    ];

    expect(collectNotifies(records, 2)).toEqual(["Plan Mode: Act"]);
  });
});

describe("evaluateRun", () => {
  it("passes when every expectation matches and every command was handled", () => {
    expect(
      evaluateRun({
        dispositions: ["handled"],
        notifies: ["Plan Mode: Act • status: Act"],
        expects: ["Plan Mode: Act"],
        rejects: [],
      }),
    ).toEqual({ ok: true, findings: [] });
  });

  it("reports a missing expectation", () => {
    const result = evaluateRun({
      dispositions: ["handled"],
      notifies: ["Plan Mode: Act"],
      expects: ["Plan Mode: Plan"],
      rejects: [],
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      'missing expected text: "Plan Mode: Plan"',
    ]);
  });

  it("reports rejected text", () => {
    const result = evaluateRun({
      dispositions: ["handled"],
      notifies: ["extension failed"],
      expects: [],
      rejects: ["failed"],
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(['unexpected text: "failed"']);
  });

  it("fails when a command fell through to the model", () => {
    const result = evaluateRun({
      dispositions: ["started"],
      notifies: [],
      expects: [],
      rejects: [],
    });

    expect(result.ok).toBe(false);
    expect(result.findings[0]).toContain("disposition: started");
  });
});

describe("evaluateToolRun", () => {
  it("passes when the tool is active and the extension loaded cleanly", () => {
    expect(
      evaluateToolRun({
        activeToolNames: ["read", "confluence_page"],
        expectedTool: "confluence_page",
        extensionErrors: [],
        pluginDir: PLUGIN_DIR,
      }),
    ).toEqual({ ok: true, findings: [] });
  });

  it("reports an unregistered tool", () => {
    expect(
      evaluateToolRun({
        activeToolNames: ["read"],
        expectedTool: "confluence_page",
        extensionErrors: [],
      }).findings,
    ).toEqual(['tool "confluence_page" is not registered']);
  });

  it("reports a load error from the target extension", () => {
    const result = evaluateToolRun({
      activeToolNames: ["confluence_page"],
      expectedTool: "confluence_page",
      extensionErrors: [{ path: PLUGIN_DIR, error: "boom" }],
      pluginDir: PLUGIN_DIR,
    });

    expect(result.ok).toBe(false);
    expect(result.findings[0]).toContain("boom");
  });
});

describe("evaluateDoctor", () => {
  it("passes when the extension is in the load result", () => {
    expect(
      evaluateDoctor({
        extensionPaths: [PLUGIN_DIR],
        pluginDir: PLUGIN_DIR,
        extensionErrors: [],
      }),
    ).toEqual({ ok: true, findings: [] });
  });

  it("reports an extension that never loaded", () => {
    expect(
      evaluateDoctor({
        extensionPaths: ["/repo/extensions/other"],
        pluginDir: PLUGIN_DIR,
        extensionErrors: [],
      }).findings,
    ).toEqual([`extension is not loaded: ${PLUGIN_DIR}`]);
  });
});

describe("formatSummary", () => {
  it("prints the verdict, findings, and evidence path", () => {
    const text = formatSummary({
      mode: "command",
      plugin: "plan-mode",
      ok: false,
      findings: ['missing expected text: "Plan Mode: Plan"'],
      steps: [{ command: "/plan-mode status", disposition: "handled" }],
      notifies: ["Plan Mode: Act"],
      expects: ["Plan Mode: Plan"],
      evidenceDir: "/repo/.pi/verify-runs/run",
    });

    expect(text).toContain("FAIL command plan-mode");
    expect(text).toContain("/plan-mode status -> handled");
    expect(text).toContain('missing expected text: "Plan Mode: Plan"');
    expect(text).toContain("evidence: /repo/.pi/verify-runs/run");
  });
});
