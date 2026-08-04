import { describe, expect, it } from "vitest";
import { createExecContext } from "./handler-registry.ts";

/**
 * Wiring tests for the shell layer: verify the bounded-output contract
 * through the public `exec` interface with a real child process, i.e. that
 * runaway output terminates the child and flags the result instead of
 * crashing the host (RangeError: Invalid string length regression).
 */
describe("exec overflow handling", () => {
  it("terminates runaway output and flags the result as truncated", async () => {
    const result = await createExecContext().exec("node", [
      "-e",
      "process.stdout.write('x'.repeat(20 * 1024 * 1024));",
    ]);

    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(result.stdout.length).toBeLessThanOrEqual(16 * 1024 * 1024);
    // Child was SIGTERMed, so the close handler reports a non-zero code.
    expect(result.code).toBe(1);
  }, 30_000);

  it("passes through well-behaved output unchanged", async () => {
    const result = await createExecContext().exec("node", [
      "-e",
      "process.stdout.write('hello world'); process.stderr.write('oops');",
    ]);

    expect(result.truncated).toBe(false);
    expect(result.stdout).toBe("hello world");
    expect(result.stderr).toBe("oops");
    expect(result.code).toBe(0);
  }, 30_000);
});
