import { describe, expect, it } from "vitest";

import { validateRuntimeConnection } from "./connection";

describe("validateRuntimeConnection", () => {
  it("allows empty token for personal local runtime", () => {
    expect(
      validateRuntimeConnection({
        baseUrl: "http://127.0.0.1:17888",
        token: "",
      }),
    ).toBeNull();
  });

  it("returns explicit guidance when baseUrl is missing", () => {
    expect(
      validateRuntimeConnection({
        baseUrl: "",
        token: "abc",
      }),
    ).toBe("Runtime base URL is required.");
  });

  it("returns null when config is valid", () => {
    expect(
      validateRuntimeConnection({
        baseUrl: "http://127.0.0.1:17888",
        token: "abc",
      }),
    ).toBeNull();
  });
});
