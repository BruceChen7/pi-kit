import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "install-plugins.sh");
const tempDirs: string[] = [];

const createTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-install-plugins-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe("install-plugins.sh", () => {
  it("installs local plugins into a shared library and only bootstraps plugin-toggle globally", () => {
    const home = createTempDir();

    execFileSync("bash", [scriptPath], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });

    const libraryDir = path.join(home, ".agents", "pi-plugins");
    const globalExtensionsDir = path.join(home, ".pi", "agent", "extensions");

    expect(fs.lstatSync(path.join(libraryDir, "copyx")).isSymbolicLink()).toBe(
      true,
    );
    expect(
      fs.lstatSync(path.join(libraryDir, "safe-delete.ts")).isSymbolicLink(),
    ).toBe(true);
    expect(
      fs
        .lstatSync(path.join(globalExtensionsDir, "plugin-toggle"))
        .isSymbolicLink(),
    ).toBe(true);
    expect(
      fs.lstatSync(path.join(globalExtensionsDir, "shared")).isSymbolicLink(),
    ).toBe(true);
    expect(fs.existsSync(path.join(globalExtensionsDir, "copyx"))).toBe(false);
  });
});
