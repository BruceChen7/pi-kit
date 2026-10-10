/**
 * rich-ui — 宿主是否真的能显示 `ctx.ui.custom()` 的组件界面。
 *
 * `ctx.hasUI` 只说「宿主愿意对话」，不说「宿主能画自定义界面」。pi 的 RPC
 * 模式（Waku 这类原生宿主）是个陷阱：`hasUI === true`、`ctx.ui.custom` 也是
 * 函数，但它**不问宿主就 resolve `undefined`**（pi-coding-agent 的
 * `modes/rpc/rpc-mode.js`）。旧写法 `typeof ctx.ui.custom !== "function"`
 * 判不出这种情况，于是调用方拿着 `undefined` 当结果用
 * （`.length` / `.ok` / `"x" in r`）当场抛错。
 *
 * 判定只在这里定义一次：需要独占屏幕的能力（`custom`、`setEditorComponent`、
 * `addAutocompleteProvider`、`setFooter`）先过这道门；只走
 * `select`/`confirm`/`input`/`editor`/`notify`/`setWidget` 的流程不需要 ——
 * 那些在 RPC 下有真实实现。
 *
 * 字段缺失时按 TUI 处理：真实宿主两项都会给，省略它们的只有直接嵌入扩展运行时
 * 的调用方（测试、程序化调用），而它们此前的行为就是「能画」。
 */

/** 判定只需要这两项；`ExtensionContext` 天然满足。 */
export type RichUiContext = {
  hasUI?: boolean;
  mode?: string;
};

/** RPC 与无头模式：宿主有/无对话能力，但都没有组件界面。 */
const MODES_WITHOUT_RICH_UI: readonly string[] = ["rpc", "json", "print"];

export const hasRichUi = (ctx: RichUiContext): boolean =>
  ctx.hasUI !== false && !MODES_WITHOUT_RICH_UI.includes(ctx.mode ?? "");
