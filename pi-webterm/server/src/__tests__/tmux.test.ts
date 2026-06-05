import type { IPty } from "node-pty";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachToSession,
  capturePane,
  detachPty,
  ensureSession,
  hasSession,
  killSession,
  listSessions,
} from "../tmux.js";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "node:child_process";

function mockBuffer(text: string): Buffer {
  return Buffer.from(text);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("hasSession", () => {
  it("returns true when tmux has-session succeeds", () => {
    vi.mocked(execSync).mockReturnValue(mockBuffer(""));
    expect(hasSession("pi-agent")).toBe(true);
    expect(execSync).toHaveBeenCalledWith(
      "tmux has-session -t '=pi-agent' 2>/dev/null",
      expect.anything(),
    );
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
    vi.mocked(execSync).mockReturnValue(
      mockBuffer("pi-agent\nother-session\n"),
    );
    expect(listSessions()).toEqual(["pi-agent", "other-session"]);
  });

  it("returns empty array when no sessions", () => {
    vi.mocked(execSync).mockReturnValue(mockBuffer(""));
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
  it("calls tmux kill-session with exact target and returns true when removed", () => {
    vi.mocked(execSync)
      .mockReturnValueOnce(mockBuffer(""))
      .mockImplementationOnce(() => {
        throw new Error("no session");
      });
    expect(killSession("pi-agent")).toBe(true);
    expect(execSync).toHaveBeenCalledWith(
      "tmux kill-session -t '=pi-agent' 2>/dev/null",
      expect.anything(),
    );
  });

  it("returns false on failure", () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("no session");
    });
    expect(killSession("pi-agent")).toBe(false);
  });
});

describe("capturePane", () => {
  it("returns captured output", () => {
    vi.mocked(execSync).mockReturnValue(mockBuffer("line1\nline2\n"));
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
    const pty = {
      kill: killed,
      resize: vi.fn(),
      write: vi.fn(),
    } as unknown as IPty;
    detachPty(pty);
    expect(killed).toHaveBeenCalled();
  });

  it("does not throw if kill fails", () => {
    const pty = {
      kill: () => {
        throw new Error("already dead");
      },
    } as unknown as IPty;
    expect(() => detachPty(pty)).not.toThrow();
  });
});

describe("ensureSession", () => {
  beforeEach(() => {
    // Stub SHELL so the login-shell wrapper is predictable
    vi.stubEnv("SHELL", "/bin/zsh");
    // Default: execSync throws → hasSession returns false in most tests
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("no session");
    });
  });

  it("creates a new tmux session with login-shell wrapper", () => {
    // hasSession → false (default throw), then creation commands succeed
    vi.mocked(execSync)
      .mockImplementationOnce(() => {
        throw new Error("no session");
      }) // hasSession → false
      .mockImplementationOnce(() => mockBuffer("")) // new-session
      .mockImplementationOnce(() => mockBuffer("")) // set window-size
      .mockImplementationOnce(() => mockBuffer("")) // set status off
      .mockImplementationOnce(() => mockBuffer("")); // set history-limit

    ensureSession("pi-agent", "/home/user/project", "pi");

    // Verify new-session call uses login-shell wrapper
    const createCall = vi.mocked(execSync).mock.calls[1][0] as string;
    expect(createCall).toContain('/bin/zsh -l -i -c "exec pi"');
    expect(createCall).toContain("tmux new-session");
    expect(vi.mocked(execSync).mock.calls[1][1]).toMatchObject({
      timeout: 10_000,
    });
  });

  it("does nothing if session already exists", () => {
    // Override default: execSync succeeds → hasSession returns true
    vi.mocked(execSync).mockReset();
    vi.mocked(execSync).mockReturnValue(mockBuffer(""));

    ensureSession("existing-session", "/home/user/project", "pi");

    // Only the hasSession check was called
    expect(execSync).toHaveBeenCalledTimes(1);
    expect(execSync).toHaveBeenCalledWith(
      "tmux has-session -t '=existing-session' 2>/dev/null",
      expect.anything(),
    );
  });

  it("throws on empty session name", () => {
    // hasSession("") returns false immediately (name is empty), no execSync call
    expect(() => ensureSession("", "/path", "pi")).toThrow(
      "Invalid session params",
    );
  });

  it("throws on empty cwd", () => {
    // execSync throws (default mock) → hasSession returns false → validation fires
    expect(() => ensureSession("sess", "", "pi")).toThrow(
      "Invalid session params",
    );
  });

  it("disables status bar and sets history limit after creation", () => {
    // hasSession → false (default throw), then creation commands succeed
    vi.mocked(execSync)
      .mockImplementationOnce(() => {
        throw new Error("no session");
      }) // hasSession → false
      .mockImplementationOnce(() => mockBuffer("")) // new-session
      .mockImplementationOnce(() => mockBuffer("")) // set window-size
      .mockImplementationOnce(() => mockBuffer("")) // set status off
      .mockImplementationOnce(() => mockBuffer("")); // set history-limit

    ensureSession("pi-agent", "/home/user/project", "pi");

    expect(execSync).toHaveBeenCalledTimes(5);
    expect(vi.mocked(execSync).mock.calls[3][0]).toContain(
      "set -t pi-agent status off",
    );
    expect(vi.mocked(execSync).mock.calls[4][0]).toContain(
      "set -t pi-agent history-limit 10000",
    );
  });
});
