import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import extension from "./index.js";

const tempDirs: string[] = [];

const createTempRepo = (): string => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-kit-feature-workflow-"),
  );
  tempDirs.push(dir);
  spawnSync("git", ["init"], { cwd: dir, encoding: "utf-8" });
  return dir;
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("feature-workflow extension", () => {
  it("registers expected commands", () => {
    const commands: string[] = [];

    extension({
      registerCommand(name: string) {
        commands.push(name);
      },
      exec() {
        throw new Error("exec should not run during registration");
      },
      on() {
        // no-op
      },
    } as unknown as ExtensionAPI);

    expect(commands.sort()).toEqual([
      "feature-list",
      "feature-setup",
      "feature-start",
      "feature-switch",
      "feature-validate",
    ]);
  });

  it("warns and stops feature-start when local wt.toml is missing", async () => {
    const repoRoot = createTempRepo();
    const commands = new Map<
      string,
      (args: string, ctx: unknown) => Promise<void>
    >();
    const exec = vi.fn();
    const notifications: Array<{ message: string; level: string }> = [];

    extension({
      registerCommand(
        name: string,
        definition: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, definition.handler);
      },
      exec,
      on() {
        // no-op
      },
    } as unknown as ExtensionAPI);

    const handler = commands.get("feature-start");
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    await handler("", {
      cwd: repoRoot,
      hasUI: false,
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    });

    expect(notifications).toEqual([
      {
        message:
          "feature-start requires local setup-managed files that are missing: .config/wt.toml. Run /feature-setup first.",
        level: "warning",
      },
    ]);
    expect(exec).not.toHaveBeenCalled();
  });
});
