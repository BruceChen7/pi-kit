import { describe, expect, it } from "vitest";
import {
  createPublisher,
  EVENT_PROTOCOL,
  isFreshEvent,
  readEvent,
  seenAfter,
  wrapEvent,
} from "./event-protocol.ts";

describe("wrapEvent / readEvent", () => {
  it("round-trips a payload with protocol, instance and sequence", () => {
    const event = wrapEvent("inst-1", 3, { type: "plan-mode.badge", key: "x" });
    const read = readEvent<{ key: string }>(event);

    expect(read).toEqual({
      payload: { type: "plan-mode.badge", key: "x" },
      legacy: false,
      instanceId: "inst-1",
      sequence: 3,
    });
  });

  it("accepts a bare payload as legacy", () => {
    const read = readEvent<{ key: string }>({
      type: "plan-mode.badge",
      key: "x",
    });

    expect(read?.legacy).toBe(true);
    expect(read?.payload.key).toBe("x");
  });

  it("rejects an unknown protocol instead of guessing fields", () => {
    expect(
      readEvent({ protocol: EVENT_PROTOCOL + 1, instanceId: "i", sequence: 1 }),
    ).toBeUndefined();
  });

  it("rejects a malformed envelope", () => {
    expect(
      readEvent({ protocol: EVENT_PROTOCOL, sequence: 1 }),
    ).toBeUndefined();
    expect(
      readEvent({ protocol: EVENT_PROTOCOL, instanceId: "", sequence: 1 }),
    ).toBeUndefined();
    expect(
      readEvent({ protocol: EVENT_PROTOCOL, instanceId: "i", sequence: "1" }),
    ).toBeUndefined();
  });

  it("rejects a non-object", () => {
    expect(readEvent("nope")).toBeUndefined();
  });
});

describe("isFreshEvent / seenAfter", () => {
  const enveloped = (instanceId: string, sequence: number) => ({
    payload: {},
    legacy: false,
    instanceId,
    sequence,
  });

  it("accepts the first event of a new instance", () => {
    const seen = { instanceId: "inst-1", sequence: 5 };

    expect(isFreshEvent(seen, enveloped("inst-2", 1))).toBe(true);
  });

  it("drops a replayed or out-of-order sequence", () => {
    const seen = { instanceId: "inst-1", sequence: 5 };

    expect(isFreshEvent(seen, enveloped("inst-1", 5))).toBe(false);
    expect(isFreshEvent(seen, enveloped("inst-1", 4))).toBe(false);
    expect(isFreshEvent(seen, enveloped("inst-1", 6))).toBe(true);
  });

  it("accepts a legacy event and keeps the seen state", () => {
    const seen = { instanceId: "inst-1", sequence: 5 };
    const legacy = { payload: {}, legacy: true };

    expect(isFreshEvent(seen, legacy)).toBe(true);
    expect(seenAfter(seen, legacy)).toEqual(seen);
  });

  it("records the accepted envelope", () => {
    expect(seenAfter(undefined, enveloped("inst-1", 2))).toEqual({
      instanceId: "inst-1",
      sequence: 2,
    });
  });
});

describe("createPublisher", () => {
  it("increments the sequence within one lifecycle", () => {
    const publisher = createPublisher("inst-1");

    expect(publisher.next({ a: 1 }).sequence).toBe(1);
    expect(publisher.next({ a: 2 }).sequence).toBe(2);
    expect(publisher.next({ a: 3 }).instanceId).toBe("inst-1");
  });

  it("gives each lifecycle its own instance id", () => {
    expect(createPublisher("inst-1").instanceId).not.toBe(
      createPublisher("inst-2").instanceId,
    );
  });
});
