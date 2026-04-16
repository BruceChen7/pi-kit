import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import codexPlanLimitsExtension from "./index.js";

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
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    expect(ctx.ui.setFooter).not.toHaveBeenCalled();

    await emit("session_shutdown", ctx);
    expect(ctx.ui.setWidget).toHaveBeenLastCalledWith(
      "codex-plan-limits",
      undefined,
    );
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
