import { expect } from "vitest";

/**
 * Shared test helper: assert a value is defined and narrow its type,
 * replacing `!` non-null assertions and `?? expect.fail(...)` inline guards
 * in tests. Use whenever a fixture/result must exist before further
 * assertions — the failure message is the plain vitest "expected value to
 * be defined" instead of an uncontrolled TypeError.
 */
export function expectDefined<T>(value: T | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}
