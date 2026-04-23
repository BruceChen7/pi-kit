import { describe, expect, it } from "vitest";

import { deriveSessionIdentity } from "./ids.ts";

describe("remote-approval session identity", () => {
  it("uses repo name and session-file basename when no session name exists", () => {
    const identity = deriveSessionIdentity({
      cwd: "/tmp/pi-kit",
      sessionFile: "/tmp/pi-kit/.pi/sessions/abc123.jsonl",
    });

    expect(identity).toEqual({
      sessionId: "abc123",
      sessionLabel: "pi-kit · abc123",
    });
  });

  it("prefers the session name in the display label", () => {
    const identity = deriveSessionIdentity({
      cwd: "/tmp/pi-kit",
      sessionFile: "/tmp/pi-kit/.pi/sessions/abc123.jsonl",
      sessionName: "review todo ui",
    });

    expect(identity).toEqual({
      sessionId: "abc123",
      sessionLabel: "pi-kit · review todo ui",
    });
  });

  it("falls back to cwd when no session file is available", () => {
    const identity = deriveSessionIdentity({
      cwd: "/tmp/pi-kit",
      sessionFile: undefined,
    });

    expect(identity.sessionId).toMatch(/^session-/);
    expect(identity.sessionLabel).toBe("pi-kit · ephemeral");
  });
});
