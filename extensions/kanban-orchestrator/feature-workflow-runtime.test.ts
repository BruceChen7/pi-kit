import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  importFeatureWorkflowModule,
  resolveFeatureWorkflowModulePath,
} from "./feature-workflow-runtime.js";

const tempDirs: string[] = [];
const FEATURE_WORKFLOW_ROOT_ENV = "PI_FEATURE_WORKFLOW_EXTENSION_DIR";

function createTempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-kit-feature-workflow-runtime-"),
  );
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env[FEATURE_WORKFLOW_ROOT_ENV];
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("feature-workflow runtime resolver", () => {
  it("loads modules from env-configured extension root", async () => {
    const root = createTempDir();
    const commandsDir = path.join(root, "commands");
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(
      path.join(commandsDir, "feature-switch.ts"),
      [
        "export async function runFeatureSwitchCommand(",
        "  _pi: unknown,",
        "  _ctx: unknown,",
        "  args: string[],",
        "): Promise<string> {",
        "  return args.join(':');",
        "}",
      ].join("\n"),
      "utf-8",
    );

    process.env[FEATURE_WORKFLOW_ROOT_ENV] = root;

    expect(resolveFeatureWorkflowModulePath("commands/feature-switch.js")).toBe(
      path.join(commandsDir, "feature-switch.ts"),
    );

    const mod = await importFeatureWorkflowModule<{
      runFeatureSwitchCommand: (
        pi: unknown,
        ctx: unknown,
        args: string[],
      ) => Promise<string>;
    }>("commands/feature-switch.js");

    await expect(
      mod.runFeatureSwitchCommand(null, null, ["main", "feat"]),
    ).resolves.toBe("main:feat");
  });
});
