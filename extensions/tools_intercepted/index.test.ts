import { readdirSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import extension from "./index.js";

const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
});

type EventHandlers = Record<string, Array<(...args: unknown[]) => unknown>>;

function createFakeApi(): {
  api: ExtensionAPI;
  handlers: EventHandlers;
} {
  const handlers: EventHandlers = {};

  const api = {
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const list = handlers[event] ?? [];
      list.push(handler);
      handlers[event] = list;
    },
    registerTool() {
      // no-op
    },
  } as unknown as ExtensionAPI;

  return { api, handlers };
}

function trigger(handlers: EventHandlers, event: string, payload: object) {
  const callbacks = handlers[event];
  if (!callbacks || callbacks.length === 0) {
    throw new Error(`No handler registered for ${event}`);
  }
  return (callbacks[callbacks.length - 1] as (e: object) => unknown)(payload);
}

function shimDir(): string {
  return path.resolve(
    process.cwd(),
    "extensions/tools_intercepted/intercepted-commands",
  );
}

describe("tools_intercepted extension", () => {
  it("prepends the intercepted-commands directory to PATH on load", () => {
    process.env.PATH = "/usr/bin:/bin";
    const { api } = createFakeApi();

    extension(api);

    expect(process.env.PATH?.split(path.delimiter)[0]).toBe(shimDir());
    expect(process.env.PATH).toContain("/usr/bin:/bin");
  });

  it("re-applies the shim path on session_start without duplicating it", () => {
    process.env.PATH = "/usr/bin:/bin";
    const { api, handlers } = createFakeApi();

    extension(api);
    trigger(handlers, "session_start", {
      type: "session_start",
      reason: "reload",
    });

    const entries = (process.env.PATH ?? "").split(path.delimiter);
    expect(entries.filter((entry) => entry === shimDir())).toHaveLength(1);
  });

  it("registers no tools: search comes from the built-in grep/find", () => {
    const registered: string[] = [];
    extension({
      on() {
        // no-op
      },
      registerTool(tool: { name: string }) {
        registered.push(tool.name);
      },
    } as unknown as ExtensionAPI);

    expect(registered).toEqual([]);
  });

  it("registers only the session_start lifecycle hook", () => {
    const events: string[] = [];
    extension({
      on(event: string) {
        events.push(event);
      },
      registerTool() {
        // no-op
      },
    } as unknown as ExtensionAPI);

    expect(events).toEqual(["session_start"]);
  });
});

/**
 * Regression guard for the removed grep->rg / find->fd PATH shims.
 *
 * A shim that keeps a command's name but changes its semantics silently broke
 * bash usage: BRE patterns (`it("`, `\|` alternation) failed or matched
 * nothing under rg, and rg also skipped .gitignore'd paths that grep finds.
 * 178 logged `grep` invocations failed that way, 138 of them reaching the
 * model as non-error output. bash grep/find must resolve to the system
 * implementations.
 */
describe("intercepted-commands PATH shims", () => {
  /** Pure: directory entry names -> the disguised same-name commands. */
  const disguisedShims = (entries: string[]): string[] =>
    entries.filter((name) => name === "grep" || name === "find");

  it("ships no grep/find shim (they are not proxies, they are impostors)", () => {
    const entries = readdirSync(shimDir());

    expect(disguisedShims(entries)).toEqual([]);
  });

  it("still ships the python-family shims (block/redirect contract)", () => {
    const entries = readdirSync(shimDir());

    for (const name of ["pip", "pip3", "poetry", "python", "python3"]) {
      expect(entries).toContain(name);
    }
  });
});
