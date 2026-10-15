import { describe, expect, it } from "vitest";
import { MODE_WIDGET_KEY, STATUS_KEY, TODO_WIDGET_KEY } from "./constants.js";
import {
  decidePlanModeUi,
  type PlanModeHostCapabilities,
  type PlanModeUiContent,
  type PlanModeUiInput,
} from "./widget-plan.js";

/**
 * `decidePlanModeUi` 的值表（Functional Core：value in / value out）。
 *
 * 三组契约：
 * 1. 表达方式由**宿主能力**决定，不由宿主身份决定（内容要点开才可见 ⇒ 模式文案走状态行）；
 * 2. pi-web 的自动展开契约（`autoExpandedLines`）只在挂载那一刻生效 ⇒ 首次出现的两帧；
 * 3. 内容可见的宿主（TUI）调用序列与改造前逐条一致。
 */

const PI_WEB_RANGE = { min: 2, max: 3 };
const PI_WEB_HOST: PlanModeHostCapabilities = {
  contentVisibleWithoutInteraction: false,
  autoExpandedLines: PI_WEB_RANGE,
};
const TUI_HOST: PlanModeHostCapabilities = {
  contentVisibleWithoutInteraction: true,
  autoExpandedLines: null,
};

const modeLines = ["Plan Mode: Act · Act · Alt+0 toggles"];
const statusText = "Plan Mode: Act · #1/4 实现状态机 · 0/4 已完成";

type InputOverrides = {
  host?: Partial<PlanModeHostCapabilities>;
  todoWidgetPresent?: boolean;
  content?: Partial<PlanModeUiContent>;
};

const input = (
  host: PlanModeHostCapabilities,
  over: InputOverrides = {},
): PlanModeUiInput => ({
  host: { ...host, ...over.host },
  todoWidgetPresent: over.todoWidgetPresent ?? false,
  content: {
    todoLines: [],
    modeLines,
    statusText: host.contentVisibleWithoutInteraction ? undefined : statusText,
    ...over.content,
  },
});

const piWebInput = (over: InputOverrides = {}) => input(PI_WEB_HOST, over);
const tuiInput = (over: InputOverrides = {}) => input(TUI_HOST, over);

const todoLines = (count: number): string[] =>
  Array.from(
    { length: count },
    (_, index) => `  #${index + 1} [ ] 任务${index + 1}`,
  );

describe("decidePlanModeUi: 表达方式由宿主能力决定", () => {
  it("内容要点开才可见：模式文案走状态行，不发 mode widget", () => {
    const decision = decidePlanModeUi(piWebInput());

    expect(decision.emissions).toEqual([
      { kind: "status", key: STATUS_KEY, text: statusText },
      { kind: "widget-clear", key: TODO_WIDGET_KEY },
    ]);
  });

  it("内容一直可见：模式文案留在 mode widget，status 恒为清空", () => {
    const decision = decidePlanModeUi(tuiInput());

    expect(decision.emissions).toEqual([
      { kind: "status", key: STATUS_KEY, text: undefined },
      {
        kind: "widget",
        key: MODE_WIDGET_KEY,
        lines: modeLines,
        placement: "aboveEditor",
      },
      { kind: "widget-clear", key: TODO_WIDGET_KEY },
    ]);
  });

  it("判据是能力而不是宿主身份：同样“内容不可见”的未知宿主也走状态行", () => {
    const unknownHost = input(
      { contentVisibleWithoutInteraction: false, autoExpandedLines: null },
      { content: { todoLines: todoLines(6), statusText } },
    );
    const decision = decidePlanModeUi(unknownHost);

    expect(
      decision.emissions.filter((emission) => emission.kind === "widget"),
    ).toEqual([
      // 没有自动展开能力 ⇒ 不 seed，只发完整列表一次（placement 由 Core 给出）。
      {
        kind: "widget",
        key: TODO_WIDGET_KEY,
        lines: todoLines(6),
        placement: "belowEditor",
      },
    ]);
    expect(decision.emissions[0]).toEqual({
      kind: "status",
      key: STATUS_KEY,
      text: statusText,
    });
  });
});

describe("decidePlanModeUi: pi-web（内容不可见 + 2..3 行自动展开）", () => {
  it("没有 todo 时只发状态、清掉 TODO widget", () => {
    expect(decidePlanModeUi(piWebInput())).toEqual({
      emissions: [
        { kind: "status", key: STATUS_KEY, text: statusText },
        { kind: "widget-clear", key: TODO_WIDGET_KEY },
      ],
      todoWidgetPresent: false,
    });
  });

  it("首次出现、列表本来就在 2..3 行内时只发一帧", () => {
    const full = ["heading", "progress", ...todoLines(1)];
    const decision = decidePlanModeUi(
      piWebInput({ content: { todoLines: full } }),
    );

    expect(decision.emissions).toEqual([
      { kind: "status", key: STATUS_KEY, text: statusText },
      {
        kind: "widget",
        key: TODO_WIDGET_KEY,
        lines: full,
        placement: "belowEditor",
      },
    ]);
    expect(decision.todoWidgetPresent).toBe(true);
  });

  it("首次出现、长列表先发 3 行再发完整列表（命中挂载时的默认展开）", () => {
    const full = todoLines(6);
    const decision = decidePlanModeUi(
      piWebInput({ content: { todoLines: full } }),
    );

    expect(decision.emissions).toEqual([
      { kind: "status", key: STATUS_KEY, text: statusText },
      {
        kind: "widget",
        key: TODO_WIDGET_KEY,
        lines: full.slice(0, 3),
        placement: "belowEditor",
      },
      {
        kind: "widget",
        key: TODO_WIDGET_KEY,
        lines: full,
        placement: "belowEditor",
      },
    ]);
    expect(decision.todoWidgetPresent).toBe(true);
  });

  it("已经出现过之后只发完整列表（不再 seed）", () => {
    const full = todoLines(6);
    const decision = decidePlanModeUi(
      piWebInput({ content: { todoLines: full }, todoWidgetPresent: true }),
    );

    expect(decision.emissions).toEqual([
      { kind: "status", key: STATUS_KEY, text: statusText },
      {
        kind: "widget",
        key: TODO_WIDGET_KEY,
        lines: full,
        placement: "belowEditor",
      },
    ]);
  });

  it("清空后再出现会重新 seed（面板再次默认展开）", () => {
    const cleared = decidePlanModeUi(piWebInput());
    expect(cleared.todoWidgetPresent).toBe(false);

    const full = todoLines(6);
    const again = decidePlanModeUi(
      piWebInput({
        content: { todoLines: full },
        todoWidgetPresent: cleared.todoWidgetPresent,
      }),
    );
    expect(
      again.emissions.filter((emission) => emission.kind === "widget"),
    ).toEqual([
      {
        kind: "widget",
        key: TODO_WIDGET_KEY,
        lines: full.slice(0, 3),
        placement: "belowEditor",
      },
      {
        kind: "widget",
        key: TODO_WIDGET_KEY,
        lines: full,
        placement: "belowEditor",
      },
    ]);
  });

  it("列表短于宿主的展开下限时不制造重复两帧", () => {
    const decision = decidePlanModeUi(
      piWebInput({ content: { todoLines: ["只有一行"] } }),
    );
    expect(
      decision.emissions.filter((emission) => emission.kind === "widget"),
    ).toEqual([
      {
        kind: "widget",
        key: TODO_WIDGET_KEY,
        lines: ["只有一行"],
        placement: "belowEditor",
      },
    ]);
  });

  it("宿主没有自动展开区间时绝不 seed", () => {
    const full = todoLines(6);
    const decision = decidePlanModeUi(
      piWebInput({
        host: { autoExpandedLines: null },
        content: { todoLines: full },
      }),
    );
    expect(
      decision.emissions.filter((emission) => emission.kind === "widget"),
    ).toEqual([
      {
        kind: "widget",
        key: TODO_WIDGET_KEY,
        lines: full,
        placement: "belowEditor",
      },
    ]);
  });
});

describe("decidePlanModeUi: 内容可见的宿主（与改造前的调用序列一致）", () => {
  it("无 todo：status → mode widget → 清掉 TODO widget", () => {
    expect(decidePlanModeUi(tuiInput())).toEqual({
      emissions: [
        { kind: "status", key: STATUS_KEY, text: undefined },
        {
          kind: "widget",
          key: MODE_WIDGET_KEY,
          lines: modeLines,
          placement: "aboveEditor",
        },
        { kind: "widget-clear", key: TODO_WIDGET_KEY },
      ],
      todoWidgetPresent: false,
    });
  });

  it("有 todo：status → mode widget → 完整列表（一次，不 seed、不发 status）", () => {
    const full = todoLines(6);
    expect(
      decidePlanModeUi(tuiInput({ content: { todoLines: full } })),
    ).toEqual({
      emissions: [
        { kind: "status", key: STATUS_KEY, text: undefined },
        {
          kind: "widget",
          key: MODE_WIDGET_KEY,
          lines: modeLines,
          placement: "aboveEditor",
        },
        {
          kind: "widget",
          key: TODO_WIDGET_KEY,
          lines: full,
          placement: "belowEditor",
        },
      ],
      todoWidgetPresent: true,
    });
  });

  it("给了 statusText 也不会在内容可见的宿主发出去", () => {
    const decision = decidePlanModeUi(
      tuiInput({
        content: { statusText, todoLines: todoLines(2) },
      }),
    );
    expect(decision.emissions[0]).toEqual({
      kind: "status",
      key: STATUS_KEY,
      text: undefined,
    });
  });
});
