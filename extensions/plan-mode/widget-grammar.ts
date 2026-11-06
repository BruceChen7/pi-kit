/**
 * widget-grammar — TODO widget 的行型契约（pi-clients 计划条按这套认行）。
 *
 * `ui.ts` 负责把这些行发出去，`widget-grammar.test.ts` 拿 `tui-call-baseline.ts` 里
 * 每一次真实发射逐行归类：出现契约之外的行就红。这样改文案、加分段、换状态短语时
 * **本仓先响**，而不是等用户在 pi-clients 里看见一块「原文卡片」—— 那边的解析失败只会
 * 退回原文，不会报错，也不会有人收到通知。
 *
 * 消费方：`pi-clients/app/widget/plan-todos.ts`（`parsePlanTodos`）。改这里的任何一条
 * （行型、状态短语长度、`已交付：` 这个分段标签）都要在同一笔改动里连那边的解析器与
 * 真 payload fixture 一起改。反过来，契约外的行在那边只会降级，不会崩。
 *
 * 另一个前提是**传输**：pi-clients 收到的是 `setWidget(key, string[])` 的原始行（pi-web 的
 * 档案 `lineLimit: null`）。如果哪天 pi-web 也报条数上限，长列表会改走组件工厂
 * （`shared/widget-lines.ts`），那边拿到的就是 headless 渲染后的行 —— 可能被折行，那是换了
 * 传输而不只是换语法，这套行型分类救不了。
 *
 * 纯函数：字符串 in / 分类 out，不碰 UI、不碰主题。
 */

/** 一行在契约里的角色。`blank` 是空行（上游不会发，容忍一下）。 */
export type TodoWidgetLine =
  | { kind: "blank" }
  /** `【状态短语】正文`：正文里是进度、当前步，或完成态的一句话。 */
  | { kind: "header"; phrase: string }
  /** `已完成 3/8 · 剩余 5 项`。 */
  | { kind: "progress" }
  /** `→ #4 [~] 文本` / `  #1 [✓] 文本` / `  #2 [ ] 文本`。 */
  | { kind: "item" }
  /** `已交付：`：完成态的分段标签，下面是没有状态括号的条目。 */
  | { kind: "delivered-label" }
  /** `  #1 文本`：完成态的条目。状态由上面的分段决定。 */
  | { kind: "delivered-item" };

/**
 * 状态短语的长度上限。
 *
 * pi-clients 的 `HEADER` 只收 40 字（`app/widget/plan-todos.ts`）；超了整条头部会掉进
 * 展开态的原文区，屏幕上的表现是「明明有进度，底下却多贴一行原文」。现有最长的是
 * `Completed, back to Act`（22）。
 */
export const MAX_HEADER_PHRASE_LENGTH = 40;

/** TUI 侧发出去的行会套一层主题标记（`<accent>…</accent>`）；行型按去壳后的文本判。 */
const THEMED = /^<([a-z][a-z-]*)>([\s\S]*)<\/\1>$/;
const HEADER = /^【([^】]+)】(.*)$/;
const PROGRESS = /^已完成 \d+\/\d+ · 剩余 \d+ 项$/;
const ITEM = /^(?:→\s*)?#\d+\s+\[.\]/;
const DELIVERED_LABEL = /^已交付[:：]$/;
const DELIVERED_ITEM = /^#\d+\s+\S/;

/** 去掉主题标记，只留契约关心的那段文本。 */
export const stripWidgetTheme = (line: string): string => {
  const themed = THEMED.exec(line.trim());
  return themed === null ? line.trim() : themed[2].trim();
};

/**
 * 一行属于哪种行型；契约之外返回 `undefined`（别把认不出的行当成 `blank` 吞掉）。
 *
 * 判断顺序是必要的：完成态的条目（`#1 文本`）与带状态括号的条目（`#1 [✓] 文本`）只有
 * 一个括号之差，先认带括号的那个，剩下的裸编号才归 `delivered-item`。
 */
export const readTodoWidgetLine = (
  line: string,
): TodoWidgetLine | undefined => {
  const text = stripWidgetTheme(line);
  if (text === "") return { kind: "blank" };
  const header = HEADER.exec(text);
  if (header !== null) return { kind: "header", phrase: header[1] };
  if (PROGRESS.test(text)) return { kind: "progress" };
  if (ITEM.test(text)) return { kind: "item" };
  if (DELIVERED_LABEL.test(text)) return { kind: "delivered-label" };
  if (DELIVERED_ITEM.test(text)) return { kind: "delivered-item" };
  return undefined;
};
