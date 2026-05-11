import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import codexPlanLimitsExtension from "./index.js";

const STALE_MESSAGE =
  "This extension instance is stale after session replacement or reload. Use the provided replacement-session context instead.";

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;

const buildPiHarness = () => {
  const handlers = new Map<string, Handler[]>();
  const api = {
    on: (event: string, handler: Handler) => {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
    getThinkingLevel: () => "medium",
  };

  const emit = async (event: string, ctx: unknown) => {
    for (const handler of handlers.get(event) ?? []) {
      await handler({}, ctx);
    }
  };

  return { api, emit };
};

const buildCtx = (overrides?: Record<string, unknown>) => {
  const ui = {
    setStatus: vi.fn(),
    setWidget: vi.fn(),
    setFooter: vi.fn(),
    notify: vi.fn(),
    theme: {
      fg: vi.fn(
        (color: string, text: string) => `<${color}>${text}</${color}>`,
      ),
    },
  };

  return {
    hasUI: true,
    cwd: "/repo",
    model: {
      provider: "openai-codex",
      id: "codex-pro",
      reasoning: false,
    },
    modelRegistry: {
      isUsingOAuth: vi.fn(() => true),
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true })),
      authStorage: {
        get: vi.fn(() => ({ access: "token", accountId: "acct" })),
      },
    },
    sessionManager: {
      getSessionName: vi.fn(() => undefined),
    },
    ui,
    ...overrides,
  };
};

const usageResponse = {
  plan_type: "plus",
  rate_limit: {
    primary_window: {
      used_percent: 40,
      limit_window_seconds: 18_000,
      reset_at: Math.floor(Date.now() / 1000) + 600,
    },
    secondary_window: {
      used_percent: 20,
      limit_window_seconds: 604_800,
      reset_at: Math.floor(Date.now() / 1000) + 86_400,
    },
  },
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  }
});

describe("codex-plan-limits extension", () => {
  it("updates a dim widget line and does not override footer/status", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(usageResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as typeof fetch;

    const { api, emit } = buildPiHarness();
    const ctx = buildCtx();

    codexPlanLimitsExtension(api as ExtensionAPI);

    await emit("session_start", ctx);

    await vi.waitFor(() => {
      expect(ctx.ui.theme.fg).toHaveBeenCalledWith(
        "dim",
        expect.stringContaining("5h"),
      );
      expect(ctx.ui.theme.fg).toHaveBeenCalledWith(
        "dim",
        expect.stringContaining("Weekly"),
      );
      expect(ctx.ui.setWidget).toHaveBeenCalledWith(
        "codex-plan-limits",
        [expect.stringContaining("<dim>")],
        { placement: "belowEditor" },
      );
    });
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    expect(ctx.ui.setFooter).not.toHaveBeenCalled();

    await emit("session_shutdown", ctx);
    expect(ctx.ui.setWidget).toHaveBeenLastCalledWith(
      "codex-plan-limits",
      undefined,
    );
  });

  it("does not block session_start while refresh runs in background", async () => {
    globalThis.fetch = vi.fn(
      () => new Promise<Response>(() => {}),
    ) as typeof fetch;

    const { api, emit } = buildPiHarness();
    const ctx = buildCtx();

    codexPlanLimitsExtension(api as ExtensionAPI);

    const startupResult = await Promise.race([
      emit("session_start", ctx).then(() => "resolved"),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("timeout"), 50);
      }),
    ]);

    expect(startupResult).toBe("resolved");
    expect(ctx.ui.setWidget).toHaveBeenCalledWith(
      "codex-plan-limits",
      [expect.stringContaining("Codex limits loading")],
      { placement: "belowEditor" },
    );

    await emit("session_shutdown", ctx);
  });

  it("does not touch stale UI when an in-flight refresh completes after shutdown", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    globalThis.fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    ) as typeof fetch;

    const { api, emit } = buildPiHarness();
    const ctx = buildCtx();
    let stale = false;

    ctx.ui.theme.fg = vi.fn((color: string, text: string) => {
      if (stale) {
        throw new Error(STALE_MESSAGE);
      }
      return `<${color}>${text}</${color}>`;
    });
    ctx.ui.setWidget = vi.fn(() => {
      if (stale) {
        throw new Error(STALE_MESSAGE);
      }
    });
    ctx.ui.notify = vi.fn(() => {
      if (stale) {
        throw new Error(STALE_MESSAGE);
      }
    });

    codexPlanLimitsExtension(api as ExtensionAPI);

    await emit("session_start", ctx);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    await emit("session_shutdown", ctx);

    const widgetCallsBeforeResolve = ctx.ui.setWidget.mock.calls.length;
    stale = true;
    resolveFetch?.(
      new Response(JSON.stringify(usageResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(ctx.ui.setWidget).toHaveBeenCalledTimes(widgetCallsBeforeResolve);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("clears widget when model is not eligible", async () => {
    const { api, emit } = buildPiHarness();
    const ctx = buildCtx({
      model: {
        provider: "openai",
        id: "gpt-5",
      },
    });

    codexPlanLimitsExtension(api as ExtensionAPI);

    await emit("session_start", ctx);

    expect(ctx.ui.setWidget).toHaveBeenCalledWith(
      "codex-plan-limits",
      undefined,
    );
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    expect(ctx.ui.setFooter).not.toHaveBeenCalled();
  });
});
