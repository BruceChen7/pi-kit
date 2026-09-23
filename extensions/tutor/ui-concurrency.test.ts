/**
 * 并发提问的回归门：同一批里的两个「独占终端 UI」工具必须都能返回。
 *
 * 事故（真实发生两次）：一条 assistant 消息里同时发 `quiz` + `ask_user_question`。
 * pi 默认并行执行同批 tool call（pi-agent-core `executeToolCallsParallel` → `Promise.all`），
 * 而非 overlay 的 `ctx.ui.custom()` 会独占编辑器槽位：后一次调用把前一个组件从树上摘掉
 * （pi-coding-agent interactive-mode `showExtensionCustom`：`editorContainer.clear()` +
 * `setFocus(新组件)`）。被摘掉的组件再也收不到按键 → 它的 `done()` 不触发 →
 * 那个 tool call 永不返回 → 整个 turn 卡死，学习者的答案只留在笔记里。
 *
 * 下面的 FakeTerminal 按这个语义实现：新组件上屏时，还活着的旧组件会被摘下，
 * 摘下的组件按键不达、`done()` 无效。`clobbers` 记录「被摘掉时还活着」的次数。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { runAsk } from "./ask-ui.ts";
import { runQuiz } from "./quiz-ui.ts";

type Component = {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
};

type Slot = {
  settled: boolean;
  detached: boolean;
  component?: Component;
};

class FakeTerminal {
  readonly slots: Slot[] = [];
  /** 每次上屏时渲染出来的首行，用来断言「屏幕上先后出现过谁」。 */
  readonly onScreen: string[] = [];
  attached: Slot | null = null;
  /** 「被摘掉时还活着」的次数：>0 就是事故本身。 */
  clobbers = 0;

  custom<T>(
    factory: (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
      done: (value: T) => void,
    ) => Component,
  ): Promise<T> {
    return new Promise<T>((resolve) => {
      // pi 的非 overlay 分支：清空组件树 → 旧组件再也收不到按键
      if (this.attached && !this.attached.settled) {
        this.clobbers += 1;
        this.attached.detached = true;
      }
      const slot: Slot = { settled: false, detached: false };
      this.attached = slot;
      this.slots.push(slot);

      const settle = (value: T): void => {
        if (slot.settled || slot.detached) return;
        slot.settled = true;
        resolve(value);
      };
      slot.component = factory(
        { requestRender: () => {} },
        {} as never,
        {} as never,
        settle as (value: unknown) => void,
      );
      this.onScreen.push(slot.component.render(80)[0] ?? "");
    });
  }

  /** 按键只送到当前挂在屏幕上的那个组件。 */
  press(data: string): void {
    this.attached?.component?.handleInput(data);
  }
}

const ctxFor = (terminal: FakeTerminal): ExtensionContext =>
  ({
    hasUI: true,
    ui: {
      custom: (factory: never) => terminal.custom(factory as never),
      input: async () => "自定义答案",
      notify: () => {},
    },
  }) as unknown as ExtensionContext;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 模拟学习者：屏幕上有提问就一直按回车作答，直到所有提问都返回或超时。
 * 超时不抛错 —— 让断言以「有提问没返回」的形式失败，而不是把测试挂住。
 */
const answerOnScreenUntilSettled = async (
  terminal: FakeTerminal,
  pending: Promise<unknown>[],
  deadlineMs: number,
): Promise<boolean> => {
  let allSettled = false;
  void Promise.all(pending.map((p) => p.catch(() => undefined))).then(() => {
    allSettled = true;
  });
  const started = Date.now();
  while (!allSettled && Date.now() - started < deadlineMs) {
    await sleep(5);
    terminal.press("\r");
  }
  return allSettled;
};

const QUIZ_OPTIONS = [
  { label: "选项一", value: "q1" },
  { label: "选项二", value: "q2" },
];

const ASK_OPTIONS = [
  { label: "路线一", value: "a1" },
  { label: "路线二", value: "a2" },
];

describe("同批并行的两个提问", () => {
  it("两个都返回：后者排队，等前者出闸后才上屏", async () => {
    const terminal = new FakeTerminal();

    const answers: Array<[string, unknown]> = [];
    const quizRun = runQuiz(ctxFor(terminal), {
      question: "第一问",
      options: QUIZ_OPTIONS,
      mode: "single-select",
    }).then((result) => {
      answers.push(["quiz", result]);
      return result;
    });
    const askRun = runAsk(ctxFor(terminal), {
      question: "第二问",
      options: ASK_OPTIONS,
      mode: "single-select",
    }).then((result) => {
      answers.push(["ask", result]);
      return result;
    });

    const allSettled = await answerOnScreenUntilSettled(
      terminal,
      [quizRun, askRun],
      1000,
    );

    expect(
      allSettled,
      "有提问没有返回：屏幕上还活着的组件被后来的提问摘掉了",
    ).toBe(true);
    expect(terminal.clobbers).toBe(0);
    // 上屏顺序 = 提交顺序；两个提问各拿到自己的答案
    expect(terminal.onScreen).toHaveLength(2);
    expect(terminal.onScreen[0]).toContain("第一问");
    expect(terminal.onScreen[1]).toContain("第二问");
    expect(answers).toEqual([
      ["quiz", { kind: "answered", selectedValues: ["q1"], dontKnow: false }],
      // picker 按行 id 作答：第一行就是 ask:0（见 ask-core.askRowId）
      ["ask", { kind: "answered", selectedIds: ["ask:0"] }],
    ]);
  });

  it("单独一个提问照常返回（对照组）", async () => {
    const terminal = new FakeTerminal();

    const askRun = runAsk(ctxFor(terminal), {
      question: "这轮想拿到什么？",
      options: ASK_OPTIONS,
      mode: "single-select",
    });
    const settled = await answerOnScreenUntilSettled(terminal, [askRun], 500);

    expect(settled).toBe(true);
    expect(terminal.clobbers).toBe(0);
    await expect(askRun).resolves.toEqual({
      kind: "answered",
      selectedIds: ["ask:0"],
    });
  });
});
