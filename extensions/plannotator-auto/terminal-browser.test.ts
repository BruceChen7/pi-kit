import { describe, expect, it } from "vitest";
import {
  extractFirstUrlFromReadyContent,
  hasRightNeighborFromEdgesOutput,
  isHerdrEnvironment,
  nextHostMode,
  parseReadyFileLine,
  pickCloseTarget,
  resolveReviewHost,
  shouldCloseReviewPanel,
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
