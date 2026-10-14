import type { Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { customPanel, hasRichUi, themeFor, uiHostProfile } from "./rich-ui.js";
import { PI_WEB_HOST_SYMBOL, resolveUiHostProfile } from "./ui-host.js";

const PLAIN_THEME = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const markPiWeb = (): void => {
  (globalThis as Record<PropertyKey, unknown>)[PI_WEB_HOST_SYMBOL] = {
    version: 1,
  };
};

afterEach(() => {
  delete (globalThis as Record<PropertyKey, unknown>)[PI_WEB_HOST_SYMBOL];
  process.env.PI_KIT_UI_HOST = undefined;
});

describe("hasRichUi", () => {
  it("answers yes for the terminal UI", () => {
    expect(hasRichUi({ hasUI: true, mode: "tui" })).toBe(true);
  });

  it("answers yes for pi-web, which really renders custom panels", () => {
    // 这曾经是 rpc ⇒ false 的一刀切：pi-web 同样报 mode:"rpc"，但它的 custom()
    // 会画面板并回传 done() 的值，所以不能再一概拒绝。
    markPiWeb();
    expect(hasRichUi({ hasUI: true, mode: "rpc" })).toBe(true);
  });

  it("answers no for the generic RPC transport, where custom() resolves to undefined", () => {
    // The trap this helper exists for: hasUI is true there, and a
    // `typeof ctx.ui.custom !== "function"` guard would pass.
    expect(hasRichUi({ hasUI: true, mode: "rpc" })).toBe(false);
  });

  it("answers no for headless modes", () => {
    expect(hasRichUi({ hasUI: false, mode: "json" })).toBe(false);
    expect(hasRichUi({ hasUI: true, mode: "print" })).toBe(false);
    expect(hasRichUi({ hasUI: false })).toBe(false);
  });

  it("assumes the terminal when the capability fields are absent", () => {
    // Embedders and tests drive extensions directly and omit both fields;
    // their previous behaviour was to attempt custom().
    expect(hasRichUi({ hasUI: true })).toBe(true);
    expect(hasRichUi({})).toBe(true);
  });
});

describe("uiHostProfile", () => {
  it("memoises per context object", () => {
    const ctx = { hasUI: true, mode: "tui" };
    expect(uiHostProfile(ctx)).toBe(uiHostProfile(ctx));
    expect(uiHostProfile(ctx)).toBe(resolveUiHostProfile({ mode: "tui" }));
  });

  it("lets PI_KIT_UI_HOST override the host", () => {
    process.env.PI_KIT_UI_HOST = "pi-web";
    expect(uiHostProfile({ hasUI: true, mode: "tui" }).kind).toBe("pi-web");
  });
});

describe("themeFor", () => {
  it("passes the host theme through when it has colours", () => {
    const profile = resolveUiHostProfile({ mode: "tui" });
    expect(themeFor(profile, PLAIN_THEME)).toBe(PLAIN_THEME);
  });

  it("paints ANSI when the host theme is colourless (pi-web)", () => {
    const profile = resolveUiHostProfile({
      mode: "rpc",
      piWebMarker: { version: 1 },
    });
    const theme = themeFor(profile, PLAIN_THEME);
    expect(theme).not.toBe(PLAIN_THEME);
    expect(theme.fg("accent", "hi")).toContain("\x1b[36m");
    expect(theme.bold("hi")).toContain("\x1b[1m");
    // 未映射的 token 保持原文，不炸。
    expect(theme.fg("thinkingText", "hi")).toBe("hi");
  });
});

describe("customPanel", () => {
  const makeCtx = (mode: string) => {
    const seen: {
      theme?: Theme;
      options?: unknown;
    } = {};
    const ctx = {
      hasUI: true,
      mode,
      ui: {
        custom: async (
          factory: (
            tui: unknown,
            theme: Theme,
            keybindings: unknown,
            done: (value: string) => void,
          ) => unknown,
          options?: unknown,
        ): Promise<string> => {
          seen.options = options;
          await factory(
            {
              terminal: { columns: 92, rows: 40, kittyProtocolActive: false },
              requestRender: () => {},
            } as never,
            PLAIN_THEME,
            {} as never,
            () => {},
          );
          // pi-web 的 custom() 解析成 done() 的值。
          return "picked";
        },
      },
    };
    return { ctx, seen };
  };

  it("hands the panel a borderless, coloured host on pi-web", async () => {
    markPiWeb();
    const { ctx, seen } = makeCtx("rpc");
    let host: unknown;
    const result = await customPanel(
      ctx as never,
      (_tui, theme, _kb, done, panelHost) => {
        seen.theme = theme;
        host = panelHost;
        done("picked");
        return { render: () => [], invalidate: () => {} };
      },
      { overlay: true },
    );
    expect(result).toBe("picked");
    expect(seen.options).toEqual({ overlay: true });
    expect(seen.theme).not.toBe(PLAIN_THEME);
    expect(seen.theme?.fg("accent", "x")).toContain("\x1b[36m");
    expect(host).toEqual({
      chrome: "borderless",
      width: 92,
      rows: 40,
      wantsFocusMarker: false,
    });
  });

  it("keeps the terminal theme and boxed chrome on the TUI", async () => {
    const { ctx, seen } = makeCtx("tui");
    let host: unknown;
    await customPanel(ctx as never, (_tui, theme, _kb, done, panelHost) => {
      seen.theme = theme;
      host = panelHost;
      done("picked");
      return { render: () => [], invalidate: () => {} };
    });
    expect(seen.theme).toBe(PLAIN_THEME);
    expect(host).toEqual({
      chrome: "boxed",
      width: "dynamic",
      rows: undefined,
      wantsFocusMarker: true,
    });
  });
});
