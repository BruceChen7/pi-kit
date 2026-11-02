import { describe, expect, it } from "vitest";
import { parseOpencliArray } from "./opencli-output.js";

describe("parseOpencliArray", () => {
  it("unwraps the opencli 2.x result envelope", () => {
    const json = JSON.stringify({
      ok: true,
      data: [
        { id: "1", title: "a" },
        { id: "2", title: "b" },
      ],
    });

    const items = parseOpencliArray<{ id: string }>(json);

    expect(items).toHaveLength(2);
    expect(items[0].id).toBe("1");
  });

  it("accepts a bare array from opencli 1.x", () => {
    const json = JSON.stringify([{ id: "1" }]);

    expect(parseOpencliArray<{ id: string }>(json)).toHaveLength(1);
  });

  it("names the failure code when the command reports an error", () => {
    const json = JSON.stringify({
      ok: false,
      error: { code: "not_logged_in", message: "Run opencli auth first." },
    });

    expect(() => parseOpencliArray(json)).toThrow(/not_logged_in/);
    expect(() => parseOpencliArray(json)).toThrow(/Run opencli auth first/);
  });

  it("rejects an envelope whose data is not an array", () => {
    const json = JSON.stringify({ ok: true, data: { commands: [] } });

    expect(() => parseOpencliArray(json)).toThrow(/Expected JSON array/);
  });

  it("rejects a payload that carries no envelope and is not an array", () => {
    expect(() => parseOpencliArray('{"id":"1"}')).toThrow(
      /Expected JSON array/,
    );
  });

  it("rejects invalid JSON", () => {
    expect(() => parseOpencliArray("not-json")).toThrow();
  });
});
