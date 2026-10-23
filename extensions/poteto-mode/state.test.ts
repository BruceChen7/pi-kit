import { describe, expect, it } from "vitest";
import {
  isPotetoSnapshot,
  latestPotetoState,
  POTETO_MODE_ENTRY,
  parsePotetoCommand,
  potetoSnapshot,
  resolvePotetoState,
} from "./state.js";

const entry = (data: unknown) => ({
  type: "custom",
  customType: POTETO_MODE_ENTRY,
  data,
});

describe("parsePotetoCommand", () => {
  it("defaults an empty argument to status", () => {
    expect(parsePotetoCommand("")).toEqual({ kind: "status" });
    expect(parsePotetoCommand("   ")).toEqual({ kind: "status" });
  });

  it("accepts the four verbs case-insensitively", () => {
    expect(parsePotetoCommand(" ON ")).toEqual({ kind: "on" });
    expect(parsePotetoCommand("off")).toEqual({ kind: "off" });
    expect(parsePotetoCommand("status")).toEqual({ kind: "status" });
    expect(parsePotetoCommand("preview")).toEqual({ kind: "preview" });
  });

  it("reports an unknown verb instead of guessing", () => {
    expect(parsePotetoCommand("enable")).toEqual({
      kind: "invalid",
      value: "enable",
    });
  });
});

describe("potetoSnapshot", () => {
  it("round-trips through the guard", () => {
    expect(isPotetoSnapshot(potetoSnapshot(true))).toBe(true);
    expect(isPotetoSnapshot(potetoSnapshot(false))).toBe(true);
  });

  it("rejects wrong version, missing field, and non-objects", () => {
    expect(isPotetoSnapshot({ version: 2, enabled: true })).toBe(false);
    expect(isPotetoSnapshot({ version: 1 })).toBe(false);
    expect(isPotetoSnapshot(null)).toBe(false);
    expect(isPotetoSnapshot("on")).toBe(false);
    expect(isPotetoSnapshot([])).toBe(false);
  });
});

describe("latestPotetoState", () => {
  it("treats an empty branch as never configured", () => {
    expect(latestPotetoState([])).toEqual({ enabled: false, explicit: false });
  });

  it("takes the last snapshot on the branch", () => {
    expect(
      latestPotetoState([
        entry({ version: 1, enabled: true }),
        entry({ version: 1, enabled: false }),
      ]),
    ).toEqual({ enabled: false, explicit: true });
  });

  it("skips malformed and foreign entries without throwing", () => {
    expect(
      latestPotetoState([
        entry({ version: 1, enabled: true }),
        { type: "custom", customType: "other.entry", data: {} },
        entry({ version: 1, enabled: "yes" }),
        { type: "message", data: "hi" },
        null,
      ]),
    ).toEqual({ enabled: true, explicit: true });
  });
});

describe("resolvePotetoState", () => {
  it("uses the configured default when the branch has no record", () => {
    expect(
      resolvePotetoState({ enabled: false, explicit: false }, true),
    ).toEqual({ enabled: true, explicit: true });
    expect(
      resolvePotetoState({ enabled: false, explicit: false }, false),
    ).toEqual({ enabled: false, explicit: false });
  });

  it("lets an explicit branch record win over the default", () => {
    expect(
      resolvePotetoState({ enabled: false, explicit: true }, true),
    ).toEqual({ enabled: false, explicit: true });
    expect(
      resolvePotetoState({ enabled: true, explicit: true }, false),
    ).toEqual({ enabled: true, explicit: true });
  });
});
