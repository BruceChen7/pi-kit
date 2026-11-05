import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { createLinesWidget } from "./widget-lines.js";

/** 组件工厂只用到 `render(width)`；tui / theme 参数这里不参与渲染。 */
const renderWidget = (lines: readonly string[], width = 80): string[] =>
  createLinesWidget(lines)({} as never, {} as never).render(width);

const plain = (lines: readonly string[]): string[] =>
  lines.map((line) => stripTerminalSequences(line).trim());

describe("createLinesWidget", () => {
  it("renders every line the host would drop past its array cap", () => {
    const lines = Array.from(
      { length: 24 },
      (_, index) => `#${index + 1} todo`,
    );
    const rendered = renderWidget(lines);

    expect(rendered).toHaveLength(24);
    expect(plain(rendered)).toEqual(lines);
    expect(rendered.join("\n")).not.toContain("widget truncated");
  });

  it("keeps the host's array look: one leading pad column per line", () => {
    const [first] = renderWidget(["已完成 0/1 · 剩余 1 项"]);
    expect(first?.startsWith(" 已完成")).toBe(true);
  });

  it("keeps ANSI colours already baked into the lines", () => {
    const rendered = renderWidget(["\u001b[36m#1 实现状态机\u001b[39m"]);
    expect(rendered[0]).toContain("\u001b[36m");
  });

  it("wraps a long line instead of truncating it", () => {
    const long = "很长的任务描述".repeat(10);
    const rendered = renderWidget([long], 20);
    expect(rendered.length).toBeGreaterThan(1);
    expect(plain(rendered).join("")).toBe(long);
  });
});
