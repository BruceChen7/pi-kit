import { describe, expect, it } from "vitest";
import { isReadOnlyDateProbe } from "./bash-date-probe.js";

describe("isReadOnlyDateProbe", () => {
  it("accepts a bare date", () => {
    expect(isReadOnlyDateProbe("date")).toBe(true);
    expect(isReadOnlyDateProbe("  date  ")).toBe(true);
  });

  it("accepts a date with a format string", () => {
    expect(isReadOnlyDateProbe("date +%F")).toBe(true);
    expect(isReadOnlyDateProbe('date "+%Y-%m-%d"')).toBe(true);
    expect(isReadOnlyDateProbe("date +%Y-%m-%dT%H:%M:%S")).toBe(true);
  });

  it("accepts read-only flags", () => {
    expect(isReadOnlyDateProbe("date -u")).toBe(true);
    expect(isReadOnlyDateProbe("date --iso-8601=date")).toBe(true);
    expect(isReadOnlyDateProbe("date -u +%F")).toBe(true);
  });

  it("rejects chaining and substitution", () => {
    expect(isReadOnlyDateProbe("date && rm -rf x")).toBe(false);
    expect(isReadOnlyDateProbe("date; rm -rf x")).toBe(false);
    expect(isReadOnlyDateProbe("date | tee f")).toBe(false);
    expect(isReadOnlyDateProbe("date > /tmp/f")).toBe(false);
    expect(isReadOnlyDateProbe("echo $(date)")).toBe(false);
    expect(isReadOnlyDateProbe("date `whoami`")).toBe(false);
    expect(isReadOnlyDateProbe("(date)")).toBe(false);
  });

  it("rejects setting the clock or reading a file", () => {
    expect(isReadOnlyDateProbe("date -s 2020-01-01")).toBe(false);
    expect(isReadOnlyDateProbe("date --set=2020-01-01")).toBe(false);
    expect(isReadOnlyDateProbe("date -f file")).toBe(false);
  });

  it("rejects other programs and empty input", () => {
    expect(isReadOnlyDateProbe("")).toBe(false);
    expect(isReadOnlyDateProbe("   ")).toBe(false);
    expect(isReadOnlyDateProbe("dateformat")).toBe(false);
    expect(isReadOnlyDateProbe("echo date")).toBe(false);
    expect(isReadOnlyDateProbe("rm -rf src")).toBe(false);
  });

  it("rejects a date probe glued to a path argument", () => {
    expect(isReadOnlyDateProbe("date /etc/passwd")).toBe(false);
  });
});
