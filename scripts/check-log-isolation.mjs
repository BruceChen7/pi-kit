#!/usr/bin/env node
/**
 * Fails when a vitest run appends to the real runtime log at
 * ~/.pi/agent/pi-debug.log.
 *
 * The log file is the runtime's own record. Extension code resolves its
 * default destination from the user's HOME, so a test that constructs a
 * logger writes into the same file the running Pi process uses. That buries
 * real incidents under thousands of fixture lines.
 *
 * Usage: node scripts/check-log-isolation.mjs
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_PATH = join(homedir(), ".pi", "agent", "pi-debug.log");

/** Test files that construct the shared logger without an explicit sink. */
const POLLUTING_SUITE = [
  "extensions/scheduled-tasks/task-discovery.test.ts",
  "extensions/scheduled-tasks/tasks/knowledge-wiki-daily.test.ts",
  "extensions/shared/deferred-queue/handler-registry.test.ts",
];

const readSize = () => {
  try {
    return statSync(LOG_PATH).size;
  } catch {
    return 0;
  }
};

const before = readSize();

execFileSync("npx", ["vitest", "run", ...POLLUTING_SUITE], {
  stdio: ["ignore", "ignore", "ignore"],
});

const after = readSize();
const delta = after - before;

if (delta > 0) {
  console.error(
    `FAIL: the test run appended ${delta} bytes to ${LOG_PATH}\n` +
      "      Tests must not write to the runtime log. Give the logger an\n" +
      "      explicit sink under test, or skip the default destination.",
  );
  process.exit(1);
}

console.log(`OK: test run left ${LOG_PATH} untouched (${before} bytes)`);
