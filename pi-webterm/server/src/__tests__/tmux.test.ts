import type { IPty } from "node-pty";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachToSession,
  buildSessionCommands,
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

// execSync with encoding: "utf-8" returns a string
const mockOutput = (text: string): string => text;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("hasSession", () => {
  it("returns true when tmux has-session succeeds", () => {
    vi.mocked(execSync).mockReturnValue(mockOutput(""));
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
      mockOutput("pi-agent\nother-session\n"),
    );
    expect(listSessions()).toEqual(["pi-agent", "other-session"]);
  });

  it("returns empty array when no sessions", () => {
    vi.mocked(execSync).mockReturnValue(mockOutput(""));
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
      .mockReturnValueOnce(mockOutput(""))
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
    vi.mocked(execSync).mockReturnValue(mockOutput("line1\nline2\n"));
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

// ─── Pure: buildSessionCommands (no mocks needed) ───────────────

describe("buildSessionCommands", () => {
  it("returns 4 commands for a valid config", () => {
    const commands = buildSessionCommands({
      name: "pi-agent",
      cwd: "/home/user/project",
      shell: "/bin/zsh",
      agentCommand: "pi",
    });

    expect(commands).toHaveLength(4);
    // new-session uses login-shell wrapper
    expect(commands[0].command).toContain("tmux new-session");
    expect(commands[0].command).toContain('/bin/zsh -l -i -c "exec pi"');
    expect(commands[0].timeout).toBe(10_000);
    // config commands use 5 s timeout
    for (let i = 1; i < 4; i++) {
      expect(commands[i].timeout).toBe(5_000);
    }
    // specific config options
    expect(commands[1].command).toContain("window-size largest");
    expect(commands[2].command).toContain("status off");
    expect(commands[3].command).toContain("history-limit 10000");
  });

  it("throws on empty session name", () => {
    expect(() =>
      buildSessionCommands({
        name: "",
        cwd: "/path",
        shell: "/bin/bash",
        agentCommand: "pi",
      }),
    ).toThrow("Invalid session params");
  });

  it("throws on empty cwd", () => {
    expect(() =>
      buildSessionCommands({
        name: "sess",
        cwd: "",
        shell: "/bin/bash",
        agentCommand: "pi",
      }),
    ).toThrow("Invalid session params");
  });
});

// ─── Shell: ensureSession (wiring tests) ────────────────────────

describe("ensureSession", () => {
  beforeEach(() => {
    vi.stubEnv("SHELL", "/bin/zsh");
    // Default: execSync throws → hasSession returns false
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("no session");
    });
  });

  it("does nothing if session already exists", () => {
    vi.mocked(execSync).mockReset();
    vi.mocked(execSync).mockReturnValue(mockOutput(""));

    ensureSession("existing-session", "/home/user/project", "pi");

    expect(execSync).toHaveBeenCalledTimes(1);
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining("tmux has-session -t"),
      expect.anything(),
    );
  });

  it("creates session and runs config commands when not exist", () => {
    // hasSession fails → buildSessionCommands commands each succeed
    vi.mocked(execSync)
      .mockImplementationOnce(() => {
        throw new Error("no session");
      }) // hasSession → false
      .mockImplementationOnce(() => mockOutput("")) // new-session
      .mockImplementationOnce(() => mockOutput("")) // window-size
      .mockImplementationOnce(() => mockOutput("")) // status off
      .mockImplementationOnce(() => mockOutput("")); // history-limit

    expect(() =>
      ensureSession("pi-agent", "/home/user/project", "pi"),
    ).not.toThrow();

    // hasSession + 4 config commands = 5 total calls
    expect(execSync).toHaveBeenCalledTimes(5);
  });

  it("throws on empty session name", () => {
    expect(() => ensureSession("", "/path", "pi")).toThrow(
      "Invalid session params",
    );
  });

  it("throws on empty cwd", () => {
    expect(() => ensureSession("sess", "", "pi")).toThrow(
      "Invalid session params",
    );
  });
});
