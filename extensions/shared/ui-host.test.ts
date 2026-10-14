import { describe, expect, it } from "vitest";
import {
  PI_WEB_HOST_SYMBOL,
  parseUiHostOverride,
  profileForHostKind,
  resolveUiHostProfile,
} from "./ui-host.js";

describe("resolveUiHostProfile", () => {
  it("gives the terminal every capability", () => {
    const profile = resolveUiHostProfile({ mode: "tui", hasUI: true });
    expect(profile.kind).toBe("tui");
    expect(profile.customPanels).toBe(true);
    expect(profile.widgets).toEqual({
      lines: true,
      factory: true,
      placements: "both",
    });
    expect(profile.panelChrome).toBe("boxed");
    expect(profile.panelWidth).toBe("dynamic");
    expect(profile.terminal).toBe("dynamic");
    expect(profile.themeColors).toBe(true);
    expect(profile.editorText).toEqual({ read: true, write: true });
    expect(profile.editorComponent).toBe(true);
    expect(profile.autocomplete).toBe(true);
    expect(profile.footerHeader).toBe(true);
    expect(profile.terminalSuspend).toBe(true);
    expect(profile.setsFocused).toBe(true);
    expect(profile.callsInvalidate).toBe(true);
    expect(profile.panelNormalizesFrame).toBe(false);
  });

  it("treats a mode-less context as the terminal (legacy convention)", () => {
    expect(resolveUiHostProfile({ hasUI: true }).kind).toBe("tui");
    expect(resolveUiHostProfile({}).kind).toBe("tui");
    expect(resolveUiHostProfile({ mode: "unknown-host" }).kind).toBe("tui");
  });

  it("recognises pi-web over rpc and keeps its real capabilities", () => {
    const profile = resolveUiHostProfile({
      mode: "rpc",
      hasUI: true,
      piWebMarker: { version: 1 },
    });
    expect(profile.kind).toBe("pi-web");
    // 真的能画面板：这是本档案存在的理由。
    expect(profile.customPanels).toBe(true);
    expect(profile.widgets).toEqual({
      lines: true,
      factory: true,
      placements: "both",
    });
    expect(profile.dialogs).toBe(true);
    // 但它的面板会自己去框、且从不 invalidate / 从不设 focused。
    expect(profile.panelChrome).toBe("borderless");
    expect(profile.panelWidth).toBe(92);
    expect(profile.terminal).toEqual({ columns: 92, rows: 40 });
    expect(profile.panelNormalizesFrame).toBe(true);
    expect(profile.callsInvalidate).toBe(false);
    expect(profile.setsFocused).toBe(false);
    // 主题是无色的 PLAIN_TEXT_THEME。
    expect(profile.themeColors).toBe(false);
    // 终端独占能力一概没有。
    expect(profile.editorText).toEqual({ read: false, write: true });
    expect(profile.editorComponent).toBe(false);
    expect(profile.autocomplete).toBe(false);
    expect(profile.footerHeader).toBe(false);
    expect(profile.terminalSuspend).toBe(false);
  });

  it("refuses to trust a pi-web marker of an unknown version", () => {
    expect(
      resolveUiHostProfile({ mode: "rpc", piWebMarker: { version: 2 } }).kind,
    ).toBe("generic-rpc");
    expect(resolveUiHostProfile({ mode: "rpc", piWebMarker: {} }).kind).toBe(
      "generic-rpc",
    );
  });

  it("keeps the old protection against generic rpc hosts", () => {
    // hasUI 为真、custom() 存在，但不问宿主就 resolve undefined（Waku 陷阱）。
    const profile = resolveUiHostProfile({ mode: "rpc", hasUI: true });
    expect(profile.kind).toBe("generic-rpc");
    expect(profile.customPanels).toBe(false);
    expect(profile.dialogs).toBe(true);
    expect(profile.widgets.factory).toBe(false);
    // “需要宿主拥有输入框/终端”的能力一概按没有处理，与旧的 hasRichUi=false 一致。
    expect(profile.editorText).toEqual({ read: false, write: true });
    expect(profile.editorComponent).toBe(false);
    expect(profile.autocomplete).toBe(false);
    expect(profile.footerHeader).toBe(false);
    expect(profile.terminalSuspend).toBe(false);
  });

  it("gives headless modes nothing to draw with", () => {
    for (const mode of ["json", "print"] as const) {
      const profile = resolveUiHostProfile({ mode, hasUI: true });
      expect(profile.kind).toBe("headless");
      expect(profile.customPanels).toBe(false);
      expect(profile.dialogs).toBe(false);
      expect(profile.widgets.placements).toBe("none");
    }
    const noUi = resolveUiHostProfile({ hasUI: false });
    expect(noUi.kind).toBe("headless");
    expect(noUi.customPanels).toBe(false);
    expect(noUi.dialogs).toBe(false);
  });

  it("lets PI_KIT_UI_HOST override everything", () => {
    const profile = resolveUiHostProfile({
      mode: "tui",
      hasUI: true,
      envOverride: "pi-web",
    });
    expect(profile.kind).toBe("pi-web");
    expect(
      resolveUiHostProfile({ mode: "rpc", envOverride: " tui " }).kind,
    ).toBe("tui");
    expect(
      resolveUiHostProfile({ mode: "tui", envOverride: "headless" }).kind,
    ).toBe("headless");
  });

  it("ignores an unparseable override", () => {
    expect(parseUiHostOverride("nonsense")).toBeUndefined();
    expect(
      resolveUiHostProfile({ mode: "rpc", envOverride: "nonsense" }).kind,
    ).toBe("generic-rpc");
  });

  it("hands out shared read-only profiles", () => {
    expect(profileForHostKind("pi-web")).toBe(profileForHostKind("pi-web"));
    expect(profileForHostKind("tui")).toBe(
      resolveUiHostProfile({ mode: "tui" }),
    );
  });

  it("exposes the documented pi-web symbol", () => {
    expect(PI_WEB_HOST_SYMBOL).toBe(
      Symbol.for("@agegr/pi-web/session-liveness/v1"),
    );
  });
});
