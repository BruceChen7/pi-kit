import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");
const libPath = path.join(
  repoRoot,
  "scripts",
  "install-third-party-plugins-lib.sh",
);

const tempDirs: string[] = [];

const createTempDir = (): string => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-kit-install-third-party-plugins-"),
  );
  tempDirs.push(dir);
  return dir;
};

const runBash = (script: string, env: NodeJS.ProcessEnv = {}): string =>
  execFileSync("bash", ["-lc", script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
    },
    encoding: "utf8",
  }).trim();

const bashString = (value: string): string => JSON.stringify(value);

const writeSettings = (filePath: string, packages: string[]): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({ packages }, null, 2)}\n`,
    "utf8",
  );
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe("normalize_plugin_source", () => {
  it("converts GitHub shorthand to Pi git shorthand", () => {
    const result = runBash(
      `source ${bashString(libPath)}; normalize_plugin_source ${bashString("github:owner/repo")}`,
    );

    expect(result).toBe("git:github.com/owner/repo");
  });

  it("preserves GitHub shorthand refs using @ref syntax", () => {
    const result = runBash(
      `source ${bashString(libPath)}; normalize_plugin_source ${bashString("github:owner/repo@v1.2.3")}`,
    );

    expect(result).toBe("git:github.com/owner/repo@v1.2.3");
  });
});

describe("get_equivalent_sources", () => {
  it("returns GitHub source variants for an unpinned repo", () => {
    const result = runBash(
      `source ${bashString(libPath)}; get_equivalent_sources ${bashString("github:owner/repo")}`,
    );

    expect(result.split("\n")).toEqual([
      "github:owner/repo",
      "git:github.com/owner/repo",
      "https://github.com/owner/repo",
      "https://github.com/owner/repo.git",
    ]);
  });

  it("returns only same-ref GitHub variants for a pinned repo", () => {
    const result = runBash(
      `source ${bashString(libPath)}; get_equivalent_sources ${bashString("https://github.com/owner/repo.git@v1.2.3")}`,
    );

    expect(result.split("\n")).toEqual([
      "github:owner/repo@v1.2.3",
      "git:github.com/owner/repo@v1.2.3",
      "https://github.com/owner/repo@v1.2.3",
      "https://github.com/owner/repo.git@v1.2.3",
    ]);
  });
});

describe("is_installed", () => {
  it("matches npm packages from settings.json", () => {
    const tempDir = createTempDir();
    const settingsPath = path.join(tempDir, "settings.json");
    writeSettings(settingsPath, ["npm:@plannotator/pi-extension"]);

    const result = runBash(
      `source ${bashString(libPath)}; if is_installed ${bashString("npm:@plannotator/pi-extension")} ${bashString(settingsPath)}; then echo yes; else echo no; fi`,
    );

    expect(result).toBe("yes");
  });

  it("matches equivalent GitHub repo forms in settings.json", () => {
    const tempDir = createTempDir();
    const settingsPath = path.join(tempDir, "settings.json");
    writeSettings(settingsPath, ["https://github.com/owner/repo.git"]);

    const result = runBash(
      `source ${bashString(libPath)}; if is_installed ${bashString("github:owner/repo")} ${bashString(settingsPath)}; then echo yes; else echo no; fi`,
    );

    expect(result).toBe("yes");
  });

  it("does not treat pinned and unpinned GitHub repos as equivalent", () => {
    const tempDir = createTempDir();
    const settingsPath = path.join(tempDir, "settings.json");
    writeSettings(settingsPath, ["git:github.com/owner/repo"]);

    const result = runBash(
      `source ${bashString(libPath)}; if is_installed ${bashString("github:owner/repo@v1.2.3")} ${bashString(settingsPath)}; then echo yes; else echo no; fi`,
    );

    expect(result).toBe("no");
  });
});

describe("get_settings_file", () => {
  it("uses the local .pi/settings.json path for -l", () => {
    const tempDir = createTempDir();
    const result = runBash(
      `source ${bashString(libPath)}; get_settings_file -l ${bashString(tempDir)}`,
    );

    expect(result).toBe(path.join(tempDir, ".pi", "settings.json"));
  });

  it("uses the HOME-based global settings.json path by default", () => {
    const tempHome = createTempDir();
    const result = runBash(
      `source ${bashString(libPath)}; get_settings_file '' ${bashString(repoRoot)}`,
      { HOME: tempHome },
    );

    expect(result).toBe(path.join(tempHome, ".pi", "agent", "settings.json"));
  });
});
