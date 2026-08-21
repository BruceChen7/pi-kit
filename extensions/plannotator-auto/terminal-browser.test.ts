import { describe, expect, it } from "vitest";
import {
  extractFirstUrlFromReadyContent,
  isHerdrEnvironment,
  parseReadyFileLine,
  selectPanelStrategy,
  shouldAutoClose,
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

  it("selectPanelStrategy uses Herdr panel concept", () => {
    expect(
      selectPanelStrategy({
        hasHerdrRightPane: false,
        hasExistingTerminalBrowser: false,
      }),
    ).toBe("split");
    expect(
      selectPanelStrategy({
        hasHerdrRightPane: true,
        hasExistingTerminalBrowser: false,
      }),
    ).toBe("split");
    expect(
      selectPanelStrategy({
        hasHerdrRightPane: false,
        hasExistingTerminalBrowser: true,
      }),
    ).toBe("new-tab");
    expect(
      selectPanelStrategy({
        hasHerdrRightPane: true,
        hasExistingTerminalBrowser: true,
      }),
    ).toBe("new-tab");
  });

  it("shouldAutoClose only on approved", () => {
    expect(shouldAutoClose({ approved: true })).toBe(true);
    expect(shouldAutoClose({ approved: false })).toBe(false);
    expect(shouldAutoClose({})).toBe(false);
  });
});
