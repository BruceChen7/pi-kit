import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearSettingsCache } from "../shared/settings.ts";
import brainstormEvents, {
  DEFAULT_CONFIG,
  dispatchEvents,
  type EventFileCursor,
  normalizeBrainstormEventsConfig,
  parseEventsJsonl,
  readNewEvents,
} from "./index.ts";

const createTempDir = (prefix: string): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const writeSettings = (
  cwd: string,
  brainstormEventsSettings: Record<string, unknown>,
): void => {
  const settingsPath = path.join(cwd, ".pi", "third_extension_settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(
    settingsPath,
    `${JSON.stringify({ brainstormEvents: brainstormEventsSettings }, null, 2)}\n`,
    "utf-8",
  );
  clearSettingsCache();
};

type Handler = (event: unknown, ctx: unknown) => unknown;

type BrainstormEventsHarness = {
  handlers: Map<string, Handler>;
  sendUserMessage: ReturnType<typeof vi.fn>;
};

const buildHarness = (): BrainstormEventsHarness => {
  const handlers = new Map<string, Handler>();
  const sendUserMessage = vi.fn();

  brainstormEvents({
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    sendUserMessage,
  } as never);

  return { handlers, sendUserMessage };
};

const emitSessionStart = async (
  harness: BrainstormEventsHarness,
  cwd: string,
  isIdle = true,
): Promise<void> => {
  await harness.handlers.get("session_start")?.(
    { reason: "startup" },
    {
      cwd,
      isIdle: () => isIdle,
    },
  );
};

const emitSessionShutdown = async (
  harness: BrainstormEventsHarness,
): Promise<void> => {
  await harness.handlers.get("session_shutdown")?.({ reason: "quit" }, {});
};

afterEach(() => {
  vi.restoreAllMocks();
  clearSettingsCache();
});

describe("brainstorm event config", () => {
  it("normalizes invalid settings to defaults", () => {
    expect(
      normalizeBrainstormEventsConfig({
        enabled: "yes",
        debounceMs: -1,
        deliverWhileBusy: "later",
        maxEventsPerMessage: 0,
      }),
    ).toEqual(DEFAULT_CONFIG);
  });

  it("accepts valid settings", () => {
    expect(
      normalizeBrainstormEventsConfig({
        enabled: false,
        debounceMs: 10,
        deliverWhileBusy: "steer",
        maxEventsPerMessage: 3,
      }),
    ).toEqual({
      enabled: false,
      debounceMs: 10,
      deliverWhileBusy: "steer",
      maxEventsPerMessage: 3,
    });
  });
});

describe("brainstorm event parsing", () => {
  it("parses JSONL records and ignores invalid lines", () => {
    expect(
      parseEventsJsonl(
        [
          JSON.stringify({ type: "click", choice: "a" }),
          "not-json",
          JSON.stringify(["not", "record"]),
          JSON.stringify({ type: "click", choice: "b" }),
        ].join("\n"),
      ),
    ).toEqual([
      { type: "click", choice: "a" },
      { type: "click", choice: "b" },
    ]);
  });

  it("reads only newly appended event bytes", () => {
    const cwd = createTempDir("pi-kit-brainstorm-events-read-");
    const filePath = path.join(cwd, ".events");
    fs.writeFileSync(filePath, `${JSON.stringify({ choice: "a" })}\n`);

    const state: EventFileCursor = {
      filePath,
      offsetBytes: 0,
    };

    expect(readNewEvents(state)).toEqual([{ choice: "a" }]);
    expect(readNewEvents(state)).toEqual([]);

    fs.appendFileSync(filePath, `${JSON.stringify({ choice: "b" })}\n`);
    expect(readNewEvents(state)).toEqual([{ choice: "b" }]);
  });
});

describe("brainstorm event dispatch", () => {
  it("sends an immediate user message when the agent is idle", () => {
    const sendUserMessage = vi.fn();

    dispatchEvents(
      { sendUserMessage } as never,
      { isIdle: () => true } as never,
      DEFAULT_CONFIG,
      [{ type: "click", choice: "a" }],
    );

    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining('"choice": "a"'),
    );
  });

  it("queues a follow-up user message when the agent is busy", () => {
    const sendUserMessage = vi.fn();

    dispatchEvents(
      { sendUserMessage } as never,
      { isIdle: () => false } as never,
      DEFAULT_CONFIG,
      [{ type: "click", choice: "a" }],
    );

    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining('"choice": "a"'),
      { deliverAs: "followUp" },
    );
  });

  it("caps large batches to the newest events", () => {
    const sendUserMessage = vi.fn();

    dispatchEvents(
      { sendUserMessage } as never,
      { isIdle: () => true } as never,
      { ...DEFAULT_CONFIG, maxEventsPerMessage: 1 },
      [{ n: 1 }, { n: 2 }],
    );

    expect(sendUserMessage.mock.calls[0]?.[0]).not.toContain('"n": 1');
    expect(sendUserMessage.mock.calls[0]?.[0]).toContain('"n": 2');
  });
});

describe("brainstorm event watcher", () => {
  it("debounces appended browser events and auto-triggers the agent", async () => {
    const cwd = createTempDir("pi-kit-brainstorm-events-watch-");
    writeSettings(cwd, { debounceMs: 5 });

    const sessionDir = path.join(cwd, ".pi", "brainstorm", "session-1");
    fs.mkdirSync(sessionDir, { recursive: true });

    const harness = buildHarness();
    await emitSessionStart(harness, cwd);

    const eventsPath = path.join(sessionDir, ".events");
    fs.appendFileSync(eventsPath, `${JSON.stringify({ choice: "a" })}\n`);
    fs.appendFileSync(eventsPath, `${JSON.stringify({ choice: "b" })}\n`);

    await sleep(80);

    expect(harness.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(harness.sendUserMessage.mock.calls[0]?.[0]).toContain(
      '"choice": "a"',
    );
    expect(harness.sendUserMessage.mock.calls[0]?.[0]).toContain(
      '"choice": "b"',
    );

    await emitSessionShutdown(harness);
  });

  it("does not replay pre-existing event files on startup", async () => {
    const cwd = createTempDir("pi-kit-brainstorm-events-existing-");
    writeSettings(cwd, { debounceMs: 5 });

    const sessionDir = path.join(cwd, ".pi", "brainstorm", "session-1");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, ".events"),
      `${JSON.stringify({ choice: "old" })}\n`,
    );

    const harness = buildHarness();
    await emitSessionStart(harness, cwd);
    await sleep(20);

    expect(harness.sendUserMessage).not.toHaveBeenCalled();

    fs.appendFileSync(
      path.join(sessionDir, ".events"),
      `${JSON.stringify({ choice: "new" })}\n`,
    );
    await sleep(80);

    expect(harness.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(harness.sendUserMessage.mock.calls[0]?.[0]).toContain(
      '"choice": "new"',
    );
    expect(harness.sendUserMessage.mock.calls[0]?.[0]).not.toContain("old");

    await emitSessionShutdown(harness);
  });

  it("reads events that appear in newly discovered session directories", async () => {
    const cwd = createTempDir("pi-kit-brainstorm-events-new-dir-");
    writeSettings(cwd, { debounceMs: 5 });

    const harness = buildHarness();
    await emitSessionStart(harness, cwd);

    const sessionDir = path.join(cwd, ".pi", "brainstorm", "session-1");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, ".events"),
      `${JSON.stringify({ choice: "fast-click" })}\n`,
    );
    await sleep(120);

    expect(harness.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(harness.sendUserMessage.mock.calls[0]?.[0]).toContain(
      '"choice": "fast-click"',
    );

    await emitSessionShutdown(harness);
  });
});
