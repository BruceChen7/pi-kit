import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  backupName,
  classifyEntry,
  planRestore,
  renderRestorePlan,
} from "./restore-settings.mjs";

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "scripts", "restore-settings.mjs");
const packageScriptPath = path.join(
  repoRoot,
  "scripts",
  "package-settings.mjs",
);
const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-restore-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createAgentFixture(
  agentDir: string,
  settingsBody = '{"sample": true}\n',
): void {
  fs.mkdirSync(path.join(agentDir, "query-notes-log"), { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "third_extension_settings.json"),
    settingsBody,
    "utf-8",
  );
  fs.writeFileSync(
    path.join(agentDir, "query-notes-log", "2026-09.jsonl"),
    '{"q":"foo"}\n',
    "utf-8",
  );
}

function createTeachFixture(workRoot: string): void {
  fs.mkdirSync(
    path.join(workRoot, "projA", ".pi", "teach", "topic", "lessons"),
    { recursive: true },
  );
  fs.writeFileSync(
    path.join(workRoot, "projA", ".pi", "teach", "topic", "NOTES.md"),
    "# notes\n",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(
      workRoot,
      "projA",
      ".pi",
      "teach",
      "topic",
      "lessons",
      "0001.html",
    ),
    "<h1>hi</h1>\n",
    "utf-8",
  );
}

// Build a real package-settings zip from fixtures (uses the sibling script).
function buildZip(agentDir: string, outZip: string, workRoot?: string): void {
  execFileSync("node", [packageScriptPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PI_AGENT_DIR: agentDir,
      OUT: outZip,
      EXTRA_PLUGIN_DATA: "",
      TEACH_ROOT: workRoot ?? "",
    },
    encoding: "utf8",
  });
}

function runRestore(env: Record<string, string>, cwd = repoRoot): string {
  return execFileSync("node", [scriptPath], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

// ── Core: value in / value out ──────────────────────────────────────────────
describe("classifyEntry", () => {
  it("classifies agent/project/teach entries with their relative path", () => {
    expect(
      classifyEntry("pi-kit-settings/agent/third_extension_settings.json"),
    ).toEqual({
      status: "ok",
      kind: "agent",
      rel: "third_extension_settings.json",
    });
    expect(classifyEntry("pi-kit-settings/project/foo/state.json")).toEqual({
      status: "ok",
      kind: "project",
      rel: "foo/state.json",
    });
    expect(classifyEntry("pi-kit-settings/teach/projA/topic/NOTES.md")).toEqual(
      {
        status: "ok",
        kind: "teach",
        project: "projA",
        rel: "topic/NOTES.md",
      },
    );
  });

  it("skips meta files, unknown prefixes, and unsafe paths", () => {
    expect(classifyEntry("pi-kit-settings/MANIFEST.txt")).toMatchObject({
      status: "skip",
    });
    expect(classifyEntry("pi-kit-settings/INSTALL.md")).toMatchObject({
      status: "skip",
    });
    expect(classifyEntry("pi-kit-settings/sessions/x.json")).toMatchObject({
      status: "skip",
      reason: expect.stringContaining("sessions"),
    });
    expect(classifyEntry("pi-kit-settings/agent/../evil.json")).toMatchObject({
      status: "skip",
      reason: expect.stringContaining(".."),
    });
    expect(classifyEntry("/etc/passwd")).toMatchObject({
      status: "skip",
      reason: expect.stringContaining("absolute"),
    });
    expect(classifyEntry("README.md")).toMatchObject({ status: "skip" });
  });
});

describe("planRestore", () => {
  const entries = [
    "pi-kit-settings/agent/third_extension_settings.json",
    "pi-kit-settings/agent/query-notes-log/2026-09.jsonl",
    "pi-kit-settings/project/foo/state.json",
    "pi-kit-settings/teach/projA/topic/NOTES.md",
    "pi-kit-settings/MANIFEST.txt",
    "pi-kit-settings/INSTALL.md",
  ];

  it("maps agent/project/teach prefixes to the three root paths", () => {
    const { plans, skipped } = planRestore({
      entries,
      agentDir: "/tmp/agent",
      repoRoot: "/tmp/repo",
      teachRoot: "/tmp/work",
    });

    expect(plans).toEqual([
      {
        zipPath: "pi-kit-settings/agent/third_extension_settings.json",
        destPath: "/tmp/agent/third_extension_settings.json",
        kind: "agent",
      },
      {
        zipPath: "pi-kit-settings/agent/query-notes-log/2026-09.jsonl",
        destPath: "/tmp/agent/query-notes-log/2026-09.jsonl",
        kind: "agent",
      },
      {
        zipPath: "pi-kit-settings/project/foo/state.json",
        destPath: "/tmp/repo/foo/state.json",
        kind: "project",
      },
      {
        zipPath: "pi-kit-settings/teach/projA/topic/NOTES.md",
        destPath: "/tmp/work/projA/.pi/teach/topic/NOTES.md",
        kind: "teach",
      },
    ]);
    expect(skipped.map((s) => s.zipPath)).toEqual([
      "pi-kit-settings/MANIFEST.txt",
      "pi-kit-settings/INSTALL.md",
    ]);
  });

  it("skips teach entries when teachRoot is empty", () => {
    const { plans, skipped } = planRestore({
      entries,
      agentDir: "/tmp/agent",
      repoRoot: "/tmp/repo",
      teachRoot: "",
    });
    expect(plans.map((p) => p.kind)).toEqual(["agent", "agent", "project"]);
    expect(skipped).toContainEqual({
      zipPath: "pi-kit-settings/teach/projA/topic/NOTES.md",
      reason: "teach restore disabled (TEACH_ROOT empty)",
    });
  });

  it("rejects unsafe and unknown entries without producing plans for them", () => {
    const { plans, skipped } = planRestore({
      entries: [
        "pi-kit-settings/agent/ok.json",
        "pi-kit-settings/agent/../../etc/passwd",
        "/etc/passwd",
        "pi-kit-settings/teach/../evil.md",
      ],
      agentDir: "/tmp/agent",
      repoRoot: "/tmp/repo",
      teachRoot: "/tmp/work",
    });
    expect(plans).toEqual([
      {
        zipPath: "pi-kit-settings/agent/ok.json",
        destPath: "/tmp/agent/ok.json",
        kind: "agent",
      },
    ]);
    expect(skipped).toHaveLength(3);
    for (const skip of skipped) {
      expect(skip.reason).toMatch(/unsafe|absolute/);
    }
  });
});

describe("renderRestorePlan", () => {
  it("lists dest ← zip lines and skipped entries with reasons", () => {
    const text = renderRestorePlan({
      plans: [
        {
          zipPath: "pi-kit-settings/agent/third_extension_settings.json",
          destPath: "/home/u/.pi/agent/third_extension_settings.json",
          kind: "agent",
        },
      ],
      skipped: [
        {
          zipPath: "pi-kit-settings/MANIFEST.txt",
          reason: "meta file (reference only)",
        },
      ],
    });
    expect(text).toContain(
      "/home/u/.pi/agent/third_extension_settings.json ← pi-kit-settings/agent/third_extension_settings.json",
    );
    expect(text).toContain("MANIFEST.txt");
    expect(text).toContain("meta file");
  });
});

describe("backupName", () => {
  it("appends .bak.<ts> to the destination path", () => {
    expect(backupName("/a/b.json", "20260910-120000")).toBe(
      "/a/b.json.bak.20260910-120000",
    );
  });
});

// ── Shell: thin wiring (no mock choreography) ───────────────────────────────
describe("restore-settings.mjs (shell)", () => {
  it("restores agent + teach data from a package-settings zip", () => {
    const dir = createTempDir();
    const srcAgent = path.join(dir, "src-agent");
    const srcWork = path.join(dir, "src-work");
    const outZip = path.join(dir, "out.zip");
    const dstAgent = path.join(dir, "dst-agent");
    const dstWork = path.join(dir, "dst-work");
    createAgentFixture(srcAgent);
    createTeachFixture(srcWork);
    buildZip(srcAgent, outZip, srcWork);

    runRestore({
      ZIP: outZip,
      PI_AGENT_DIR: dstAgent,
      TEACH_ROOT: dstWork,
    });

    expect(
      fs.readFileSync(
        path.join(dstAgent, "third_extension_settings.json"),
        "utf-8",
      ),
    ).toBe('{"sample": true}\n');
    expect(
      fs.readFileSync(
        path.join(dstAgent, "query-notes-log", "2026-09.jsonl"),
        "utf-8",
      ),
    ).toBe('{"q":"foo"}\n');
    expect(
      fs.readFileSync(
        path.join(dstWork, "projA", ".pi", "teach", "topic", "NOTES.md"),
        "utf-8",
      ),
    ).toBe("# notes\n");
    // meta files never land in the destination roots
    expect(fs.existsSync(path.join(dstAgent, "MANIFEST.txt"))).toBe(false);
    expect(
      fs.existsSync(
        path.join(dstWork, "projA", ".pi", "teach", "MANIFEST.txt"),
      ),
    ).toBe(false);
  });

  it("backs up existing destination files before overwriting", () => {
    const dir = createTempDir();
    const srcAgent = path.join(dir, "src-agent");
    const outZip = path.join(dir, "out.zip");
    const dstAgent = path.join(dir, "dst-agent");
    createAgentFixture(srcAgent);
    buildZip(srcAgent, outZip);
    const dest = path.join(dstAgent, "third_extension_settings.json");
    fs.mkdirSync(dstAgent, { recursive: true });
    fs.writeFileSync(dest, "OLD-CONTENT\n", "utf-8");

    runRestore({ ZIP: outZip, PI_AGENT_DIR: dstAgent, TEACH_ROOT: "" });

    expect(fs.readFileSync(dest, "utf-8")).toBe('{"sample": true}\n');
    const backups = fs
      .readdirSync(dstAgent)
      .filter((name) => name.startsWith("third_extension_settings.json.bak."));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(dstAgent, backups[0]), "utf-8")).toBe(
      "OLD-CONTENT\n",
    );
  });

  it("DRY_RUN=1 writes nothing but prints the plan", () => {
    const dir = createTempDir();
    const srcAgent = path.join(dir, "src-agent");
    const outZip = path.join(dir, "out.zip");
    const dstAgent = path.join(dir, "dst-agent");
    createAgentFixture(srcAgent);
    buildZip(srcAgent, outZip);
    const dest = path.join(dstAgent, "third_extension_settings.json");
    fs.mkdirSync(dstAgent, { recursive: true });
    fs.writeFileSync(dest, "OLD-CONTENT\n", "utf-8");

    const output = runRestore({
      ZIP: outZip,
      PI_AGENT_DIR: dstAgent,
      TEACH_ROOT: "",
      DRY_RUN: "1",
    });

    expect(fs.readFileSync(dest, "utf-8")).toBe("OLD-CONTENT\n");
    expect(
      fs.readdirSync(dstAgent).filter((name) => name.includes(".bak.")),
    ).toHaveLength(0);
    expect(output).toContain("third_extension_settings.json ← ");
    expect(output).toContain("[dry-run] nothing written.");
  });

  it("defaults to the newest pi-kit-settings-*.zip in the cwd", () => {
    const dir = createTempDir();
    const srcA = path.join(dir, "src-a");
    const srcB = path.join(dir, "src-b");
    const zipOld = path.join(dir, "pi-kit-settings-old.zip");
    const zipNew = path.join(dir, "pi-kit-settings-new.zip");
    const dstAgent = path.join(dir, "dst-agent");
    createAgentFixture(srcA, "OLD-ZIP\n");
    createAgentFixture(srcB, "NEW-ZIP\n");
    buildZip(srcA, zipOld);
    buildZip(srcB, zipNew);
    // make mtimes distinguishable (newer one wins)
    const oldTime = new Date(Date.now() - 60_000);
    fs.utimesSync(zipOld, oldTime, oldTime);

    runRestore(
      { PI_AGENT_DIR: dstAgent, TEACH_ROOT: "" },
      dir, // cwd = temp dir so discovery scans it, not the real repo
    );

    expect(
      fs.readFileSync(
        path.join(dstAgent, "third_extension_settings.json"),
        "utf-8",
      ),
    ).toBe("NEW-ZIP\n");
  });

  it("fails with a clear error on a zip without the pi-kit-settings/ prefix", () => {
    const dir = createTempDir();
    const badZip = path.join(dir, "not-settings.zip");
    const dstAgent = path.join(dir, "dst-agent");
    execFileSync("zip", ["-j", badZip, packageScriptPath], { stdio: "ignore" });

    expect(() =>
      runRestore({ ZIP: badZip, PI_AGENT_DIR: dstAgent, TEACH_ROOT: "" }),
    ).toThrow(/pi-kit-settings/);
  });
});
