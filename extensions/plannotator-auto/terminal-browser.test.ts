import { describe, expect, it } from "vitest";
import { profileForHostKind } from "../shared/ui-host.ts";
import {
  deliverReviewToHost,
  deliversReviewToClient,
  extractFirstUrlFromReadyContent,
  hasRightNeighborFromEdgesOutput,
  isExplicitLocalSession,
  isHerdrEnvironment,
  isRichUiClientHost,
  nextHostMode,
  parseReadyFileLine,
  pickCloseTarget,
  resolveReviewHost,
  shouldCloseReviewPanel,
  wantsRemoteReviewUrl,
} from "./terminal-browser.ts";

describe("terminal-browser Functional Core", () => {
  it("isHerdrEnvironment true when both HERDR_ENV and HERDR_PANE_ID set", () => {
    expect(
      isHerdrEnvironment({
        HERDR_ENV: "1",
        HERDR_PANE_ID: "w1:p1",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(isHerdrEnvironment({ HERDR_ENV: "1" } as NodeJS.ProcessEnv)).toBe(
      false,
    );
    expect(
      isHerdrEnvironment({
        HERDR_ENV: "0",
        HERDR_PANE_ID: "w1:p1",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(isHerdrEnvironment({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("parseReadyFileLine extracts url", () => {
    expect(parseReadyFileLine('{"url":"http://127.0.0.1:1234"}')).toBe(
      "http://127.0.0.1:1234",
    );
    expect(parseReadyFileLine('  {"url":"http://127.0.0.1:1234"}  ')).toBe(
      "http://127.0.0.1:1234",
    );
    expect(parseReadyFileLine('{"url":""}')).toBe(null);
    expect(parseReadyFileLine("not json")).toBe(null);
    expect(parseReadyFileLine("")).toBe(null);
  });

  it("extractFirstUrlFromReadyContent takes first url", () => {
    const content = '{"url":"http://a"}\n{"url":"http://b"}\n';
    expect(extractFirstUrlFromReadyContent(content)).toBe("http://a");
    expect(extractFirstUrlFromReadyContent('invalid\n{"url":"http://c"}')).toBe(
      "http://c",
    );
    expect(extractFirstUrlFromReadyContent("")).toBe(null);
  });

  it("hasRightNeighborFromEdgesOutput parses herdr pane edges", () => {
    // right === false → a pane exists to the right of the probed pane.
    expect(
      hasRightNeighborFromEdgesOutput('{"result":{"edges":{"right":false}}}'),
    ).toBe(true);
    // right === true → probed pane is rightmost (no right neighbor).
    expect(
      hasRightNeighborFromEdgesOutput('{"result":{"edges":{"right":true}}}'),
    ).toBe(false);
    expect(hasRightNeighborFromEdgesOutput("not json")).toBe(null);
    expect(hasRightNeighborFromEdgesOutput('{"result":{}}')).toBe(null);
  });

  it("shouldCloseReviewPanel closes on any terminal verdict", () => {
    // denied（带 feedback）与 dismissed 同样是终局判定，必须关闭面板；
    // 错误/中断不是终局（面板留给重试），不会进入该判定。
    expect(shouldCloseReviewPanel({ approved: true })).toBe(true);
    expect(shouldCloseReviewPanel({ approved: false, feedback: "x" })).toBe(
      true,
    );
    expect(shouldCloseReviewPanel({ dismissed: true })).toBe(true);
    expect(shouldCloseReviewPanel({})).toBe(false);
  });

  it("pickCloseTarget picks pane / active-tab / nothing", () => {
    // Nothing tracked → do nothing (never close other sessions' panes).
    expect(pickCloseTarget(undefined)).toBe(null);
    // Split with a tracked pane id → precise pane close.
    expect(pickCloseTarget({ strategy: "split", paneId: "w1:p2" })).toEqual({
      kind: "pane",
      paneId: "w1:p2",
    });
    // Split but pane id unknown → fall back to closing the active tab.
    expect(pickCloseTarget({ strategy: "split" })).toEqual({
      kind: "active-tab",
    });
    // New-tab open → close the active tab.
    expect(pickCloseTarget({ strategy: "new-tab" })).toEqual({
      kind: "active-tab",
    });
  });

  it("resolveReviewHost only arms the panel for herdr-panel in a supported runtime", () => {
    // Default browser host: never the panel, regardless of env/availability.
    expect(
      resolveReviewHost({
        mode: "browser",
        isHerdrEnv: true,
        terminalBrowserAvailable: true,
      }),
    ).toBe(false);
    // Opted into herdr-panel with a real Herdr env + terminal-browser → panel.
    expect(
      resolveReviewHost({
        mode: "herdr-panel",
        isHerdrEnv: true,
        terminalBrowserAvailable: true,
      }),
    ).toBe(true);
    // herdr-panel requested but not a Herdr environment → browser.
    expect(
      resolveReviewHost({
        mode: "herdr-panel",
        isHerdrEnv: false,
        terminalBrowserAvailable: true,
      }),
    ).toBe(false);
    // herdr-panel requested but terminal-browser unavailable → browser.
    expect(
      resolveReviewHost({
        mode: "herdr-panel",
        isHerdrEnv: true,
        terminalBrowserAvailable: false,
      }),
    ).toBe(false);
  });

  it("nextHostMode toggles to herdr only when the runtime supports it", () => {
    const herdrEnv = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" };
    // browser → herdr-panel when Herdr env + terminal-browser available.
    expect(nextHostMode("browser", herdrEnv, true)).toEqual({
      next: "herdr-panel",
      ok: true,
    });
    // browser → herdr-panel requested but no Herdr env → stay browser.
    expect(nextHostMode("browser", {}, true)).toEqual({
      next: "browser",
      ok: false,
    });
    // browser → herdr-panel requested but no terminal-browser → stay browser.
    expect(nextHostMode("browser", herdrEnv, false)).toEqual({
      next: "browser",
      ok: false,
    });
    // herdr-panel → browser is always allowed, even if the runtime degraded.
    expect(nextHostMode("herdr-panel", {}, false)).toEqual({
      next: "browser",
      ok: true,
    });
  });
});

describe("wantsRemoteReviewUrl", () => {
  const env = (pairs: Record<string, string>): NodeJS.ProcessEnv =>
    pairs as NodeJS.ProcessEnv;

  it("is true when the CLI is told to run remote", () => {
    expect(wantsRemoteReviewUrl(env({ PLANNOTATOR_REMOTE: "1" }))).toBe(true);
    expect(wantsRemoteReviewUrl(env({ PLANNOTATOR_REMOTE: "TRUE" }))).toBe(
      true,
    );
  });

  it("is true when an advertised host can reach this machine", () => {
    expect(
      wantsRemoteReviewUrl(env({ PLANNOTATOR_URL_HOST: "mini.local" })),
    ).toBe(true);
    expect(wantsRemoteReviewUrl(env({ PLANNOTATOR_URL_HOST: "auto" }))).toBe(
      true,
    );
    expect(
      wantsRemoteReviewUrl(
        env({ PLANNOTATOR_PUBLIC_URL: "https://plans.example.com" }),
      ),
    ).toBe(true);
  });

  it("is false on an ordinary desktop session", () => {
    expect(wantsRemoteReviewUrl(env({}))).toBe(false);
    expect(wantsRemoteReviewUrl(env({ PLANNOTATOR_REMOTE: "0" }))).toBe(false);
    expect(wantsRemoteReviewUrl(env({ PLANNOTATOR_URL_HOST: "  " }))).toBe(
      false,
    );
  });
});

describe("isRichUiClientHost", () => {
  const env = (pairs: Record<string, string>): NodeJS.ProcessEnv =>
    pairs as NodeJS.ProcessEnv;

  it("is true for the hosts that draw their own surfaces", () => {
    // The pi desktop app / phone host the worker sets today.
    expect(isRichUiClientHost(env({ PI_KIT_UI_HOST: "android" }))).toBe(true);
    expect(isRichUiClientHost(env({ PI_KIT_UI_HOST: "pi-web" }))).toBe(true);
    expect(isRichUiClientHost(env({ PI_KIT_UI_HOST: "  PIWEB  " }))).toBe(true);
  });

  it("is false for the terminal and for non-hosts", () => {
    // A terminal pi is usually nested inside Herdr — a pane split is the
    // right home for the review there, not a client hand-off.
    expect(isRichUiClientHost(env({ PI_KIT_UI_HOST: "tui" }))).toBe(false);
    expect(isRichUiClientHost(env({ PI_KIT_UI_HOST: "rpc" }))).toBe(false);
    expect(isRichUiClientHost(env({ PI_KIT_UI_HOST: "headless" }))).toBe(false);
    expect(isRichUiClientHost(env({ PI_KIT_UI_HOST: "nonsense" }))).toBe(false);
    expect(isRichUiClientHost(env({}))).toBe(false);
  });

  it("derives the classification from the shared host table", () => {
    // Not a hardcoded kind list: every kind the shared table marks as
    // panel-drawing is a rich host, minus the named `tui` exception. If the
    // table grows a rich kind, this predicate must follow it.
    for (const kind of ["pi-web", "android"] as const) {
      expect(isRichUiClientHost(env({ PI_KIT_UI_HOST: kind }))).toBe(
        profileForHostKind(kind).customPanels,
      );
    }
  });
});

describe("isExplicitLocalSession", () => {
  const env = (pairs: Record<string, string>): NodeJS.ProcessEnv =>
    pairs as NodeJS.ProcessEnv;

  it("recognizes the deployment's own local-session spellings", () => {
    expect(isExplicitLocalSession(env({ PLANNOTATOR_REMOTE: "0" }))).toBe(true);
    expect(isExplicitLocalSession(env({ PLANNOTATOR_REMOTE: "FALSE" }))).toBe(
      true,
    );
    expect(isExplicitLocalSession(env({ PLANNOTATOR_REMOTE: " 0 " }))).toBe(
      true,
    );
  });

  it("is false when unset, empty, or asking for remote", () => {
    expect(isExplicitLocalSession(env({}))).toBe(false);
    expect(isExplicitLocalSession(env({ PLANNOTATOR_REMOTE: "" }))).toBe(false);
    expect(isExplicitLocalSession(env({ PLANNOTATOR_REMOTE: "1" }))).toBe(
      false,
    );
    expect(isExplicitLocalSession(env({ PLANNOTATOR_REMOTE: "true" }))).toBe(
      false,
    );
  });
});

describe("deliversReviewToClient", () => {
  const env = (pairs: Record<string, string>): NodeJS.ProcessEnv =>
    pairs as NodeJS.ProcessEnv;

  it("delivers for a rich host or an advertised remote URL", () => {
    expect(deliversReviewToClient(env({ PI_KIT_UI_HOST: "android" }))).toBe(
      true,
    );
    expect(deliversReviewToClient(env({ PLANNOTATOR_REMOTE: "1" }))).toBe(true);
    expect(
      deliversReviewToClient(env({ PLANNOTATOR_URL_HOST: "mini.local" })),
    ).toBe(true);
  });

  it("lets an explicit local session veto an inferred rich host", () => {
    // The deployment said "local session"; the worker's host profile must not
    // silently replace the browser the person asked for with a notice.
    expect(
      deliversReviewToClient(
        env({ PI_KIT_UI_HOST: "android", PLANNOTATOR_REMOTE: "0" }),
      ),
    ).toBe(false);
    expect(
      deliversReviewToClient(
        env({ PLANNOTATOR_URL_HOST: "mini.local", PLANNOTATOR_REMOTE: "0" }),
      ),
    ).toBe(false);
  });

  it("stays with the CLI on a plain terminal session", () => {
    expect(deliversReviewToClient(env({}))).toBe(false);
    expect(deliversReviewToClient(env({ PI_KIT_UI_HOST: "tui" }))).toBe(false);
  });
});

describe("deliverReviewToHost", () => {
  const env = (pairs: Record<string, string>): NodeJS.ProcessEnv =>
    pairs as NodeJS.ProcessEnv;
  const call = (
    pairs: Record<string, string>,
    hostMode: "browser" | "herdr-panel" = "browser",
    herdrEnv = false,
  ) => deliverReviewToHost({ env: env(pairs), hostMode, herdrEnv });

  it("hands the URL to the client when a rich UI host owns the screen", () => {
    // The pi desktop app: no PLANNOTATOR_* at all, only the worker's host profile.
    expect(call({ PI_KIT_UI_HOST: "android" })).toBe("client");
    expect(call({ PI_KIT_UI_HOST: "pi-web" })).toBe("client");
  });

  it("hands the URL to the client for the two explicit opt-ins", () => {
    expect(call({ PI_KIT_UI_HOST: "tui" }, "herdr-panel", true)).toBe("client");
    expect(call({ PLANNOTATOR_REMOTE: "1" })).toBe("client");
    expect(call({ PLANNOTATOR_URL_HOST: "mini.local" })).toBe("client");
  });

  it("leaves the browser to the CLI on a plain terminal session", () => {
    expect(call({})).toBe("cli");
    expect(call({ PI_KIT_UI_HOST: "tui" })).toBe("cli");
    // herdr-panel without a Herdr environment is the browser fallback.
    expect(call({ HERDR_ENV: "1" }, "herdr-panel", false)).toBe("cli");
  });
});
