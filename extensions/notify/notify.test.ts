import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const loadNotify = async () => import("./notify.js");
const loadExecFile = async () => (await import("node:child_process")).execFile;

afterEach(() => {
  vi.clearAllMocks();
});

describe("notify tmux title", () => {
  it("uses tmux window name when available", async () => {
    const execFile = await loadExecFile();
    vi.mocked(execFile).mockImplementation((_file, _args, callback) => {
      callback(null, "work\n", "");
      return {} as never;
    });

    const { resolveNotificationTitle } = await loadNotify();
    const title = await resolveNotificationTitle("π", true);

    expect(title).toBe("work - π");
    expect(execFile).toHaveBeenCalled();
  });

  it("falls back to π when tmux window is empty", async () => {
    const execFile = await loadExecFile();
    vi.mocked(execFile).mockImplementation((_file, _args, callback) => {
      callback(null, "\n", "");
      return {} as never;
    });

    const { resolveNotificationTitle } = await loadNotify();
    const title = await resolveNotificationTitle("π", true);

    expect(title).toBe("π");
    expect(execFile).toHaveBeenCalled();
  });

  it("keeps π when not in tmux", async () => {
    const execFile = await loadExecFile();
    vi.mocked(execFile).mockImplementation((_file, _args, callback) => {
      callback(null, "work\n", "");
      return {} as never;
    });

    const { resolveNotificationTitle } = await loadNotify();
    const title = await resolveNotificationTitle("π", false);

    expect(title).toBe("π");
    expect(execFile).not.toHaveBeenCalled();
  });
});
