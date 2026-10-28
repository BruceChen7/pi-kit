/**
 * widget-plan — 「这一次同步往宿主发什么」的纯决策（Functional Core）。
 *
 * 两条宿主事实驱动整个决策（编码在 `shared/ui-host.ts` 的 `WidgetSurfaces`）：
 * pi-web 只在 widget **挂载**那一刻默认展开首个 2..3 行的 widget，之后不再重判；
 * 它的 widget 内容要点开才看得见，`setStatus` 的文本才常驻。于是「让 TODO widget
 * 默认展开」的杠杆是第一次出现时先发 2..3 行、紧接着发完整列表；内容不可见时模式
 * 文案改走状态行。判断都在这里，调用方只传宿主能力，不写宿主身份。
 */

import { MODE_WIDGET_KEY, STATUS_KEY, TODO_WIDGET_KEY } from "./constants.ts";

/** 本模块用到的宿主能力（`WidgetSurfaces` 的子集，赋值处会先报类型错）。 */
export type PlanModeHostCapabilities = {
  /** widget 内容在**不互动**时是否已经可见（pi-web 的 chip 要点开: false）。 */
  contentVisibleWithoutInteraction: boolean;
  /** 宿主在 widget 挂载时自动展开的行数区间；null = 宿主没有这个行为。 */
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
 * plan-mode 是否正在渲染一块用户可见的状态面。
 *
 * 与 badge 内容无关：只要宿主能看到 mode widget（TUI），或状态行有文本
 * （pi-web 有计划上下文），plan-mode 就是唯一渲染方。生产方据此清掉自己的
 * footer 段。判据与 `decidePlanModeUi` 共用同一份宿主能力与内容。
 */
export const claimsStatusSurface = (input: PlanModeUiInput): boolean =>
  modeTextSurface(input.host) === "modeWidget"
    ? input.content.modeLines.length > 0
    : input.content.statusText !== undefined;

/**
 * 决定这一次同步要发的调用序列。
 *
 * 顺序：status → mode widget（仅“内容一直可见”的宿主）→ TODO widget。
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
