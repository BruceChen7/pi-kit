import { type TUnsafe, Type } from "typebox";

/**
 * `{ type: "string", enum: [...] }`：Google 的 API 和另外几个 provider 不认
 * `anyOf` / `const` 形式的字符串枚举，只认 `type` + `enum`。
 *
 * 为什么不直接用 `@earendil-works/pi-ai` 的 `StringEnum`：在 pi 里那个导出的返回类型是
 * TypeBox 的 `TUnsafe<T>`，但已发布的 pi-ai 把它标成 pi-schema 的 `Schema<T>`，
 * TypeBox 的 `Static` 读不懂 pi-schema 的 brand，`Type.Optional(StringEnum(...))`
 * 会推成 `unknown`。
 *
 * 为什么是 `Type.Unsafe` 而不是裸对象：裸对象塞进 `Type.Optional` 后，typebox 1.x 会把
 * `~optional: true` 留在 provider 面的 schema 里；`Type.Unsafe` 标的 `~unsafe` 让
 * `Type.Object` 认得出这是 schema，从而剥掉它。
 */
export function stringEnum<const T extends readonly string[]>(
  values: T,
  options?: { description?: string },
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: values,
    ...(options?.description && { description: options.description }),
  });
}
