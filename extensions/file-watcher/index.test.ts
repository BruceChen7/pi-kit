import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { FILE_WATCHER_CONTROL_CHANNEL } from "../shared/internal-events.ts";
import fileWatcherExtension, {
  buildMarkerRegex,
  formatPromptMessage,
  isBinary,
  parseDelay,
  parsePrompts,
  parseWatchCommand,
  planDeferredPrompts,
  planFileChange,
} from "./index.ts";

const MARKER = "#pi!";

function parsedPrompt(text: string, lineNumber: number, delayMs = 0) {
  return { text, delayMs, lineNumber };
}

describe("file-watcher prompt parsing", () => {
  it.each([
    ["// refactor to async #pi!", [parsedPrompt("refactor to async", 1)]],
    ["# rename variable #pi!", [parsedPrompt("rename variable", 1)]],
    ["-- optimise query #pi!", [parsedPrompt("optimise query", 1)]],
    ["just a normal line", []],
    ["// do something #PI!", [parsedPrompt("do something", 1)]],
    [" *   // refactor this #pi!", []],
    [" * fix something #pi!", []],
  ])("parses immediate prompt from %s", (content, expected) => {
    expect(parsePrompts(content, MARKER)).toEqual(expected);
  });

  it("parses multiple prompt lines", () => {
    expect(parsePrompts("// fix this #pi!\n// also that #pi!", MARKER)).toEqual(
      [parsedPrompt("fix this", 1), parsedPrompt("also that", 2)],
    );
  });

  it("preserves source line numbers across skipped lines", () => {
    expect(
      parsePrompts(
        "const a = 1;\n\n// update this #pi!\n * ignored #pi!",
        MARKER,
      ),
    ).toEqual([parsedPrompt("update this", 3)]);
  });

  it.each([
    ["// refactor #pi! @5m", parsedPrompt("refactor", 1, 5 * 60_000)],
    ["// review #pi! @2h", parsedPrompt("review", 1, 2 * 3_600_000)],
    ["// quick fix #pi! @30s", parsedPrompt("quick fix", 1, 30_000)],
    ["// refactor #pi! @1h30m", parsedPrompt("refactor", 1, 5_400_000)],
    ["// fix #pi! @badspec", parsedPrompt("fix", 1)],
  ])("parses deferred prompt from %s", (content, expected) => {
    expect(parsePrompts(content, MARKER)).toEqual([expected]);
  });

  it("escapes custom marker text when building marker regex", () => {
    expect("// do it #go?".match(buildMarkerRegex("#go?"))?.[1]).toBe("do it");
    expect(parsePrompts("// do it #go?", "#go?")).toEqual([
      parsedPrompt("do it", 1),
    ]);
  });
});

describe("file-watcher delay parsing", () => {
  it.each([
    ["5m", 5 * 60_000],
    ["2h", 2 * 3_600_000],
    ["30s", 30_000],
    ["1h30m", 5_400_000],
    ["0m", 0],
  ])("parses relative delay %s", (spec, expected) => {
    expect(parseDelay(spec)).toBe(expected);
  });

  it.each([
    "badspec",
    "",
    "25:00",
    "12:60",
  ])("rejects invalid delay %s", (spec) => {
    expect(parseDelay(spec)).toBeNull();
  });

  it("parses absolute time later today", () => {
    const now = new Date("2026-05-21T08:00:00").getTime();
    expect(parseDelay("09:30", () => now)).toBe(90 * 60_000);
  });

  it("parses absolute time tomorrow when target has already passed", () => {
    const now = new Date("2026-05-21T10:00:00").getTime();
    expect(parseDelay("09:30", () => now)).toBe((23 * 60 + 30) * 60_000);
  });
});

describe("file-watcher core planning", () => {
  it("plans immediate and deferred prompts from file content", () => {
    expect(planFileChange("// now #pi!\n// later #pi! @5m", MARKER)).toEqual({
      immediate: [parsedPrompt("now", 1)],
      deferred: [parsedPrompt("later", 2, 5 * 60_000)],
    });
  });

  it("plans deferred prompts to fire together at the longest delay", () => {
    expect(
      planDeferredPrompts(
        [parsedPrompt("soon", 2, 30_000), parsedPrompt("later", 8, 5 * 60_000)],
        1_000,
      ),
    ).toEqual({
      prompts: [
        parsedPrompt("soon", 2, 30_000),
        parsedPrompt("later", 8, 5 * 60_000),
      ],
      delayMs: 5 * 60_000,
      fireAt: 301_000,
    });
  });
});

describe("file-watcher prompt message formatting", () => {
  it("includes the file path and each prompt source line", () => {
    expect(
      formatPromptMessage(
        [
          parsedPrompt("first instruction", 12),
          parsedPrompt("second instruction", 48),
        ],
        "/repo/src/file.ts",
        MARKER,
      ),
    ).toBe(
      "File: /repo/src/file.ts\n\n" +
        "Line 12: first instruction\n" +
        "Line 48: second instruction\n\n" +
        "After completing the above, remove the `#pi!` comment(s) from the file.",
    );
  });
});

describe("file-watcher command parsing", () => {
  it.each([
    [undefined, { kind: "help" }],
    ["", { kind: "help" }],
    ["start", { kind: "start", path: "." }],
    ["start ./src", { kind: "start", path: "./src" }],
    ["stop", { kind: "stop", path: undefined }],
    ["stop ./src", { kind: "stop", path: "./src" }],
    ["status", { kind: "status" }],
    ["cancel", { kind: "cancel", path: undefined }],
    ["cancel file.ts", { kind: "cancel", path: "file.ts" }],
    ["marker", { kind: "marker", marker: undefined }],
    ["marker #go!", { kind: "marker", marker: "#go!" }],
    ["wat", { kind: "help" }],
  ])("parses %j", (args, expected) => {
    expect(parseWatchCommand(args)).toEqual(expected);
  });
});

describe("file-watcher control events", () => {
  it("starts and stops watching from the internal control channel", () => {
    const handlers = new Map<string, (event: unknown) => void>();
    const notify = vi.fn();
    const repoRoot = mkdtempSync(join(tmpdir(), "pi-kit-file-watcher-"));

    fileWatcherExtension({
      events: {
        on(channel: string, handler: (event: unknown) => void) {
          handlers.set(channel, handler);
        },
      },
      getFlag: () => undefined,
      on: vi.fn(),
      registerCommand: vi.fn(),
      registerFlag: vi.fn(),
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI);

    const handler = handlers.get(FILE_WATCHER_CONTROL_CHANNEL);
    expect(handler).toBeTypeOf("function");

    const ctx = {
      cwd: repoRoot,
      hasUI: true,
      ui: { notify },
      isIdle: () => true,
    };
    const emitControl = (
      type: "file-watcher.start" | "file-watcher.stop",
      createdAt: number,
    ) => {
      handler?.({
        type,
        requestId: `test-${type}`,
        createdAt,
        path: repoRoot,
        source: "test",
        ctx,
      });
    };

    emitControl("file-watcher.start", 1);
    emitControl("file-watcher.stop", 2);

    const infoNotifications = notify.mock.calls.map(([message]) => message);
    const startNotification = infoNotifications.find((message) =>
      String(message).startsWith(`Watching ${repoRoot}`),
    );
    const stopNotification = infoNotifications.find((message) =>
      String(message).startsWith(`Stopped watching ${repoRoot}`),
    );

    expect(startNotification).toEqual(
      expect.stringContaining("(source: test)"),
    );
    expect(stopNotification).toEqual(expect.stringContaining("(source: test)"));
  });
});

describe("file-watcher binary detection", () => {
  it("detects null bytes in first 512 bytes", () => {
    expect(isBinary(Buffer.from([72, 101, 108, 0, 111]))).toBe(true);
    expect(isBinary(Buffer.from("hello world"))).toBe(false);
  });
});
