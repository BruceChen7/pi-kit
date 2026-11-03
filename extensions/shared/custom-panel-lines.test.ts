import { describe, expect, it } from "vitest";
import { normalizeCustomPanelLines } from "./custom-panel-lines.js";
import { normalizeCustomPanelLines as piWebReference } from "./pi-web-host-fixture.js";

const stripAnsi = (text: string): string =>
  text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 终端转义本来就从 ESC 开始
    .replace(/\x1B(?:\[[0-9;?]*[ -/]*[@-~]|_[^\x07]*\x07|[@-Z\\-_])/g, "");

describe("normalizeCustomPanelLines", () => {
  it("drops whole horizontal frame lines", () => {
    expect(
      normalizeCustomPanelLines([
        "┌──────────┐",
        "│ hello    │",
        "└──────────┘",
      ]),
    ).toEqual(["hello"]);
  });

  it("strips left and right vertical borders and the padding after the left one", () => {
    // 左框线后只吃一个空格（pi-web 的语义），多出来的缩进留给宿主。
    expect(normalizeCustomPanelLines(["│  Act  #1  │"])).toEqual([" Act  #1"]);
    expect(normalizeCustomPanelLines(["┃bold┃"])).toEqual(["bold"]);
  });

  it("only strips the borders on the outside, never inner pipes", () => {
    expect(normalizeCustomPanelLines(["│ a │ b │"])).toEqual(["a │ b"]);
  });

  it("keeps SGR sequences around the text it strips", () => {
    expect(
      normalizeCustomPanelLines(["\x1b[32m│  ok  │\x1b[0m"]).map(stripAnsi),
    ).toEqual([" ok"]);
    expect(
      normalizeCustomPanelLines(["\x1b[32m│  ok  │\x1b[0m"])[0]?.startsWith(
        "\x1b[32m",
      ),
    ).toBe(true);
  });

  it("removes the TUI cursor marker", () => {
    const [line] = normalizeCustomPanelLines(["\x1b_pi:c\x07#1 [~] 跑测试"]);
    expect(line).toBe("#1 [~] 跑测试");
  });

  it("trims trailing visible spaces but not trailing escapes", () => {
    expect(normalizeCustomPanelLines(["text   "])).toEqual(["text"]);
    expect(normalizeCustomPanelLines(["text  \x1b[0m"])).toEqual([
      "text\x1b[0m",
    ]);
  });

  it("drops leading and trailing blank lines, keeps inner ones", () => {
    expect(
      normalizeCustomPanelLines(["", "  ", "a", "", "b", "   ", ""]),
    ).toEqual(["a", "", "b"]);
  });

  it("returns the original lines when everything is chrome", () => {
    const lines = ["┌───┐", "└───┘"];
    expect(normalizeCustomPanelLines(lines)).toEqual(lines);
  });

  it("leaves already borderless panels untouched (idempotent)", () => {
    const lines = [
      "#2 [~] 改造 transport",
      "",
      "\x1b[2m0/2 · 下一步 跑 vitest\x1b[0m",
    ];
    expect(normalizeCustomPanelLines(lines)).toEqual(lines);
    expect(normalizeCustomPanelLines(normalizeCustomPanelLines(lines))).toEqual(
      lines,
    );
  });

  it("handles rounded frames and indented content", () => {
    expect(
      normalizeCustomPanelLines(["╭────────╮", "│  步骤  │", "╰────────╯"]),
    ).toEqual([" 步骤"]);
  });
});

/**
 * 这份实现与 pi-web 的替身（pi-web-host-fixture）必须逐字等价：两边吃的是同一份
 * `string[]`，剥得不一样就是「同一面板在浏览器和手机上缩进不同」。
 * 故意保留两份实现——替身是外部系统的独立判据，不能从被测实现里导出。
 */
describe("normalizeCustomPanelLines / pi-web equivalence", () => {
  const corpus: string[][] = [
    ["┌──────────┐", "│ hello    │", "└──────────┘"],
    ["╭────╮", "│ 步骤 │", "╰────╯"],
    ["│\x1b[31mred\x1b[0m│"],
    ["\x1b[32m│  ok  │\x1b[0m"],
    ["\x1b_pi:c\x07#1 [~] 跑测试   "],
    ["", "a", "", "b", ""],
    ["│ a │ b │"],
    ["  ", "   "],
    ["┃x┃"],
    ["no chrome at all", "\x1b[2mdim\x1b[0m"],
  ];

  it.each(corpus.map((lines, index) => [index, lines] as const))(
    "corpus #%i",
    (_index, lines) => {
      expect(normalizeCustomPanelLines([...lines])).toEqual(
        piWebReference([...lines]),
      );
    },
  );
});
