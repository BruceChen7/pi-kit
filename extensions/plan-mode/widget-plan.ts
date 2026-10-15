/**
 * widget-plan — 「这一次同步往宿主发什么」的纯决策（Functional Core）。
 *
 * 背景（只改 pi-kit 的 pi-web 适配，见
 * `.pi/plans/pi-web/plan/2026-10-15-pi-web-extension-widget-default-expand.md`）：
 *
 * - pi-web 只在 `ExtensionWidgets` **挂载**（widget 数组由空变非空）的那一刻，
 *   默认展开「首个行数在 2..3 之间的 widget」，之后不再重判；已展开的 widget
 *   内容更新会保持展开。这两条事实编码在宿主档案 `shared/ui-host.ts` 的
 *   `WidgetSurfaces` 里（`autoExpandedLines` / `contentVisibleWithoutInteraction`）。
 * - 于是「让 TODO widget 默认展开」的唯一杠杆是：**它第一次出现时先发 2..3 行，
 *   紧接着再发完整列表**（两次 `setWidget` 是两次浏览器事件，第一帧触发挂载与
 *   默认展开，第二帧只换内容）。
 * - widget 内容要点击才可见的宿主（pi-web），模式文案改走一直可见的状态行 ——
 *   否则那一行 1 行的 mode widget 会先抢走挂载时刻。这条判断（“内容不可见就换
 *   表达方式”）在**这里**定；调用方只把宿主能力传进来，不写宿主身份判断。
 *
 * 本模块只做 value in / value out：不读 ctx、不碰主题、不认宿主身份，只按输入
 * （宿主能力 + 内容 + 会话状态）产出「要执行的调用序列」。上色与副作用都在
 * `controller.updateUi`（Imperative Shell）里发生。
 */

import { MODE_WIDGET_KEY, STATUS_KEY, TODO_WIDGET_KEY } from "./constants.ts";

/**
 * 本模块用到的宿主能力（刻意窄化 `WidgetSurfaces`：只保留影响决策的两项）。
 *
 * 结构上仍是档案字段的子集，所以 `controller.updateUi` 直接传档案值即可；
 * 档案形状若变化，赋值处会先报类型错。
 */
export type PlanModeHostCapabilities = {
  /** widget 内容在**不互动**时是否已经可见（TUI: true；pi-web 的 chip 要点开: false）。 */
  contentVisibleWithoutInteraction: boolean;
  /** 宿主在 widget 挂载时自动展开的短 widget 行数区间；null = 宿主没有这个行为。 */
  autoExpandedLines: { min: number; max: number } | null;
};

/** 一次同步里要执行的一次调用（普通数据，Shell 负责翻译成 `ctx.ui.*`）。 */
export type PlanModeUiEmission =
  | { kind: "status"; key: string; text: string | undefined }
  | {
      kind: "widget";
      key: string;
      /** 未上色的内容行，Shell 执行时按 key 上色。 */
      lines: string[];
      placement: "aboveEditor" | "belowEditor";
    }
  | { kind: "widget-clear"; key: string };

/** 本轮要展示的内容（未上色，纯文本）。 */
export type PlanModeUiContent = {
  /** TODO widget 的完整行；空数组 = 没有 TODO。 */
  todoLines: string[];
  /** mode widget 的行。 */
  modeLines: string[];
  /** 常驻状态行文本；undefined = 清空（普通 act 会话）。 */
  statusText: string | undefined;
};

export type PlanModeUiInput = {
  host: PlanModeHostCapabilities;
  /** 上一次同步后 TODO widget 是否已经存在于宿主里（会话级状态）。 */
  todoWidgetPresent: boolean;
  content: PlanModeUiContent;
};

export type PlanModeUiDecision = {
  /** 按顺序执行；顺序本身是契约（TUI 基线测试钉住）。 */
  emissions: PlanModeUiEmission[];
  /** 交给下一次同步的 `todoWidgetPresent`。 */
  todoWidgetPresent: boolean;
};

/** 内容要点开才可见时，关键信息该换到一直可见的地方：走状态行，不发 mode widget。 */
const modeTextSurface = (
  host: PlanModeHostCapabilities,
): "modeWidget" | "statusLine" =>
  host.contentVisibleWithoutInteraction ? "modeWidget" : "statusLine";

/**
 * 首次出现时的 seed：截到宿主能自动展开的行数内。
 * 完整列表本来就短于下限时返回 null（发一次就够，不制造重复的两帧）。
 */
const autoExpandSeedLines = (
  lines: string[],
  range: { min: number; max: number } | null,
  todoWidgetPresent: boolean,
): string[] | null => {
  if (!range || todoWidgetPresent) {
    return null;
  }
  const seed = lines.slice(0, range.max);
  return seed.length >= range.min ? seed : null;
};

/**
 * 决定这一次同步要发的调用序列。
 *
 * 顺序与改造前的 TUI 行为一致：status → mode widget（仅“内容一直可见”的宿主）→ TODO widget。
 */
export const decidePlanModeUi = (
  input: PlanModeUiInput,
): PlanModeUiDecision => {
  const { host, content } = input;
  const surface = modeTextSurface(host);
  const emissions: PlanModeUiEmission[] = [];

  emissions.push({
    kind: "status",
    key: STATUS_KEY,
    text: surface === "statusLine" ? content.statusText : undefined,
  });

  if (surface === "modeWidget") {
    emissions.push({
      kind: "widget",
      key: MODE_WIDGET_KEY,
      lines: content.modeLines,
      placement: "aboveEditor",
    });
  }

  if (content.todoLines.length === 0) {
    emissions.push({ kind: "widget-clear", key: TODO_WIDGET_KEY });
    return { emissions, todoWidgetPresent: false };
  }

  const seed = autoExpandSeedLines(
    content.todoLines,
    host.autoExpandedLines,
    input.todoWidgetPresent,
  );
  if (!seed) {
    emissions.push({
      kind: "widget",
      key: TODO_WIDGET_KEY,
      lines: content.todoLines,
      placement: "belowEditor",
    });
    return { emissions, todoWidgetPresent: true };
  }

  // 第一帧落在宿主的自动展开区间里；第二帧换成完整列表（内容不变则省掉）。
  emissions.push({
    kind: "widget",
    key: TODO_WIDGET_KEY,
    lines: seed,
    placement: "belowEditor",
  });
  if (content.todoLines.length > seed.length) {
    emissions.push({
      kind: "widget",
      key: TODO_WIDGET_KEY,
      lines: content.todoLines,
      placement: "belowEditor",
    });
  }
  return { emissions, todoWidgetPresent: true };
};
