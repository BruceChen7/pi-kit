/**
 * ui-gate 的行为测试：只断言「看得见的效果」——执行顺序、是否重叠、
 * 异常是否照常透传、队列会不会被前一个的失败卡住。
 */

import { describe, expect, it } from "vitest";
import { createUiGate } from "./ui-gate.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("ui-gate", () => {
  it("按提交顺序串行执行，绝不重叠", async () => {
    const gate = createUiGate();
    const events: string[] = [];

    const task = (name: string, holdMs: number) => async () => {
      events.push(`enter:${name}`);
      await sleep(holdMs);
      events.push(`exit:${name}`);
      return name;
    };

    // 后提交的 hold 更短：若真并行，exit:b 会插到 exit:a 前面。
    const results = await Promise.all([
      gate.run(task("a", 30)),
      gate.run(task("b", 5)),
      gate.run(task("c", 5)),
    ]);

    expect(results).toEqual(["a", "b", "c"]);
    expect(events).toEqual([
      "enter:a",
      "exit:a",
      "enter:b",
      "exit:b",
      "enter:c",
      "exit:c",
    ]);
  });

  it("前一个失败不影响后面的排队者，异常原样给调用方", async () => {
    const gate = createUiGate();
    const boom = new Error("前一个弹窗炸了");

    const failing = gate.run(async () => {
      throw boom;
    });
    const following = gate.run(async () => "ok");

    await expect(failing).rejects.toBe(boom);
    await expect(following).resolves.toBe("ok");
  });

  it("递归进闸（自己等自己）立刻报错，之后闸门仍可用", async () => {
    const gate = createUiGate();

    const nested = gate.run(async () => {
      await gate.run(async () => "inner");
      return "outer";
    });

    await expect(nested).rejects.toThrow(/不可嵌套/);
    await expect(gate.run(async () => "after")).resolves.toBe("after");
  });
});
