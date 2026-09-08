import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseExtraPluginData,
  renderInstallDoc,
  renderManifest,
} from "./package-settings.mjs";

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "scripts", "package-settings.mjs");
const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-kit-package-settings-"),
  );
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createAgentFixture(agentDir: string): void {
  fs.mkdirSync(path.join(agentDir, "query-notes-log"), { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "third_extension_settings.json"),
    '{"sample": true}\n',
    "utf-8",
  );
  fs.writeFileSync(
    path.join(agentDir, "query-notes-log", "2026-09.jsonl"),
    '{"q":"foo"}\n',
    "utf-8",
  );
}

function runPackage(
  agentDir: string,
  outZip: string,
  extraEnv: Record<string, string> = {},
): string {
  return execFileSync("node", [scriptPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PI_AGENT_DIR: agentDir,
      OUT: outZip,
      EXTRA_PLUGIN_DATA: "",
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

function zipListing(outZip: string): string {
  return execFileSync("unzip", ["-l", outZip], { encoding: "utf8" });
}

function zipEntry(outZip: string, entry: string): string {
  return execFileSync("unzip", ["-p", outZip, entry], { encoding: "utf8" });
}

// ── Core: value in / value out ──────────────────────────────────────────────
describe("renderManifest", () => {
  it("renders one line per spec with zip path, source path, and size", () => {
    const text = renderManifest([
      {
        zipPath: "pi-kit-settings/agent/third_extension_settings.json",
        srcPath: "/home/u/.pi/agent/third_extension_settings.json",
        size: 1024,
      },
      {
        zipPath: "pi-kit-settings/agent/query-notes-log/2026-09.jsonl",
        srcPath: "/home/u/.pi/agent/query-notes-log/2026-09.jsonl",
        size: 12,
      },
    ]);

    expect(text).toContain(
      "pi-kit-settings/agent/third_extension_settings.json",
    );
    expect(text).toContain("/home/u/.pi/agent/third_extension_settings.json");
    expect(text).toContain("1024");
    expect(text).toContain("query-notes-log/2026-09.jsonl");
    expect(text).toContain("12");
  });

  it("renders the header even for an empty spec list", () => {
    const text = renderManifest([]);
    expect(text).toContain("zip内路径 | 源路径 | 大小(bytes)");
    expect(text.trim().split("\n")).toHaveLength(2);
  });
});

describe("renderInstallDoc", () => {
  it("includes backup, restore, and activation steps when global settings exist", () => {
    const text = renderInstallDoc({ hasGlobal: true });

    expect(text).toContain("备份现有文件");
    expect(text).toContain(
      "third_extension_settings.json ~/.pi/agent/third_extension_settings.json",
    );
    expect(text).toContain("query-notes-log");
    expect(text).toContain("/reload");
    expect(text).toContain("botToken");
  });

  it("notes the missing global settings when absent", () => {
    const text = renderInstallDoc({ hasGlobal: false });
    expect(text).toContain("仅含插件数据");
  });
});

describe("parseExtraPluginData", () => {
  it("parses agent:-prefixed entries", () => {
    expect(parseExtraPluginData("agent:foo-data")).toEqual([
      { base: "agent", rel: "foo-data" },
    ]);
  });

  it("defaults bare entries to the agent base", () => {
    expect(parseExtraPluginData("bar")).toEqual([
      { base: "agent", rel: "bar" },
    ]);
  });

  it("supports project: entries", () => {
    expect(parseExtraPluginData("project:baz")).toEqual([
      { base: "project", rel: "baz" },
    ]);
  });

  it("ignores empty input", () => {
    expect(parseExtraPluginData("   ")).toEqual([]);
  });
});

// ── Shell: thin wiring (no mock choreography) ───────────────────────────────
describe("package-settings.mjs (shell)", () => {
  it("packages global settings + query-notes-log with manifest and install doc", () => {
    const dir = createTempDir();
    const agentDir = path.join(dir, "agent");
    const outZip = path.join(dir, "out.zip");
    createAgentFixture(agentDir);

    runPackage(agentDir, outZip);

    const listing = zipListing(outZip);
    expect(listing).toContain(
      "pi-kit-settings/agent/third_extension_settings.json",
    );
    expect(listing).toContain(
      "pi-kit-settings/agent/query-notes-log/2026-09.jsonl",
    );
    expect(listing).toContain("pi-kit-settings/MANIFEST.txt");
    expect(listing).toContain("pi-kit-settings/INSTALL.md");
    expect(listing).not.toContain("pi-kit-settings/agent/tasks");

    const manifest = zipEntry(outZip, "pi-kit-settings/MANIFEST.txt");
    expect(manifest).toContain("third_extension_settings.json");
    expect(manifest).toContain("query-notes-log/2026-09.jsonl");

    const installDoc = zipEntry(outZip, "pi-kit-settings/INSTALL.md");
    expect(installDoc).toContain("还原步骤");
    expect(installDoc).toContain("query-notes-log");
  });

  it("skips missing query-notes-log dir and still emits a manifest", () => {
    const dir = createTempDir();
    const agentDir = path.join(dir, "agent");
    const outZip = path.join(dir, "out.zip");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "third_extension_settings.json"),
      "{}",
      "utf-8",
    );

    runPackage(agentDir, outZip);

    const listing = zipListing(outZip);
    expect(listing).toContain(
      "pi-kit-settings/agent/third_extension_settings.json",
    );
    expect(listing).not.toContain("query-notes-log");
    expect(listing).toContain("pi-kit-settings/MANIFEST.txt");
  });

  it("packages only plugin data when global settings are missing", () => {
    const dir = createTempDir();
    const agentDir = path.join(dir, "agent");
    const outZip = path.join(dir, "out.zip");
    fs.mkdirSync(path.join(agentDir, "query-notes-log"), { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "query-notes-log", "2026-08.jsonl"),
      "x\n",
      "utf-8",
    );

    runPackage(agentDir, outZip);

    const listing = zipListing(outZip);
    expect(listing).toContain(
      "pi-kit-settings/agent/query-notes-log/2026-08.jsonl",
    );
    expect(listing).not.toContain("third_extension_settings.json");
    expect(zipEntry(outZip, "pi-kit-settings/INSTALL.md")).toContain(
      "仅含插件数据",
    );
  });

  it("includes EXTRA_PLUGIN_DATA entries in the zip and manifest", () => {
    const dir = createTempDir();
    const agentDir = path.join(dir, "agent");
    const outZip = path.join(dir, "out.zip");
    createAgentFixture(agentDir);
    fs.mkdirSync(path.join(agentDir, "foo-data"), { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "foo-data", "state.json"),
      "[]",
      "utf-8",
    );

    runPackage(agentDir, outZip, { EXTRA_PLUGIN_DATA: "agent:foo-data" });

    const listing = zipListing(outZip);
    expect(listing).toContain("pi-kit-settings/agent/foo-data/state.json");
    expect(zipEntry(outZip, "pi-kit-settings/MANIFEST.txt")).toContain(
      "foo-data/state.json",
    );
  });
});
