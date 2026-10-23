import { describe, expect, it } from "vitest";
import { DEFAULT_POTETO_CONFIG, potetoConfigFrom } from "./config.js";

describe("potetoConfigFrom", () => {
  it("defaults to off when settings carry nothing", () => {
    expect(potetoConfigFrom({})).toEqual(DEFAULT_POTETO_CONFIG);
    expect(potetoConfigFrom(null)).toEqual(DEFAULT_POTETO_CONFIG);
    expect(potetoConfigFrom({ potetoMode: "on" })).toEqual(
      DEFAULT_POTETO_CONFIG,
    );
  });

  it("reads the project or global flag", () => {
    expect(potetoConfigFrom({ potetoMode: { defaultEnabled: true } })).toEqual({
      defaultEnabled: true,
    });
    expect(potetoConfigFrom({ potetoMode: { defaultEnabled: false } })).toEqual(
      {
        defaultEnabled: false,
      },
    );
  });

  it("ignores a non-boolean value instead of coercing", () => {
    expect(potetoConfigFrom({ potetoMode: { defaultEnabled: "yes" } })).toEqual(
      { defaultEnabled: false },
    );
  });
});
