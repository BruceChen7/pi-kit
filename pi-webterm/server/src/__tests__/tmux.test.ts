import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachToSession,
  capturePane,
  detachPty,
  hasSession,
  killSession,
  listSessions,
} from "../tmux.js";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "node:child_process";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("hasSession", () => {
  it("returns true when tmux has-session succeeds", () => {
    vi.mocked(execSync).mockReturnValue("" as any);
    expect(hasSession("pi-agent")).toBe(true);
  });

  it("returns false when tmux has-session fails", () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("session not found");
    });
    expect(hasSession("pi-agent")).toBe(false);
  });

  it("handles empty session name", () => {
    expect(hasSession("")).toBe(false);
  });
});

describe("listSessions", () => {
  it("returns array of session names", () => {
    vi.mocked(execSync).mockReturnValue("pi-agent\nother-session\n" as any);
    expect(listSessions()).toEqual(["pi-agent", "other-session"]);
  });

  it("returns empty array when no sessions", () => {
    vi.mocked(execSync).mockReturnValue("" as any);
    expect(listSessions()).toEqual([]);
  });

  it("returns empty array on error", () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("no server");
    });
    expect(listSessions()).toEqual([]);
  });
});

describe("killSession", () => {
  it("calls tmux kill-session", () => {
    vi.mocked(execSync).mockReturnValue("" as any);
    killSession("pi-agent");
    expect(execSync).toHaveBeenCalledWith(
      "tmux kill-session -t pi-agent 2>/dev/null",
      expect.anything(),
    );
  });

  it("does not throw on failure", () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("no session");
    });
    expect(() => killSession("pi-agent")).not.toThrow();
  });
});

describe("capturePane", () => {
  it("returns captured output", () => {
    vi.mocked(execSync).mockReturnValue("line1\nline2\n" as any);
    expect(capturePane("pi-agent", 10)).toBe("line1\nline2\n");
  });

  it("returns empty string on error", () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("no session");
    });
    expect(capturePane("pi-agent")).toBe("");
  });
});

describe("attachToSession", () => {
  it("throws when session name is empty", async () => {
    await expect(attachToSession("", 80, 24)).rejects.toThrow(
      "Session name is required",
    );
  });
});

describe("detachPty", () => {
  it("calls pty.kill()", () => {
    const killed = vi.fn();
    const pty = { kill: killed, resize: vi.fn(), write: vi.fn() } as any;
    detachPty(pty);
    expect(killed).toHaveBeenCalled();
  });

  it("does not throw if kill fails", () => {
    const pty = {
      kill: () => {
        throw new Error("already dead");
      },
    } as any;
    expect(() => detachPty(pty)).not.toThrow();
  });
});
