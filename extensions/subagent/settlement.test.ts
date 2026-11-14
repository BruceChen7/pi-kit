import { describe, expect, it } from "vitest";
import {
  deriveSettlement,
  type SettlementMessage,
  textOfAssistantContent,
} from "./settlement.ts";

const reply = (text: string): SettlementMessage => ({
  role: "assistant",
  text,
});
const tool = (text = "read a.ts"): SettlementMessage => ({
  role: "tool",
  text,
});
const prompt = (text = "check the cache layer"): SettlementMessage => ({
  role: "user",
  text,
});

describe("deriveSettlement", () => {
  it("is empty when the child never answered", () => {
    expect(deriveSettlement({ messages: [prompt(), tool()] })).toEqual({
      status: "empty",
      text: "",
    });
  });

  it("settles on the last answer when nothing is owed", () => {
    expect(
      deriveSettlement({
        messages: [
          prompt(),
          tool(),
          reply("3 directories"),
          tool(),
          reply(" done "),
        ],
      }),
    ).toEqual({ status: "settled", text: "done" });
  });

  it("ignores an empty assistant message", () => {
    expect(
      deriveSettlement({
        messages: [prompt(), reply("the answer"), reply("   ")],
      }),
    ).toEqual({ status: "settled", text: "the answer" });
  });

  it("calls an answer before the results it owes intermediate", () => {
    expect(
      deriveSettlement({
        messages: [prompt(), reply("我先去查一下，稍后汇总")],
        obligations: ["group-1"],
      }),
    ).toEqual({ status: "intermediate", text: "我先去查一下，稍后汇总" });
  });

  it("settles once the obligations are gone, even with the same text", () => {
    const messages = [prompt(), reply("我先去查一下，稍后汇总")];

    expect(deriveSettlement({ messages, obligations: [] }).status).toBe(
      "settled",
    );
    expect(deriveSettlement({ messages }).status).toBe("settled");
  });

  it("is empty rather than intermediate when there is no answer at all", () => {
    expect(
      deriveSettlement({ messages: [prompt(), tool()], obligations: ["g"] }),
    ).toEqual({ status: "empty", text: "" });
  });
});

describe("textOfAssistantContent", () => {
  it("joins text parts and drops non-text parts", () => {
    expect(
      textOfAssistantContent([
        { type: "text", text: "a" },
        { type: "toolCall", name: "read" },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\nb");
  });

  it("returns an empty string for anything unexpected", () => {
    expect(textOfAssistantContent(undefined)).toBe("");
    expect(textOfAssistantContent("plain")).toBe("");
  });
});
