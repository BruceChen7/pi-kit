import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process/promises", () => ({
  execFile: vi.fn(),
}));

const loadNotify = async () => import("./notify.js");
const loadExecFile = async () =>
  (await import("node:child_process/promises")).execFile;

afterEach(() => {
  vi.clearAllMocks();
});

describe("notify tmux title", () => {
  it("uses tmux window name when available", async () => {
    const execFile = await loadExecFile();
    vi.mocked(execFile).mockResolvedValue({ stdout: "work\n", stderr: "" });

    const { resolveNotificationTitle } = await loadNotify();
    const title = await resolveNotificationTitle("π", true);

    expect(title).toBe("work - π");
  });

  it("falls back to π when tmux window is empty", async () => {
    const execFile = await loadExecFile();
    vi.mocked(execFile).mockResolvedValue({ stdout: "\n", stderr: "" });

    const { resolveNotificationTitle } = await loadNotify();
    const title = await resolveNotificationTitle("π", true);

    expect(title).toBe("π");
  });

  it("keeps π when not in tmux", async () => {
    const execFile = await loadExecFile();
    vi.mocked(execFile).mockResolvedValue({ stdout: "work\n", stderr: "" });

    const { resolveNotificationTitle } = await loadNotify();
    const title = await resolveNotificationTitle("π", false);

    expect(title).toBe("π");
    expect(execFile).not.toHaveBeenCalled();
  });
});
