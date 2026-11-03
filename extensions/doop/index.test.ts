/* biome-ignore-all lint/suspicious/noExplicitAny: test harness boundary for the ExtensionAPI fake */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDoopExtension,
  doopCommentsOutputSchema,
  readConfig,
  statusLine,
  writeConfig,
} from "./index.js";

const tempDirs: string[] = [];

function tempConfigPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doop-ext-"));
  tempDirs.push(dir);
  return path.join(dir, "doop.json");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

const COMMENT = {
  id: "c1",
  text: "solid CTA",
  from: "rich",
  at: 1,
  frameId: "f1",
  elementId: "cta",
  html: "<button>Book</button>",
};

function mcpReply(payload: unknown): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function harness(options: { reply?: () => Response } = {}) {
  const tools: any[] = [];
  const commands = new Map<string, any>();
  const events = new Map<string, (...args: any[]) => unknown>();
  const sendUserMessage = vi.fn();
  const notify = vi.fn();
  const setStatus = vi.fn();
  const api = {
    registerTool: (definition: any) => tools.push(definition),
    registerCommand: (name: string, definition: any) =>
      commands.set(name, definition),
    on: (event: string, handler: (...args: any[]) => unknown) =>
      events.set(event, handler),
    sendUserMessage,
  } as unknown as ExtensionAPI;
  const ui = { notify, setStatus };
  const ctx = { ui, isIdle: () => true, cwd: process.cwd() };
  const fetchImpl = vi.fn<typeof fetch>(
    async () => options.reply?.() ?? mcpReply([COMMENT]),
  );
  return {
    api,
    ui,
    ctx,
    tools,
    commands,
    events,
    sendUserMessage,
    notify,
    fetchImpl,
  };
}

function writeKey(file: string, extra: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      baseUrl: "http://127.0.0.1:4300",
      agentKey: "dpk_test",
      ...extra,
    }),
  );
}

describe("config file", () => {
  it("round-trips a binding and keeps the credential private", () => {
    const file = tempConfigPath();
    writeConfig(file, {
      baseUrl: "http://127.0.0.1:4300",
      agentKey: "dpk_test",
      canvasId: "U43rjP-JxT",
      agentName: "pi",
    });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const loaded = readConfig(file, {});
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.config.canvasId).toBe("U43rjP-JxT");
    expect(loaded.config.agentName).toBe("pi");
  });

  it("converges an existing file's mode to 0600", () => {
    const file = tempConfigPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{}\n");
    fs.chmodSync(file, 0o644);
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
    writeConfig(file, {
      baseUrl: "http://127.0.0.1:4300",
      agentKey: "dpk_test",
      agentName: "pi",
    });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("falls back to the environment when there is no file", () => {
    const loaded = readConfig(path.join(tempConfigPath(), "missing.json"), {
      DOOP_AGENT_KEY: "dpk_env",
      DOOP_BASE_URL: "http://localhost:4400/",
    });
    expect(loaded).toMatchObject({ ok: true, source: "environment" });
    if (!loaded.ok) return;
    expect(loaded.config.agentKey).toBe("dpk_env");
    expect(loaded.config.baseUrl).toBe("http://localhost:4400");
  });

  it("explains a missing key instead of failing later with a 401", () => {
    const loaded = readConfig(path.join(tempConfigPath(), "missing.json"), {});
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.message).toContain("Settings -> Agent keys");
  });
});

describe("extension wiring", () => {
  it("registers one read tool and one command", () => {
    const h = harness();
    const file = tempConfigPath();
    writeKey(file, { canvasId: "U43rjP-JxT" });
    createDoopExtension({
      configPath: () => file,
      fetchImpl: h.fetchImpl,
    })(h.api);
    expect(h.tools.map((tool) => tool.name)).toEqual(["doop_comments"]);
    expect(h.tools[0].outputSchema).toBe(doopCommentsOutputSchema);
    expect([...h.commands.keys()]).toEqual(["doop"]);
    expect(h.events.has("session_start")).toBe(true);
  });

  it("puts the bound canvas in the footer at session start", () => {
    const h = harness();
    const file = tempConfigPath();
    writeKey(file, { canvasId: "U43rjP-JxT" });
    createDoopExtension({
      configPath: () => file,
      fetchImpl: h.fetchImpl,
    })(h.api);
    h.events.get("session_start")?.({}, h.ctx);
    expect(h.ui.setStatus).toHaveBeenCalledWith("doop", "doop U43rjP-JxT");
  });

  it("binds a canvas by writing the file", async () => {
    const h = harness();
    const file = tempConfigPath();
    writeKey(file);
    createDoopExtension({
      configPath: () => file,
      fetchImpl: h.fetchImpl,
    })(h.api);
    await h.commands.get("doop").handler("bind U43rjP-JxT", h.ctx);
    const loaded = readConfig(file, {});
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.config.canvasId).toBe("U43rjP-JxT");
    expect(h.notify).toHaveBeenCalledWith(
      "doop bound to canvas U43rjP-JxT",
      "info",
    );
  });

  it("unbinds with /doop off", async () => {
    const h = harness();
    const file = tempConfigPath();
    writeKey(file, { canvasId: "U43rjP-JxT" });
    createDoopExtension({
      configPath: () => file,
      fetchImpl: h.fetchImpl,
    })(h.api);
    await h.commands.get("doop").handler("off", h.ctx);
    const loaded = readConfig(file, {});
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.config.canvasId).toBeUndefined();
    expect(h.ui.setStatus).toHaveBeenCalledWith("doop", undefined);
  });

  it("refuses to review without a bound canvas", async () => {
    const h = harness();
    const file = tempConfigPath();
    writeKey(file);
    createDoopExtension({
      configPath: () => file,
      fetchImpl: h.fetchImpl,
    })(h.api);
    await h.commands.get("doop").handler("review", h.ctx);
    expect(h.notify).toHaveBeenCalledWith(
      "no canvas bound: run /doop bind <canvasId> first",
      "warning",
    );
    expect(h.sendUserMessage).not.toHaveBeenCalled();
  });

  it("hands the worklist to the agent on /doop review", async () => {
    const h = harness();
    const file = tempConfigPath();
    writeKey(file, { canvasId: "U43rjP-JxT" });
    createDoopExtension({
      configPath: () => file,
      fetchImpl: h.fetchImpl,
    })(h.api);
    await h.commands.get("doop").handler("review", h.ctx);
    expect(h.sendUserMessage).toHaveBeenCalledTimes(1);
    const message = String(h.sendUserMessage.mock.calls[0]?.[0]);
    expect(message).toContain("doop canvas U43rjP-JxT: 1 open comment");
    expect(message).toContain("comment c1");
    expect(h.ui.setStatus).toHaveBeenCalledWith(
      "doop",
      "doop U43rjP-JxT · 1 open",
    );
  });

  it("reports the bound canvas and its counts on /doop status", async () => {
    const h = harness();
    const file = tempConfigPath();
    writeKey(file, { canvasId: "U43rjP-JxT" });
    createDoopExtension({
      configPath: () => file,
      fetchImpl: h.fetchImpl,
    })(h.api);
    await h.commands.get("doop").handler("status", h.ctx);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledWith(
      "doop http://127.0.0.1:4300 · canvas U43rjP-JxT · 1 open · key ok",
      "info",
    );
    expect(h.ui.setStatus).toHaveBeenCalledWith(
      "doop",
      "doop U43rjP-JxT · 1 open",
    );
  });

  it("says the canvas is unbound on /doop status without counting", async () => {
    const h = harness();
    const file = tempConfigPath();
    writeKey(file);
    createDoopExtension({
      configPath: () => file,
      fetchImpl: h.fetchImpl,
    })(h.api);
    await h.commands.get("doop").handler("status", h.ctx);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledWith(
      "doop http://127.0.0.1:4300 · canvas unbound · key ok",
      "info",
    );
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });
});

describe("doop_comments tool", () => {
  it("returns the worklist as text and as structured content", async () => {
    const h = harness();
    const file = tempConfigPath();
    writeKey(file, { canvasId: "U43rjP-JxT" });
    createDoopExtension({
      configPath: () => file,
      fetchImpl: h.fetchImpl,
    })(h.api);
    const result = await h.tools[0].execute(
      "call-1",
      {},
      undefined,
      undefined,
      h.ctx,
    );
    expect(result.structuredContent).toMatchObject({
      canvasId: "U43rjP-JxT",
      skipped: 0,
    });
    expect(result.structuredContent.items).toHaveLength(1);
    expect(
      Value.Check(doopCommentsOutputSchema, result.structuredContent),
    ).toBe(true);
    expect(result.content[0].text).toContain("comment c1");
  });

  it("prefers an explicit canvas_id over the binding", async () => {
    const h = harness();
    const file = tempConfigPath();
    writeKey(file, { canvasId: "bound" });
    createDoopExtension({
      configPath: () => file,
      fetchImpl: h.fetchImpl,
    })(h.api);
    const result = await h.tools[0].execute(
      "call-1",
      { canvas_id: "explicit" },
      undefined,
      undefined,
      h.ctx,
    );
    expect(result.structuredContent.canvasId).toBe("explicit");
  });

  it("explains an unbound canvas instead of calling doop", async () => {
    const h = harness();
    const file = tempConfigPath();
    writeKey(file);
    createDoopExtension({
      configPath: () => file,
      fetchImpl: h.fetchImpl,
    })(h.api);
    const result = await h.tools[0].execute(
      "call-1",
      {},
      undefined,
      undefined,
      h.ctx,
    );
    expect(result.structuredContent.error).toContain("no canvas bound");
    expect(result.structuredContent.canvasId).toBeUndefined();
    expect(
      Value.Check(doopCommentsOutputSchema, result.structuredContent),
    ).toBe(true);
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces a doop failure with the next step", async () => {
    const h = harness({
      reply: () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              content: [
                { type: "text", text: "Error: no canvas with id nope" },
              ],
              isError: true,
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    });
    const file = tempConfigPath();
    writeKey(file, { canvasId: "nope" });
    createDoopExtension({
      configPath: () => file,
      fetchImpl: h.fetchImpl,
    })(h.api);
    const result = await h.tools[0].execute(
      "call-1",
      {},
      undefined,
      undefined,
      h.ctx,
    );
    expect(result.structuredContent.error).toBe("no canvas with id nope");
    expect(result.content[0].text).toBe("no canvas with id nope");
  });
});

describe("statusLine", () => {
  it("drops the line when nothing is bound", () => {
    expect(statusLine(undefined)).toBeUndefined();
  });

  it("shows counts only when a list was just fetched", () => {
    expect(statusLine("U43rjP-JxT")).toBe("doop U43rjP-JxT");
    expect(
      statusLine("U43rjP-JxT", {
        canvasId: "U43rjP-JxT",
        items: [],
        skipped: 2,
      }),
    ).toBe("doop U43rjP-JxT · 0 open · 2 skipped");
  });
});
