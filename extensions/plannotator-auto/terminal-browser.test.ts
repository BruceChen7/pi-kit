import { describe, expect, it } from "vitest";
import {
  extractFirstUrlFromReadyContent,
  hasRightNeighborFromEdgesOutput,
  isHerdrEnvironment,
  parseReadyFileLine,
  selectPanelStrategy,
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

  it("selectPanelStrategy keys off right-pane existence", () => {
    // No right pane → split right to create the review panel.
    expect(selectPanelStrategy({ hasHerdrRightPane: false })).toBe("split");
    // Right pane already exists → reuse it via new-tab, never over-split.
    expect(selectPanelStrategy({ hasHerdrRightPane: true })).toBe("new-tab");
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
    // 红灯预期:当前实现只在 approved 时关闭;denied(带 comment)与
    // dismissed 也是评审终结判定,必须同样关闭面板。
    expect(shouldCloseReviewPanel({ approved: true })).toBe(true);
    expect(shouldCloseReviewPanel({ approved: false, feedback: "x" })).toBe(
      true,
    );
    expect(shouldCloseReviewPanel({ dismissed: true })).toBe(true);
    expect(shouldCloseReviewPanel({})).toBe(false);
  });
});
