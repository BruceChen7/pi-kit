import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const installStdoutSpy = (): ReturnType<typeof vi.spyOn> =>
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);

const buildNotifyHarness = async (
  options: {
    /** Share one stdout spy across harnesses to count the real transport calls. */
    write?: NotifyHarness["write"];
  } = {},
): Promise<NotifyHarness> => {
  delete process.env.TMUX;
  const events = {
    emitted: [] as Array<{ channel: string; payload: unknown }>,
    emit(channel: string, payload: unknown) {
      this.emitted.push({ channel, payload });
    },
    on: vi.fn(),
  };
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const write = options.write ?? installStdoutSpy();
  const notify = (await loadNotify()).default;

  await notify({
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(name, handler);
    },
    events,
  } as never);

  return { handlers, events, write };
};

const messageEntries = (messages: unknown[]): unknown[] =>
  messages.map((message) => ({ type: "message", message }));

const buildDispatchContext = (
  cwd: string,
  options: {
    messages?: unknown[];
    ctxOverrides?: Record<string, unknown>;
  } = {},
): unknown => {
  const entries = messageEntries(options.messages ?? []);
  return {
    cwd,
    sessionManager: {
      getEntries: () => entries,
      getBranch: () => entries,
    },
    ...options.ctxOverrides,
  };
};

const dispatchSettled = async (
  harness: NotifyHarness,
  event: unknown,
  ctx: unknown,
): Promise<void> => {
  await harness.handlers.get("agent_settled")?.(event, ctx);
};

/**
 * `agent_settled` 只带 `aborted`，正文来自会话记录，所以这里把消息塞进
 * sessionManager 条目里，而不是事件里。
 */
const emitSettled = async (
  harness: NotifyHarness,
  event: { messages?: unknown[]; aborted?: boolean } = {},
  cwd = process.cwd(),
  ctxOverrides: Record<string, unknown> = {},
): Promise<void> => {
  await dispatchSettled(
    harness,
    { aborted: event.aborted ?? false },
    buildDispatchContext(cwd, {
      messages: event.messages ?? [],
      ctxOverrides,
    }),
  );
};

/**
 * 宿主档案必须由用例自己决定。运行者的 shell 里可能带着 PI_KIT_UI_HOST
 * （在 pi-clients 的 worker 里跑测试时一定有 android），漏清就会让整个套件的
 * 默认通道从 OSC 777 变成宿主 toast —— 判据随环境漂移。
 */
beforeEach(() => {
  delete process.env.PI_KIT_UI_HOST;
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  delete process.env.HERDR_PANE_ID;
  delete process.env.HERDR_BIN_PATH;
  delete process.env.PI_KIT_UI_HOST;
  clearSettingsCache();
});

describe("notify tmux title", () => {
  it("uses tmux window name when available", async () => {
    const execFile = await loadExecFile();
    vi.mocked(execFile).mockImplementation(
      (_file, _args, _options, callback) => {
        callback?.(null, "work\n", "");
        return {} as never;
      },
    );

    const { resolveNotificationTitle } = await loadNotify();
    const title = await resolveNotificationTitle("π", true);

    expect(title).toBe("work - π");
    expect(execFile).toHaveBeenCalled();
  });

  it("falls back to π when tmux window is empty", async () => {
    const execFile = await loadExecFile();
    vi.mocked(execFile).mockImplementation(
      (_file, _args, _options, callback) => {
        callback?.(null, "\n", "");
        return {} as never;
      },
    );

    const { resolveNotificationTitle } = await loadNotify();
    const title = await resolveNotificationTitle("π", true);

    expect(title).toBe("π");
    expect(execFile).toHaveBeenCalled();
  });

  it("keeps π when not in tmux", async () => {
    const execFile = await loadExecFile();
    vi.mocked(execFile).mockImplementation(
      (_file, _args, _options, callback) => {
        callback?.(null, "work\n", "");
        return {} as never;
      },
    );

    const { resolveNotificationTitle } = await loadNotify();
    const title = await resolveNotificationTitle("π", false);

    expect(title).toBe("π");
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe("notify idle events", () => {
  it("emits an internal idle event after local desktop notification", async () => {
    const harness = await buildNotifyHarness();

    await emitSettled(harness, {
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

describe("settle trigger", () => {
  it("notifies on agent_settled and registers no agent_end handler", async () => {
    const harness = await buildNotifyHarness();

    expect(harness.handlers.has("agent_settled")).toBe(true);
    expect(harness.handlers.has("agent_end")).toBe(false);
  });

  it("takes the body from the settled turn, not an earlier one", async () => {
    const harness = await buildNotifyHarness();

    await emitSettled(harness, {
      messages: [
        { role: "assistant", content: "Previous turn answer." },
        { role: "user", content: "next question" },
        { role: "assistant", content: "Settled turn answer." },
      ],
    });

    const payload = String(harness.write.mock.calls.at(-1)?.[0]);
    expect(payload).toContain(";Settled turn answer.");
    expect(payload).not.toContain("Previous turn answer.");
  });

  it("says ready for input when the settled run produced no assistant text", async () => {
    const harness = await buildNotifyHarness();

    await emitSettled(harness, {
      messages: [
        { role: "assistant", content: "Previous turn answer." },
        { role: "user", content: "aborted before any output" },
      ],
    });

    expect(harness.write).toHaveBeenCalledWith(
      expect.stringContaining("777;notify;Ready for input;"),
    );
    expect(harness.events.emitted).toHaveLength(1);
  });
});

describe("runMessagesFromEntries", () => {
  it("keeps only messages after the last user message", async () => {
    const { runMessagesFromEntries } = await loadNotify();

    expect(
      runMessagesFromEntries([
        { type: "message", message: { role: "assistant", content: "old" } },
        { type: "message", message: { role: "user", content: "q" } },
        { type: "message", message: { role: "assistant", content: "new" } },
      ]),
    ).toEqual([{ role: "assistant", content: "new" }]);
  });

  it("ignores session entries that carry no message", async () => {
    const { runMessagesFromEntries } = await loadNotify();

    expect(
      runMessagesFromEntries([
        { type: "compaction", summary: "…" },
        { type: "label", label: "x" },
        { type: "message", message: { role: "assistant", content: "only" } },
        "not-an-entry",
      ]),
    ).toEqual([{ role: "assistant", content: "only" }]);
  });

  it("returns every message when the branch has no user entry", async () => {
    const { runMessagesFromEntries } = await loadNotify();

    expect(
      runMessagesFromEntries([
        { type: "message", message: { role: "assistant", content: "a" } },
      ]),
    ).toEqual([{ role: "assistant", content: "a" }]);
  });
});

describe("duplicate notify loads", () => {
  // These tests assert on the local transport, so they must not depend on the
  // order in which the file's other tests cleaned up HERDR_* / TMUX.
  beforeEach(() => {
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_BIN_PATH;
    delete process.env.TMUX;
  });

  it("claims every dispatch context exactly once", async () => {
    const { claimDispatch } = await loadNotify();
    const claims = new WeakSet<object>();
    const ctx = {};

    expect(claimDispatch(claims, ctx)).toBe(true);
    expect(claimDispatch(claims, ctx)).toBe(false);
    expect(claimDispatch(claims, {})).toBe(true);
    // Hosts that hand over no ctx keep the old behaviour: nothing is deduped.
    expect(claimDispatch(claims, undefined)).toBe(true);
  });

  it("handles one agent_settled dispatch once when notify is loaded twice", async () => {
    const write = installStdoutSpy();
    const primary = await buildNotifyHarness({ write });
    const duplicate = await buildNotifyHarness({ write });
    // pi hands the same ctx object to every handler of one dispatch, even when
    // two extension paths loaded the same file.
    const ctx = buildDispatchContext(process.cwd(), {
      messages: [{ role: "assistant", content: "Finished the work." }],
    });
    const event = { aborted: false };

    await dispatchSettled(primary, event, ctx);
    await dispatchSettled(duplicate, event, ctx);

    expect(write).toHaveBeenCalledTimes(1);
    expect(primary.events.emitted).toHaveLength(1);
    expect(duplicate.events.emitted).toHaveLength(0);
  });

  it("keeps notifying for separate dispatches in the same process", async () => {
    const write = installStdoutSpy();
    const harness = await buildNotifyHarness({ write });

    await emitSettled(harness, {
      messages: [{ role: "assistant", content: "First turn." }],
    });
    await emitSettled(harness, {
      messages: [{ role: "assistant", content: "Second turn." }],
    });

    expect(write).toHaveBeenCalledTimes(2);
    expect(harness.events.emitted).toHaveLength(2);
  });
});

describe("notify failure scenarios", () => {
  it("labels error turns as failed notifications", async () => {
    const harness = await buildNotifyHarness();

    await emitSettled(harness, {
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

    await emitSettled(harness, { aborted: true });

    expect(harness.write).not.toHaveBeenCalled();
    expect(harness.events.emitted).toHaveLength(0);
  });

  it("can notify when aborted turns are explicitly enabled", async () => {
    const cwd = createTempDir("pi-kit-notify-repo-");
    writeNotifySettings(cwd, { notifyOnAbort: true });
    const harness = await buildNotifyHarness();

    await emitSettled(harness, { aborted: true }, cwd);

    expect(harness.write).toHaveBeenCalledWith(
      expect.stringContaining("777;notify;π stopped;Agent run was stopped."),
    );
    expect(harness.events.emitted).toHaveLength(0);
  });

  it("labels truncated turns as needing attention", async () => {
    const harness = await buildNotifyHarness();

    await emitSettled(harness, {
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
      emitSettled(harness, {
        messages: [{ role: "assistant", content: "Finished." }],
      }),
    ).resolves.toBeUndefined();
    expect(harness.events.emitted).toHaveLength(0);
  });

  it("sanitizes OSC control characters from notification fields", async () => {
    const harness = await buildNotifyHarness();

    await emitSettled(harness, {
      messages: [{ role: "assistant", content: "ok\u001b]bad\u0007 done" }],
    });

    const payload = String(harness.write.mock.calls[0]?.[0]);
    const prefix = "\u001b]777;notify;π;";
    expect(payload.startsWith(prefix)).toBe(true);
    const bodyPayload = payload.slice(prefix.length);
    expect(bodyPayload.slice(0, -1)).toBe("ok]bad done");
  });
});

// ── Test helpers ──────────────────────────────────────────────────────────────

const mockHerdrExec = async (error?: Error) => {
  const execFile = await loadExecFile();
  vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => {
    callback?.((error ?? null) as never, "", "");
    return {} as never;
  });
  return execFile;
};

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("panel transport", () => {
  // pi-clients 的 worker 跑在 macOS 终端里，所以子进程继承了 HERDR_PANE_ID /
  // TMUX / TERM_PROGRAM：终端判据在这里都会误判成“有终端”。唯一的可信事实是
  // 宿主档案（PI_KIT_UI_HOST=android）与 ctx.ui.notify 这条通道。
  beforeEach(() => {
    process.env.PI_KIT_UI_HOST = "android";
    process.env.HERDR_PANE_ID = "inherited-pane";
    process.env.HERDR_BIN_PATH = "/nonexistent/herdr";
  });

  afterEach(() => {
    delete process.env.PI_KIT_UI_HOST;
  });

  it("routes the notification to the host toast and never to a terminal", async () => {
    const execFile = await mockHerdrExec();
    const harness = await buildNotifyHarness();
    const toast = vi.fn();

    await emitSettled(
      harness,
      { messages: [{ role: "assistant", content: "Finished the work." }] },
      process.cwd(),
      { hasUI: true, mode: "rpc", ui: { notify: toast } },
    );

    expect(toast).toHaveBeenCalledWith("π: Finished the work.", "info");
    expect(harness.write).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });

  it("keeps emitting the idle event for a successful run", async () => {
    const harness = await buildNotifyHarness();

    await emitSettled(
      harness,
      { messages: [{ role: "assistant", content: "Finished the work." }] },
      process.cwd(),
      { hasUI: true, mode: "rpc", ui: { notify: vi.fn() } },
    );

    expect(harness.events.emitted).toHaveLength(1);
  });

  it("still writes OSC 777 on a terminal host", async () => {
    delete process.env.PI_KIT_UI_HOST;
    delete process.env.HERDR_PANE_ID;
    const harness = await buildNotifyHarness();
    const toast = vi.fn();

    await emitSettled(
      harness,
      { messages: [{ role: "assistant", content: "Finished the work." }] },
      process.cwd(),
      {
        hasUI: true,
        mode: "tui",
        // 终端宿主的 ctx 上也有 notify（画应用内提示），但它不是 OSC 777 的替代品。
        ui: { notify: toast },
      },
    );

    expect(harness.write).toHaveBeenCalledWith(
      expect.stringContaining("777;notify;π;Finished the work."),
    );
    expect(toast).not.toHaveBeenCalled();
  });

  it("keeps the herdr CLI on a terminal host that has a herdr pane", async () => {
    delete process.env.PI_KIT_UI_HOST;
    process.env.HERDR_PANE_ID = "pane-terminal";
    const execFile = await mockHerdrExec();
    const harness = await buildNotifyHarness();

    await emitSettled(
      harness,
      { messages: [{ role: "assistant", content: "Finished the work." }] },
      process.cwd(),
      { hasUI: true, mode: "tui", ui: { notify: vi.fn() } },
    );

    expect(execFile).toHaveBeenCalledTimes(1);
    expect(harness.write).not.toHaveBeenCalled();
  });
});

describe("herdr transport", () => {
  it("sends notification via herdr CLI when HERDR_PANE_ID is set", async () => {
    process.env.HERDR_PANE_ID = "pane-123";
    const execFile = await mockHerdrExec();
    const harness = await buildNotifyHarness();

    await emitSettled(harness, {
      messages: [{ role: "assistant", content: "Done." }],
    });

    // herdr CLI was called
    expect(execFile).toHaveBeenCalledTimes(1);
    // Should not write OSC 777 to stdout
    expect(harness.write).not.toHaveBeenCalled();
    // Should still emit idle event on success
    expect(harness.events.emitted).toHaveLength(1);
    expect(harness.events.emitted[0].payload).toMatchObject({
      type: "notify.idle",
      title: "π",
      body: "Done.",
    });
  });

  it("formats herdr CLI arguments correctly", async () => {
    process.env.HERDR_PANE_ID = "pane-arg-test";
    const execFile = await mockHerdrExec();
    const harness = await buildNotifyHarness();

    await emitSettled(harness, {
      messages: [{ role: "assistant", content: "Done." }],
    });

    expect(execFile).toHaveBeenCalledWith(
      "herdr",
      [
        "notification",
        "show",
        "π",
        "--body",
        "Done.",
        "--position",
        "top-right",
        "--sound",
        "request",
      ],
      { timeout: 3000 },
      expect.any(Function),
    );
  });

  it("uses HERDR_BIN_PATH when set", async () => {
    process.env.HERDR_PANE_ID = "pane-456";
    process.env.HERDR_BIN_PATH = "/opt/bin/herdr";
    const execFile = await mockHerdrExec();
    const harness = await buildNotifyHarness();

    await emitSettled(harness, {
      messages: [{ role: "assistant", content: "Done." }],
    });

    expect(execFile).toHaveBeenCalledWith(
      "/opt/bin/herdr",
      expect.any(Array),
      { timeout: 3000 },
      expect.any(Function),
    );
  });

  it("fails closed when herdr CLI errors", async () => {
    process.env.HERDR_PANE_ID = "pane-789";
    const _execFile = await mockHerdrExec(new Error("herdr not found"));
    const harness = await buildNotifyHarness();

    await emitSettled(harness, {
      messages: [{ role: "assistant", content: "Done." }],
    });

    // Should not write OSC 777 to stdout
    expect(harness.write).not.toHaveBeenCalled();
    // Should not emit idle event (transport failed)
    expect(harness.events.emitted).toHaveLength(0);
  });

  it("sanitizes herdr notification body", async () => {
    process.env.HERDR_PANE_ID = "pane-abc";
    const execFile = await mockHerdrExec();
    const harness = await buildNotifyHarness();

    await emitSettled(harness, {
      messages: [{ role: "assistant", content: "ok\u001b]bad\u0007 done" }],
    });

    // Sanitized body passed to herdr CLI (control chars stripped)
    expect(execFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["--body", "ok]bad done"]),
      { timeout: 3000 },
      expect.any(Function),
    );
    expect(harness.write).not.toHaveBeenCalled();
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

    await emitSettled(
      harness,
      { messages: [{ role: "assistant", content: "Finished." }] },
      cwd,
    );

    expect(harness.write).not.toHaveBeenCalled();
    expect(harness.events.emitted).toHaveLength(0);
  });
});
