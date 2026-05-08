import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NOTIFY_IDLE_CHANNEL } from "../shared/internal-events.ts";
import { clearSettingsCache } from "../shared/settings.ts";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const loadNotify = async () => import("./notify.js");
const loadExecFile = async () => (await import("node:child_process")).execFile;

const createTempDir = (prefix: string): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const writeNotifySettings = (
  cwd: string,
  notify: Record<string, unknown>,
): void => {
  const settingsPath = path.join(cwd, ".pi", "third_extension_settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(
    settingsPath,
    `${JSON.stringify({ notify }, null, 2)}\n`,
    "utf-8",
  );
  clearSettingsCache();
};

type NotifyHarness = {
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
  events: { emitted: Array<{ channel: string; payload: unknown }> };
  write: ReturnType<typeof vi.spyOn>;
};

const buildNotifyHarness = async (): Promise<NotifyHarness> => {
  delete process.env.TMUX;
  const events = {
    emitted: [] as Array<{ channel: string; payload: unknown }>,
    emit(channel: string, payload: unknown) {
      this.emitted.push({ channel, payload });
    },
    on: vi.fn(),
  };
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
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

  return { handlers, events, write };
};

const emitAgentEnd = async (
  harness: NotifyHarness,
  event: unknown,
  cwd = process.cwd(),
  ctxOverrides: Record<string, unknown> = {},
): Promise<void> => {
  const ctx = {
    cwd,
    sessionManager: {
      getEntries: () => [],
    },
    ...ctxOverrides,
  };
  await harness.handlers.get("agent_end")?.(event, ctx);
};

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  clearSettingsCache();
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
    const harness = await buildNotifyHarness();

    await emitAgentEnd(harness, {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Finished the work." }],
        },
      ],
    });

    expect(harness.write).toHaveBeenCalled();
    expect(harness.events.emitted).toHaveLength(1);
    expect(harness.events.emitted[0]).toEqual({
      channel: NOTIFY_IDLE_CHANNEL,
      payload: expect.objectContaining({
        type: "notify.idle",
        title: "π",
        body: "Finished the work.",
      }),
    });
  });
});

describe("notify failure scenarios", () => {
  it("labels error turns as failed notifications", async () => {
    const harness = await buildNotifyHarness();

    await emitAgentEnd(harness, {
      messages: [
        {
          role: "assistant",
          stopReason: "error",
          content: [{ type: "text", text: "Build failed." }],
        },
      ],
    });

    expect(harness.write).toHaveBeenCalledWith(
      expect.stringContaining("777;notify;π failed;Build failed."),
    );
    expect(harness.events.emitted).toHaveLength(0);
  });

  it("skips aborted turn notifications by default", async () => {
    const harness = await buildNotifyHarness();

    await emitAgentEnd(harness, {
      messages: [{ role: "assistant", stopReason: "aborted" }],
    });

    expect(harness.write).not.toHaveBeenCalled();
    expect(harness.events.emitted).toHaveLength(0);
  });

  it("can notify when aborted turns are explicitly enabled", async () => {
    const cwd = createTempDir("pi-kit-notify-repo-");
    writeNotifySettings(cwd, { notifyOnAbort: true });
    const harness = await buildNotifyHarness();

    await emitAgentEnd(
      harness,
      { messages: [{ role: "assistant", stopReason: "aborted" }] },
      cwd,
    );

    expect(harness.write).toHaveBeenCalledWith(
      expect.stringContaining("777;notify;π stopped;Agent run was stopped."),
    );
    expect(harness.events.emitted).toHaveLength(0);
  });

  it("labels truncated turns as needing attention", async () => {
    const harness = await buildNotifyHarness();

    await emitAgentEnd(harness, {
      messages: [
        {
          role: "assistant",
          stopReason: "length",
          content: "Partial answer",
        },
      ],
    });

    expect(harness.write).toHaveBeenCalledWith(
      expect.stringContaining("777;notify;π output truncated;Partial answer"),
    );
    expect(harness.events.emitted).toHaveLength(0);
  });

  it("does not throw or emit idle events when stdout write fails", async () => {
    const harness = await buildNotifyHarness();
    harness.write.mockImplementation(() => {
      throw new Error("stdout closed");
    });

    await expect(
      emitAgentEnd(harness, {
        messages: [{ role: "assistant", content: "Finished." }],
      }),
    ).resolves.toBeUndefined();
    expect(harness.events.emitted).toHaveLength(0);
  });

  it("sanitizes OSC control characters from notification fields", async () => {
    const harness = await buildNotifyHarness();

    await emitAgentEnd(harness, {
      messages: [{ role: "assistant", content: "ok\u001b]bad\u0007 done" }],
    });

    const payload = String(harness.write.mock.calls[0]?.[0]);
    const prefix = "\u001b]777;notify;π;";
    expect(payload.startsWith(prefix)).toBe(true);
    const bodyPayload = payload.slice(prefix.length);
    expect(bodyPayload.slice(0, -1)).toBe("ok]bad done");
  });
});

describe("notify config", () => {
  it("normalizes invalid settings to defaults", async () => {
    const { DEFAULT_CONFIG, normalizeNotifyConfig } = await loadNotify();

    expect(
      normalizeNotifyConfig({
        enabled: "no",
        notifyOnAbort: "yes",
        notifyOnFailure: null,
        notifyOnTruncation: 1,
        maxBodyChars: -1,
      }),
    ).toEqual(DEFAULT_CONFIG);
  });

  it("does not send notifications when disabled in settings", async () => {
    const cwd = createTempDir("pi-kit-notify-repo-");
    writeNotifySettings(cwd, { enabled: false });
    const harness = await buildNotifyHarness();

    await emitAgentEnd(
      harness,
      { messages: [{ role: "assistant", content: "Finished." }] },
      cwd,
    );

    expect(harness.write).not.toHaveBeenCalled();
    expect(harness.events.emitted).toHaveLength(0);
  });
});
