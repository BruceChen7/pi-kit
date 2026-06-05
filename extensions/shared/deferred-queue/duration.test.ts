import { describe, expect, it } from "vitest";
import { parseDuration } from "./duration.ts";

describe("parseDuration", () => {
  it("parses minutes", () => {
    expect(parseDuration("30m")).toBe(1_800_000);
  });

  it("parses hours", () => {
    expect(parseDuration("2h")).toBe(7_200_000);
  });

  it("parses days", () => {
    expect(parseDuration("7d")).toBe(604_800_000);
  });

  it("parses 1 minute", () => {
    expect(parseDuration("1m")).toBe(60_000);
  });

  it("throws on invalid unit", () => {
    expect(() => parseDuration("30s" as never)).toThrow(
      "Unsupported duration unit",
    );
  });

  it("throws on non-positive value", () => {
    expect(() => parseDuration("0m" as never)).toThrow("Invalid duration");
    expect(() => parseDuration("-5h" as never)).toThrow("Invalid duration");
  });

  it("throws on NaN", () => {
    expect(() => parseDuration("abch" as never)).toThrow("Invalid duration");
  });
});
