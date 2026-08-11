import { describe, expect, it } from "vitest";

import { isStaleSessionContextError } from "./stale-context.ts";

// The exact message thrown by pi's extension runtime
// (dist/core/extensions/runner.js, createExtensionRuntime().assertActive).
const PI_STALE_MESSAGE =
  "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";

describe("isStaleSessionContextError", () => {
  it("matches the error pi's runtime throws for a stale ctx", () => {
    expect(isStaleSessionContextError(new Error(PI_STALE_MESSAGE))).toBe(true);
  });

  it("matches when the message is only the stable prefix", () => {
    expect(
      isStaleSessionContextError(
        new Error(
          "This extension ctx is stale after session replacement or reload.",
        ),
      ),
    ).toBe(true);
  });

  it("rejects unrelated errors", () => {
    expect(
      isStaleSessionContextError(new Error("setStatus: session gone")),
    ).toBe(false);
    expect(isStaleSessionContextError("This extension ctx is stale")).toBe(
      false,
    );
    expect(isStaleSessionContextError(undefined)).toBe(false);
    expect(isStaleSessionContextError(null)).toBe(false);
  });
});
