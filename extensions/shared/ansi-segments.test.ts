import { describe, expect, it } from "vitest";
import {
  type AnsiColor,
  type AnsiSegment,
  type AnsiStyle,
  ansiColorToHex,
  parseAnsiLine,
  parseAnsiLines,
  stripAnsi,
} from "./ansi-segments.js";

const fg = (index: number): AnsiStyle => ({
  color: { type: "basic", index },
});
const bg = (index: number): AnsiStyle => ({
  backgroundColor: { type: "basic", index },
});
const seg = (text: string, style: AnsiStyle = {}): AnsiSegment => ({
  text,
  style,
});

describe("parseAnsiLine", () => {
  const cases: Array<[name: string, input: string, expected: AnsiSegment[]]> = [
    ["plain text", "hello", [seg("hello")]],
    ["empty line", "", []],
    ["standard foreground 31", "\x1b[31mred", [seg("red", fg(1))]],
    ["bright foreground 91", "\x1b[91mhi", [seg("hi", fg(9))]],
    ["standard background 44", "\x1b[44mhi", [seg("hi", bg(4))]],
    ["bright background 104", "\x1b[104mhi", [seg("hi", bg(12))]],
    [
      "256-color foreground",
      "\x1b[38;5;240mgrey",
      [
        seg("grey", {
          color: { type: "indexed", index: 240 },
        }),
      ],
    ],
    [
      "256-color background",
      "\x1b[48;5;16mx",
      [
        seg("x", {
          backgroundColor: { type: "indexed", index: 16 },
        }),
      ],
    ],
    [
      "truecolor foreground",
      "\x1b[38;2;12;34;56mx",
      [seg("x", { color: { type: "rgb", r: 12, g: 34, b: 56 } })],
    ],
    [
      "truecolor background",
      "\x1b[48;2;1;2;3mx",
      [seg("x", { backgroundColor: { type: "rgb", r: 1, g: 2, b: 3 } })],
    ],
    [
      "combined style flags",
      "\x1b[1;2;3;4;7;9mx",
      [
        seg("x", {
          bold: true,
          dim: true,
          italic: true,
          underline: true,
          inverse: true,
          strikethrough: true,
        }),
      ],
    ],
    [
      "transitions mid-line",
      "a\x1b[32mb\x1b[0mc",
      [seg("a"), seg("b", fg(2)), seg("c")],
    ],
    ["adjacent equal styles merge", "\x1b[31ma\x1b[31mb", [seg("ab", fg(1))]],
    [
      "selective resets",
      "\x1b[1;3;4;9mX\x1b[22mY\x1b[23mZ\x1b[24mW\x1b[29mV",
      [
        seg("X", {
          bold: true,
          italic: true,
          underline: true,
          strikethrough: true,
        }),
        seg("Y", { italic: true, underline: true, strikethrough: true }),
        seg("Z", { underline: true, strikethrough: true }),
        seg("W", { strikethrough: true }),
        seg("V"),
      ],
    ],
    [
      "frees colors separately with 39 and 49",
      "\x1b[31;44ma\x1b[39mb\x1b[49mc",
      [
        seg("a", {
          color: { type: "basic", index: 1 },
          backgroundColor: { type: "basic", index: 4 },
        }),
        // 39 只清前景，背景还在。
        seg("b", { backgroundColor: { type: "basic", index: 4 } }),
        seg("c"),
      ],
    ],
    ["drops the TUI cursor marker", "\x1b_pi:c\x07hello", [seg("hello")]],
    ["drops cursor moves and erases", "\x1b[2Khi\x1b[1A\x1b[0J", [seg("hi")]],
    ["ignores an incomplete 256-color code", "\x1b[38;5mx", [seg("x")]],
    [
      "captures OSC 8 links",
      "\x1b]8;;https://example.com\x1b\\docs\x1b]8;;\x1b\\ tail",
      [seg("docs", { link: "https://example.com" }), seg(" tail")],
    ],
    [
      "captures BEL-terminated OSC 8 links",
      "\x1b]8;;https://example.com\x07x",
      [seg("x", { link: "https://example.com" })],
    ],
    [
      "keeps the link across style changes",
      "\x1b]8;;https://e.co\x1b\\\x1b[32ma\x1b[0mb",
      [
        seg("a", { link: "https://e.co", color: { type: "basic", index: 2 } }),
        seg("b", { link: "https://e.co" }),
      ],
    ],
  ];

  it.each(cases)("%s", (_name, input, expected) => {
    expect(parseAnsiLine(input)).toEqual(expected);
  });
});

describe("parseAnsiLines", () => {
  // pi-web 每行一个 <AnsiText>（各自 new AnsiUp()），状态不跨行；Android 要与它一致。
  it("resets SGR state on every line, like pi-web does", () => {
    const [first, second] = parseAnsiLines(["\x1b[31mred", "plain"]);
    expect(first).toEqual([seg("red", fg(1))]);
    expect(second).toEqual([seg("plain")]);
  });

  it("keeps empty lines as empty arrays (line count is layout)", () => {
    expect(parseAnsiLines(["a", "", "b"])).toEqual([
      [seg("a")],
      [],
      [seg("b")],
    ]);
  });
});

describe("stripAnsi", () => {
  it("removes SGR, CSI and the cursor marker", () => {
    expect(stripAnsi("\x1b[1;31m\x1b_pi:c\x07hello\x1b[0m \x1b[2Kworld")).toBe(
      "hello world",
    );
  });

  it("removes OSC 8 but keeps its text", () => {
    expect(stripAnsi("\x1b]8;;https://e.co\x1b\\docs\x1b]8;;\x1b\\")).toBe(
      "docs",
    );
  });
});

describe("ansiColorToHex", () => {
  const cases: Array<[name: string, color: AnsiColor, expected: string]> = [
    ["standard red", { type: "basic", index: 1 }, "#800000"],
    ["bright red", { type: "basic", index: 9 }, "#ff0000"],
    ["standard white", { type: "basic", index: 7 }, "#c0c0c0"],
    ["bright white", { type: "basic", index: 15 }, "#ffffff"],
    ["256 black", { type: "indexed", index: 16 }, "#000000"],
    ["256 cube top", { type: "indexed", index: 231 }, "#ffffff"],
    ["256 gray ramp start", { type: "indexed", index: 232 }, "#080808"],
    ["256 gray ramp middle", { type: "indexed", index: 244 }, "#808080"],
    ["truecolor", { type: "rgb", r: 18, g: 52, b: 86 }, "#123456"],
  ];

  it.each(cases)("%s", (_name, color, expected) => {
    expect(ansiColorToHex(color)).toBe(expected);
  });

  it("clamps out-of-range channels instead of emitting broken hex", () => {
    expect(ansiColorToHex({ type: "rgb", r: 300, g: -4, b: 7.6 })).toBe(
      "#ff0008",
    );
  });
});
