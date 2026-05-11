import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { clearBashHooks, registerBashHook, runBashHooks } from "./bash-hook.js";
import { clearSettingsCache, getSettingsPaths } from "./settings.js";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;

const registerTempDir = (dir: string): string => {
  tempDirs.push(dir);
  return dir;
};

const createTempDir = (prefix: string): string =>
  registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

const createTempHome = (): string => {
  const dir = createTempDir("pi-kit-bash-hook-home-");
  process.env.HOME = dir;
  return dir;
};

const restoreHome = (): void => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
};

const createContext = (cwd: string): ExtensionContext =>
  ({ cwd, hasUI: false }) as ExtensionContext;

const runHooks = async (command: string, cwd: string) => {
  return runBashHooks({
    command,
    cwd,
    ctx: createContext(cwd),
    source: "tool",
  });
};

afterEach(() => {
  clearBashHooks();
  clearSettingsCache();
  restoreHome();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("bash-hook framework", () => {
  it("applies hooks in registration order when settings are absent", async () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-bash-hook-cwd-");

    registerBashHook({
      id: "one",
      hook: async ({ command }) => ({ command: `${command} | one` }),
    });
    registerBashHook({
      id: "two",
      hook: async ({ command }) => ({ command: `${command} | two` }),
    });

    const result = await runHooks("cmd", cwd);
    expect(result.command).toBe("cmd | one | two");
    expect(result.applied).toEqual(["one", "two"]);
  });

  it("respects project bashHooks.order over global ordering", async () => {
    createTempHome();
    const cwd = createTempDir("pi-kit-bash-hook-cwd-");
    const { globalPath, projectPath } = getSettingsPaths(cwd);

    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(
      globalPath,
      JSON.stringify({ bashHooks: { order: ["two", "one"] } }, null, 2),
      "utf-8",
    );

    fs.mkdirSync(path.dirname(projectPath), { recursive: true });
    fs.writeFileSync(
      projectPath,
      JSON.stringify({ bashHooks: { order: ["one"] } }, null, 2),
      "utf-8",
    );

    registerBashHook({
      id: "one",
      hook: async ({ command }) => ({ command: `${command} | one` }),
    });
    registerBashHook({
      id: "two",
      hook: async ({ command }) => ({ command: `${command} | two` }),
    });

    const result = await runHooks("cmd", cwd);
    expect(result.command).toBe("cmd | one | two");
    expect(result.applied).toEqual(["one", "two"]);
  });
});
