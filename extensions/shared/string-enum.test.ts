import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { stringEnum } from "./string-enum.js";

describe("stringEnum", () => {
  it("emits exactly the object pi-ai's StringEnum emits", () => {
    // 逐字节：key 顺序也是 provider 看到的那份 JSON 的一部分。
    expect(JSON.stringify(stringEnum(["fast", "deep"]))).toBe(
      '{"type":"string","enum":["fast","deep"]}',
    );
    expect(
      JSON.stringify(stringEnum(["fast", "deep"], { description: "depth" })),
    ).toBe('{"type":"string","enum":["fast","deep"],"description":"depth"}');
  });

  it("keeps the literal union as TypeBox's static type", () => {
    const mode = stringEnum(["fast", "deep"] as const);
    type Mode = Static<typeof mode>;

    const valid: Mode = "deep";
    expect(valid).toBe("deep");

    // 退化（比如 Static 变成 string 或 unknown）时下面这行不再报错，
    // tsc 就会因为 @ts-expect-error 没被用到而失败。这条断言靠 npm run typecheck 执行。
    // @ts-expect-error "slow" 不在 ["fast","deep"] 里
    const invalid: Mode = "slow";
    expect(invalid).toBe("slow");
  });

  it("leaves no ~optional marker in the provider-facing schema", () => {
    const parameters = Type.Object({
      mode: Type.Optional(stringEnum(["fast"])),
    });
    expect(JSON.stringify(parameters)).toBe(
      '{"type":"object","properties":{"mode":{"type":"string","enum":["fast"]}}}',
    );
  });

  it("validates as a closed string enum", () => {
    const schema = stringEnum(["fast", "deep"]);
    expect(Value.Check(schema, "fast")).toBe(true);
    expect(Value.Check(schema, "slow")).toBe(false);
    expect(Value.Check(schema, 3)).toBe(false);
  });
});
