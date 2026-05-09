import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const NATIVE_IMPORT_CHECK_SCRIPT = [
  "const mod = await import('./extensions/feature-workflow/worktree-gateway.ts');",
  "if (typeof mod.createFeatureWorktree !== 'function') process.exit(2);",
  "console.log('imported');",
].join("\n");

test("worktree gateway can be imported by Node native TypeScript runtime", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    "-e",
    NATIVE_IMPORT_CHECK_SCRIPT,
  ]);

  expect(stdout.trim()).toBe("imported");
});
