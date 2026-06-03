import { describe, expect, it } from "vitest";
import { TerminalProtocolAdapter } from "../terminal-protocol-adapter.js";

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
