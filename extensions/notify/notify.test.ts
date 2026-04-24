import { afterEach, describe, expect, it, vi } from "vitest";

import { NOTIFY_IDLE_CHANNEL } from "../shared/internal-events.ts";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const loadNotify = async () => import("./notify.js");
const loadExecFile = async () => (await import("node:child_process")).execFile;

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
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

describe("notify idle events", () => {
  it("emits an internal idle event after local desktop notification", async () => {
    const originalTmux = process.env.TMUX;
    delete process.env.TMUX;
    const events = {
      emitted: [] as Array<{ channel: string; payload: unknown }>,
      emit(channel: string, payload: unknown) {
        this.emitted.push({ channel, payload });
      },
      on: vi.fn(),
    };
    const handlers = new Map<
      string,
      (event: unknown, ctx: unknown) => unknown
    >();
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const notify = (await loadNotify()).default;

    await notify({
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        handlers.set(name, handler);
      },
      events,
    } as never);

    const ctx = {
      cwd: process.cwd(),
      sessionManager: {
        getEntries: () => [],
      },
    };
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Finished the work." }],
          },
        ],
      },
      ctx,
    );

    expect(write).toHaveBeenCalled();
    expect(events.emitted).toHaveLength(1);
    expect(events.emitted[0]).toEqual({
      channel: NOTIFY_IDLE_CHANNEL,
      payload: expect.objectContaining({
        type: "notify.idle",
        title: "π",
        body: "Finished the work.",
        ctx,
      }),
    });
    process.env.TMUX = originalTmux;
  });
});
