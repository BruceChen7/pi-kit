import { describe, expect, it } from "vitest";
import {
  processBinaryFrameInput,
  TerminalProtocolAdapter,
} from "../terminal-protocol-adapter.js";

describe("processBinaryFrameInput", () => {
  describe("with adapter (primary path)", () => {
    it("passes normal text through unchanged", () => {
      const result = processBinaryFrameInput(
        "hello world",
        new TerminalProtocolAdapter(),
      );
      expect(result.cleanInput).toBe("hello world");
      expect(result.normalizedInput).toBe("hello world");
      expect(result.shouldDebugCtrlL).toBe(false);
    });

    it("strips embedded terminal queries from input", () => {
      const result = processBinaryFrameInput(
        "before\u001b[cafter",
        new TerminalProtocolAdapter(),
      );
      expect(result.cleanInput).toBe("beforeafter");
    });

    it("preserves non-query escape sequences like SGR", () => {
      const result = processBinaryFrameInput(
        "\u001b[32mgreen",
        new TerminalProtocolAdapter(),
      );
      expect(result.cleanInput).toBe("\u001b[32mgreen");
    });

    it("handles empty input", () => {
      const result = processBinaryFrameInput("", new TerminalProtocolAdapter());
      expect(result.cleanInput).toBe("");
      expect(result.normalizedInput).toBe("");
      expect(result.shouldDebugCtrlL).toBe(false);
    });
  });

  describe("without adapter (fallback path)", () => {
    it("passes normal text through unchanged", () => {
      const result = processBinaryFrameInput("hello world", undefined);
      expect(result.cleanInput).toBe("hello world");
      expect(result.shouldDebugCtrlL).toBe(false);
    });

    it("intercepts terminal queries (DA, CPR, DSR)", () => {
      const result = processBinaryFrameInput(
        "before\u001b[cafter\u001b[6nmore",
        undefined,
      );
      expect(result.cleanInput).toBe("beforeaftermore");
    });

    it("preserves non-query escape sequences like SGR", () => {
      const result = processBinaryFrameInput("\u001b[32mgreen", undefined);
      expect(result.cleanInput).toBe("\u001b[32mgreen");
    });

    it("handles empty input", () => {
      const result = processBinaryFrameInput("", undefined);
      expect(result.cleanInput).toBe("");
      expect(result.normalizedInput).toBe("");
      expect(result.shouldDebugCtrlL).toBe(false);
    });
  });

  describe("newline normalization", () => {
    it("converts CRLF to bare CR", () => {
      const result = processBinaryFrameInput(
        "line1\r\nline2",
        new TerminalProtocolAdapter(),
      );
      expect(result.normalizedInput).toBe("line1\rline2");
    });

    it("converts mixed line endings", () => {
      const result = processBinaryFrameInput(
        "a\r\nb\nc\r\nd",
        new TerminalProtocolAdapter(),
      );
      expect(result.normalizedInput).toBe("a\rb\rc\rd");
    });

    it("preserves bare CR unchanged", () => {
      const result = processBinaryFrameInput(
        "a\rb\rc",
        new TerminalProtocolAdapter(),
      );
      expect(result.normalizedInput).toBe("a\rb\rc");
    });
  });

  describe("Ctrl+L detection", () => {
    it("detects \\f in raw input", () => {
      const result = processBinaryFrameInput(
        "\fclear",
        new TerminalProtocolAdapter(),
      );
      expect(result.shouldDebugCtrlL).toBe(true);
      expect(result.normalizedInput).toBe("\fclear");
    });

    it("does not false-positive on normal input", () => {
      const result = processBinaryFrameInput(
        "normal text without formfeed",
        new TerminalProtocolAdapter(),
      );
      expect(result.shouldDebugCtrlL).toBe(false);
    });

    it("still detects \\f after terminal query stripping", () => {
      const result = processBinaryFrameInput(
        "\u001b[c\fclear",
        new TerminalProtocolAdapter(),
      );
      expect(result.shouldDebugCtrlL).toBe(true);
      // Query stripped, but \f survives in cleanInput
      expect(result.cleanInput).toContain("\f");
    });
  });
});

describe("TerminalProtocolAdapter", () => {
  it("strips a split tertiary DA response without leaking ;0q fragments", () => {
    const adapter = new TerminalProtocolAdapter();

    const first = adapter.processPtyOutput("before\u001b[>0;");
    const second = adapter.processPtyOutput("0;0qafter");

    expect(first.forward).toBe("before");
    expect(second.forward).toBe("after");
    expect(first.responses).toEqual([]);
    expect(second.responses).toEqual([]);
  });

  it("swallows a split >q query without fabricating >0;0;0q", () => {
    const adapter = new TerminalProtocolAdapter();

    const first = adapter.processPtyOutput("x\u001b[>");
    const second = adapter.processPtyOutput("qy");

    expect(first.forward).toBe("x");
    expect(first.responses).toEqual([]);
    expect(second.forward).toBe("y");
    expect(second.responses).toEqual([]);
  });

  it("intercepts a split DSR query and responds locally", () => {
    const adapter = new TerminalProtocolAdapter();

    const first = adapter.processPtyOutput("x\u001b[");
    const second = adapter.processPtyOutput("5ny");

    expect(first.forward).toBe("x");
    expect(first.responses).toEqual([]);
    expect(second.forward).toBe("y");
    expect(second.responses).toEqual(["\u001b[0n"]);
  });
});
