/**
 * ui-gate — 独占终端 UI 的串行闸门（Functional Core + 一个模块级单例）。
 *
 * 背景：pi 默认并行执行同一条 assistant 消息里的多个 tool call
 * （pi-agent-core：`toolExecution ?? "parallel"`，最后 `Promise.all` 收尾）。而
 * `ctx.ui.custom()` 在非 overlay 模式下独占编辑器槽位：后一次调用会把前一个组件
 * 从组件树上摘掉（pi-coding-agent 的 interactive-mode `showExtensionCustom`：
 * `editorContainer.clear()` + `setFocus(新组件)`）。被摘掉的组件再也收不到按键，
 * 它的 `done()` 不会被调用 —— 那个 tool call 永不返回，整个 turn 卡在 `Promise.all`。
 *
 * 这里把「一次只有一个模态在屏幕上」做成可复用的闸门：task 按提交顺序排队，
 * 前一个 settle（成功或失败）后下一个才上屏。纯 Promise 编排，不懂 UI。
 */

export type UiGate = {
  /**
   * 排队执行一段独占 UI 的代码。同一时刻最多一个 task 在跑，
   * 顺序 = 提交顺序（FIFO），结果与异常原样透传给调用方。
   */
  run: <T>(task: () => Promise<T>) => Promise<T>;
};

const NESTED_ERROR =
  "ui-gate: 同一个闸门不可嵌套调用（排队中的 task 必须等前一个出闸后才上屏）";

export const createUiGate = (): UiGate => {
  // tail 始终是「已吞掉异常」的 Promise，所以下一个人永远能轮到。
  let tail: Promise<unknown> = Promise.resolve();
  /** 正在上屏的 task 数：>0 说明有模态已经在屏幕上。 */
  let onScreen = 0;

  const enter = async <T>(task: () => Promise<T>): Promise<T> => {
    onScreen += 1;
    try {
      return await task();
    } finally {
      onScreen -= 1;
    }
  };

  const run = <T>(task: () => Promise<T>): Promise<T> => {
    if (onScreen > 0) {
      // 自己等自己必然死锁：宁可立刻报错，也不静默挂住整个 turn。
      return Promise.reject(new Error(NESTED_ERROR));
    }
    const turn = tail.then(() => enter(task));
    tail = turn.catch(() => undefined);
    return turn;
  };

  return { run };
};

/**
 * 进程级单例：终端上只有一块编辑器槽位，所以串行必须跨扩展生效 ——
 * 谁接了这道闸门，谁就和别人互斥，而不是只和自己互斥。
 */
export const sharedUiGate: UiGate = createUiGate();
