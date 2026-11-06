/**
 * TODO widget 的行型契约闸。
 *
 * 数据源是 `tui-call-baseline.ts`：那里记录的是终端下**真正发出去**的 `setWidget` 调用。
 * 改文案 / 加分段 / 换状态短语的路径是「`tui-parity.test.ts` 先红 → 重录基线」，
 * 重录正是漂移被盖章的那一刻 —— 所以闸装在这里：基线里出现契约外的行，这条测试红，
 * 逼着改动的人顺手确认 pi-clients 那边还能认。
 */

import { describe, expect, it } from "vitest";
import { TODO_WIDGET_KEY } from "./constants.js";
import { TUI_CALL_BASELINE } from "./tui-call-baseline.js";
import {
  MAX_HEADER_PHRASE_LENGTH,
  readTodoWidgetLine,
  stripWidgetTheme,
  type TodoWidgetLine,
} from "./widget-grammar.js";

type Frame = { scenario: string; lines: string[] };

/** 基线里每一帧真正发出去的 TODO widget（`lines` 省略 = 清空，不算一帧）。 */
const frames = (): Frame[] =>
  Object.entries(TUI_CALL_BASELINE).flatMap(([scenario, calls]) =>
    calls.flatMap((call) =>
      call.call === "setWidget" && call.key === TODO_WIDGET_KEY && call.lines
        ? [{ scenario, lines: call.lines }]
        : [],
    ),
  );

const read = (line: string): TodoWidgetLine => {
  const parsed = readTodoWidgetLine(line);
  if (parsed === undefined) {
    throw new Error(`契约之外的一行：${JSON.stringify(line)}`);
  }
  return parsed;
};

const kinds = (lines: readonly string[]): TodoWidgetLine["kind"][] =>
  lines.map((line) => read(line).kind);

describe("TODO widget 行型契约", () => {
  it("基线里记着每一帧（闸别对着空集合放行）", () => {
    expect(frames().length).toBeGreaterThanOrEqual(4);
  });

  it("每一行都落在契约里", () => {
    const outside = frames().flatMap(({ scenario, lines }) =>
      lines.flatMap((line) =>
        readTodoWidgetLine(line) === undefined
          ? [`${scenario} / ${JSON.stringify(line)}`]
          : [],
      ),
    );
    expect(outside).toEqual([]);
  });

  it("第一行永远是头部，状态短语不超过 pi-clients 的上限", () => {
    const offenders = frames().flatMap(({ scenario, lines }) => {
      const first = read(lines[0]);
      if (first.kind !== "header")
        return [`${scenario}: 第一行是 ${first.kind}，不是 header`];
      return first.phrase.length > MAX_HEADER_PHRASE_LENGTH
        ? [
            `${scenario}: 状态短语 ${first.phrase.length} 字（上限 ${MAX_HEADER_PHRASE_LENGTH}）`,
          ]
        : [];
    });
    expect(offenders).toEqual([]);
  });

  it("进行中的帧：头部 → 进度 → 条目", () => {
    for (const { lines } of frames()) {
      if (kinds(lines).includes("delivered-label")) continue;
      expect(kinds(lines).slice(0, 2)).toEqual(["header", "progress"]);
      expect(
        kinds(lines)
          .slice(2)
          .every((kind) => kind === "item"),
      ).toBe(true);
    }
  });

  it("完成态的帧：头部 → `已交付：` → 要求没有状态括号的条目", () => {
    for (const { lines } of frames()) {
      const kindList = kinds(lines);
      const label = kindList.indexOf("delivered-label");
      if (label === -1) continue;
      expect(label).toBe(1);
      expect(
        kindList
          .slice(label + 1)
          .every((kind) => kind === "delivered-item" || kind === "item"),
      ).toBe(true);
      expect(kindList.slice(label + 1)).not.toHaveLength(0);
    }
  });
});

describe("readTodoWidgetLine", () => {
  it("TUI 的主题壳不影响分类，短语原样带出来", () => {
    expect(
      readTodoWidgetLine(
        "<accent>【Approved, executing】下一步 #8/8：验证</accent>",
      ),
    ).toEqual({
      kind: "header",
      phrase: "Approved, executing",
    });
    expect(stripWidgetTheme("<accent>【Act】进行中</accent>")).toBe(
      "【Act】进行中",
    );
  });

  it("三种线上见过的行型（真会话 /state 原文）", () => {
    expect(read("已完成 7/8 · 剩余 1 项").kind).toBe("progress");
    expect(read("  #1 [✓] route: feature").kind).toBe("item");
    expect(read("→ #8 [!] 验证：vitest guard").kind).toBe("item");
    expect(read("已交付：").kind).toBe("delivered-label");
    expect(read("  #1 读 subagent / librarian 现状，确认可改的缝").kind).toBe(
      "delivered-item",
    );
  });

  it("契约之外的行返回 undefined，不冒充空行", () => {
    expect(readTodoWidgetLine("")).toEqual({ kind: "blank" });
    for (const line of [
      "1. 换个编号写法",
      "PLAN v2 | 3 items",
      "[x] 1  老格式",
      "已完成 3/8",
    ]) {
      expect(readTodoWidgetLine(line)).toBeUndefined();
    }
  });
});
