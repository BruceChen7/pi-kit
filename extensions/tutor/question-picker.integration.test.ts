/**
 * `ask_user_question` / `quiz` 的 picker 输入回归门。
 *
 * 事故：这两个 UI 与 md-topic 的 picker 共用 `renderPickerLines`，于是也渲染出
 * `Search: type to filter...`，但**没有任何文本处理**（打字毫无反应），而且没有
 * 实现 `Focusable`（不发 CURSOR_MARKER，IME 落不到框里）。用户原话：「quiz widget 没法输入」。
 *
 * 守住的契约：
 *   打字真的能过滤；enter / space 作用在**过滤后**的那一行；
 *   搜索框发 CURSOR_MARKER（IME / 硬件光标定位）。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { runAsk } from "./ask-ui.ts";
import { runQuiz } from "./quiz-ui.ts";

type Component = {
  focused: boolean;
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
};

const ASK_OPTIONS = [
  { label: "路线一", value: "a1" },
  { label: "路线二", value: "a2" },
];

const QUIZ_OPTIONS = [
  { label: "选项一", value: "q1" },
  { label: "选项二", value: "q2" },
];

/** 假 ctx.ui：捕获上屏组件，让测试按键驱动它。 */
const capture = () => {
  const components: Component[] = [];
  const ctx = {
    hasUI: true,
    ui: {
      custom: (
        factory: (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (value: unknown) => void,
        ) => Component,
      ) =>
        new Promise((resolve) => {
          let settled = false;
          const done = (value: unknown): void => {
            if (settled) return;
            settled = true;
            resolve(value);
          };
          components.push(factory({ requestRender: () => {} }, {}, {}, done));
        }),
      input: async () => "自由文本",
      notify: () => {},
    },
  } as unknown as ExtensionContext;
  return { ctx, components };
};

/** ui-gate 把上屏推迟到微任务，等组件出现。 */
const onScreen = async (components: Component[]): Promise<Component> => {
  for (let i = 0; i < 100; i++) {
    const component = components[0];
    if (component) return component;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("picker 没有上屏");
};

describe("ask / quiz picker 的文本输入", () => {
  it("ask：打字过滤后 enter 作答的是过滤后的那一行", async () => {
    const { ctx, components } = capture();
    const run = runAsk(ctx, {
      question: "选哪条路线？",
      options: ASK_OPTIONS,
      mode: "single-select",
    });
    const component = await onScreen(components);

    component.handleInput("二"); // 过滤到「路线二」
    component.handleInput("\r");

    // 不过滤的话 enter 会落在光标行（路线一 = ask:0）
    expect(await run).toEqual({ kind: "answered", selectedIds: ["ask:1"] });
  });

  it("quiz：打字过滤 + enter 勾选过滤后的行 + 退格清过滤 + enter 提交", async () => {
    const { ctx, components } = capture();
    const run = runQuiz(ctx, {
      question: "选哪些？",
      options: QUIZ_OPTIONS,
      mode: "multi-select",
    });
    const component = await onScreen(components);

    component.handleInput("二"); // 过滤到「选项二」
    component.handleInput("\r"); // enter 也能勾选（多选）
    component.handleInput("\u007f"); // 退格清掉过滤，回到 [选项一, 选项二, I don't know, Submit]
    component.handleInput("\u001b[B"); // ↓ ×3 → Submit
    component.handleInput("\u001b[B");
    component.handleInput("\u001b[B");
    component.handleInput("\r");

    expect(await run).toEqual({
      kind: "answered",
      selectedValues: ["q2"],
      dontKnow: false,
    });
  });

  it("quiz：搜索框为空时空格仍是勾选键", async () => {
    const { ctx, components } = capture();
    const run = runQuiz(ctx, {
      question: "选哪些？",
      options: QUIZ_OPTIONS,
      mode: "multi-select",
    });
    const component = await onScreen(components);

    component.handleInput(" "); // 空 query ⇒ 勾选光标行（选项一）
    component.handleInput("\u001b[B"); // ↓ ×3 → Submit
    component.handleInput("\u001b[B");
    component.handleInput("\u001b[B");
    component.handleInput("\r");

    expect(await run).toEqual({
      kind: "answered",
      selectedValues: ["q1"],
      dontKnow: false,
    });
  });

  it("多选：query 非空时空格进搜索框（带空格的标签搜得到）——quiz 与 ask", async () => {
    const spaced = [
      { label: "raft 共识", value: "q1" },
      { label: "paxos 共识", value: "q2" },
    ];
    const typed = ["r", "a", "f", "t", " ", "共"];

    const quiz = capture();
    const quizRun = runQuiz(quiz.ctx, {
      question: "选哪些？",
      options: spaced,
      mode: "multi-select",
    });
    const quizComponent = await onScreen(quiz.components);
    for (const key of typed) quizComponent.handleInput(key);

    // 空格当文本 ⇒ query = "raft 共" ⇒ 只剩「raft 共识」；
    // 若空格被当勾选键，query 会是 "raft共" ⇒ 一行都不剩（搜索框成了空头支票）。
    const quizLines = quizComponent.render(60).join("\n");
    expect(quizLines).toContain("raft 共识");
    expect(quizLines).not.toContain("paxos 共识");
    quizComponent.handleInput("\u001b");
    expect(await quizRun).toEqual({ kind: "cancelled" });

    const ask = capture();
    const askRun = runAsk(ask.ctx, {
      question: "选哪条路线？",
      options: spaced,
      mode: "multi-select",
    });
    const askComponent = await onScreen(ask.components);
    for (const key of typed) askComponent.handleInput(key);

    const askLines = askComponent.render(60).join("\n");
    expect(askLines).toContain("raft 共识");
    expect(askLines).not.toContain("paxos 共识");
    askComponent.handleInput("\u001b");
    expect(await askRun).toEqual({ kind: "cancelled" });
  });

  it("quiz：esc 取消（Kitty 编码也认）", async () => {
    const { ctx, components } = capture();
    const run = runQuiz(ctx, {
      question: "选哪个？",
      options: QUIZ_OPTIONS,
      mode: "single-select",
    });
    const component = await onScreen(components);

    component.handleInput("\u001b[27u");

    expect(await run).toEqual({ kind: "cancelled" });
  });

  it("ask / quiz 的搜索框都发 CURSOR_MARKER（IME 才落得到框里）", async () => {
    // 闸门同一时刻只允许一个模态上屏：先结算 ask，再起 quiz。
    const ask = capture();
    const askRun = runAsk(ask.ctx, {
      question: "选哪条路线？",
      options: ASK_OPTIONS,
      mode: "single-select",
    });
    const askComponent = await onScreen(ask.components);
    expect(askComponent.render(60).join("\n")).toContain(CURSOR_MARKER);
    askComponent.handleInput("\u001b");
    expect((await askRun).kind).toBe("cancelled");

    const quiz = capture();
    const quizRun = runQuiz(quiz.ctx, {
      question: "选哪个？",
      options: QUIZ_OPTIONS,
      mode: "single-select",
    });
    const quizComponent = await onScreen(quiz.components);
    expect(quizComponent.render(60).join("\n")).toContain(CURSOR_MARKER);
    quizComponent.handleInput("\u001b");
    expect((await quizRun).kind).toBe("cancelled");
  });
});
