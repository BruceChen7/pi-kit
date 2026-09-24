import { describe, expect, it } from "vitest";
import { printableInput } from "./printable-input.ts";

describe("printableInput", () => {
  it("未修饰文本原样进文本框（ASCII / 中文 / IME 提交）", () => {
    expect(printableInput("b")).toBe("b");
    expect(printableInput("共识")).toBe("共识");
    expect(printableInput(" ")).toBe(" ");
    expect(printableInput("Raft 共识")).toBe("Raft 共识");
  });

  it("Kitty CSI-u 的可打印键解出字符（shift+键不再是原字符）", () => {
    // Ghostty/kitty: shift+b → CSI 98:66;2u（98=b, 66=B, 修饰位 2=shift）
    expect(printableInput("\u001b[98:66;2u")).toBe("B");
    expect(printableInput("\u001b[59:58;2u")).toBe(":");
    // report_all 的终端会把未修饰键也编码成 CSI-u
    expect(printableInput("\u001b[98u")).toBe("b");
  });

  it("无 Kitty 的终端走 modifyOtherKeys：CSI 27;2;66~ 同样是 B", () => {
    expect(printableInput("\u001b[27;2;66~")).toBe("B");
  });

  it("bracketed paste 剥包裹进文本框；换行等控制字符丢掉", () => {
    expect(printableInput("\u001b[200~共识\u001b[201~")).toBe("共识");
    expect(printableInput("\u001b[200~Raft\n\u001b[201~")).toBe("Raft");
    expect(printableInput("\u001b[200~\u001b[201~")).toBeUndefined();
  });

  it("控制序列一律不是文本", () => {
    expect(printableInput("")).toBeUndefined();
    expect(printableInput("\u001b")).toBeUndefined();
    expect(printableInput("\r")).toBeUndefined();
    expect(printableInput("\u001b[A")).toBeUndefined();
    expect(printableInput("\u001b[1;1A")).toBeUndefined();
    expect(printableInput("\u007f")).toBeUndefined();
    // ctrl / alt 组合是快捷键，不进文本框
    expect(printableInput("\u001b[98;5u")).toBeUndefined();
    expect(printableInput("\u001b[27;5;98~")).toBeUndefined();
    // shift+enter 之类不可打印
    expect(printableInput("\u001b[13;2u")).toBeUndefined();
  });
});
