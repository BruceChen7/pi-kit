import { describe, expect, it } from "vitest";
import { createPickerState, type PickerState } from "./picker-core.ts";
import { applyPickerKey } from "./picker-input.ts";

const state = (over: Partial<PickerState> = {}): PickerState => ({
  ...createPickerState(),
  ...over,
});

describe("applyPickerKey", () => {
  it("esc 取消：legacy 与 Kitty 编码都认", () => {
    expect(applyPickerKey("\u001b", state(), 3).kind).toBe("cancel");
    expect(applyPickerKey("\u001b[27u", state(), 3).kind).toBe("cancel");
  });

  it("enter 提交当前光标行（下标基于过滤后的列表）", () => {
    expect(applyPickerKey("\r", state({ cursor: 2 }), 3)).toEqual({
      kind: "submit",
      index: 2,
    });
    expect(applyPickerKey("\u001b[13u", state({ cursor: 1 }), 3)).toEqual({
      kind: "submit",
      index: 1,
    });
  });

  it("↑/↓ 移动光标：Kitty 编码与 legacy 编码都认，夹取不环绕", () => {
    expect(applyPickerKey("\u001b[1;1B", state({ cursor: 0 }), 2)).toEqual({
      kind: "update",
      state: state({ cursor: 1 }),
    });
    expect(applyPickerKey("\u001b[1;1A", state({ cursor: 1 }), 2)).toEqual({
      kind: "update",
      state: state({ cursor: 0 }),
    });
    // 已经在顶上：不动，也不需要重绘
    expect(applyPickerKey("\u001b[A", state({ cursor: 0 }), 2).kind).toBe(
      "ignore",
    );
  });

  it("文本进 query 且光标回第一行：普通字符 / shift 的 CSI-u / 粘贴", () => {
    expect(applyPickerKey("b", state({ cursor: 2 }), 5)).toEqual({
      kind: "update",
      state: state({ query: "b" }),
    });
    expect(applyPickerKey("\u001b[98:66;2u", state(), 5)).toEqual({
      kind: "update",
      state: state({ query: "B" }),
    });
    expect(applyPickerKey("\u001b[200~共识\u001b[201~", state(), 5)).toEqual({
      kind: "update",
      state: state({ query: "共识" }),
    });
  });

  it("j / k 是可搜索的文本，不做 vim 式移动", () => {
    expect(applyPickerKey("k", state({ cursor: 1 }), 3)).toEqual({
      kind: "update",
      state: state({ query: "k" }),
    });
  });

  it("退格删一个字符；空 query 时不动", () => {
    expect(applyPickerKey("\u007f", state({ query: "abc" }), 3)).toEqual({
      kind: "update",
      state: state({ query: "ab" }),
    });
    expect(applyPickerKey("\u007f", state(), 3).kind).toBe("ignore");
  });

  it("功能键 / ctrl 组合一律不动", () => {
    expect(applyPickerKey("\u001b[1;5C", state(), 3).kind).toBe("ignore");
    expect(applyPickerKey("\u001bOP", state(), 3).kind).toBe("ignore");
    expect(applyPickerKey("\u001b[98;5u", state(), 3).kind).toBe("ignore");
    expect(applyPickerKey("", state(), 3).kind).toBe("ignore");
  });
});
