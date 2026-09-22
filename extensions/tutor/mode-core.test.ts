/**
 * mode-core 单测：全部 value in / value out —— 给字符串/条目/active 列表，
 * 断言 mode、目标工具集、命令决策、status 文案。不 mock、不落盘。
 */

import { describe, expect, it } from "vitest";
import {
  detectTutorCommand,
  detectTutorSkill,
  formatTutorModeStatus,
  parseTutorModeCommand,
  planToolSync,
  restoreTutorMode,
} from "./mode-core.ts";
import { TUTOR_SESSION_TOOL_NAMES } from "./names.ts";

const skillBlock = (name: string) =>
  `<skill name="${name}" location="/Users/x/skills/${name}/SKILL.md">\n# ${name}\n</skill>`;

describe("mode-core / detectTutorSkill", () => {
  it("hits only when the expanded skill block opens the prompt", () => {
    const cases: Array<[string, string, boolean]> = [
      ["bare block", skillBlock("tutor"), true],
      ["block with args", `${skillBlock("tutor")}\n\n分布式共识`, true],
      ["leading whitespace", `\n\n   ${skillBlock("tutor")}`, true],
      ["another skill", skillBlock("teach"), false],
      ["similar name", skillBlock("tutor-lite"), false],
      ["mentioned mid-prompt", `先说一句\n${skillBlock("tutor")}`, false],
      ["empty", "", false],
      ["plain text", "教我 tutor 相关的东西", false],
    ];
    for (const [label, prompt, expected] of cases) {
      expect(detectTutorSkill(prompt), label).toBe(expected);
    }
  });
});

describe("mode-core / detectTutorCommand", () => {
  it("recognises the raw /skill:tutor command only", () => {
    const cases: Array<[string, string, boolean]> = [
      ["no args", "/skill:tutor", true],
      ["with args", "/skill:tutor Docker实现", true],
      ["leading space and tab", "  /skill:tutor\tMySQL", true],
      ["longer name", "/skill:tutorx", false],
      ["other skill", "/skill:teach", false],
      ["not at the start", "说 /skill:tutor", false],
      ["extension command", "/tutor-mode on", false],
      ["empty", "", false],
    ];
    for (const [label, text, expected] of cases) {
      expect(detectTutorCommand(text), label).toBe(expected);
    }
  });
});

describe("mode-core / restoreTutorMode", () => {
  const modeEntry = (active: boolean) => ({
    type: "custom",
    customType: "tutor-mode",
    data: { active },
  });
  const userMessage = (text: string) => ({
    type: "message",
    message: { role: "user", content: [{ type: "text", text }] },
  });

  it("defaults to off without any signal", () => {
    expect(restoreTutorMode([])).toBe("off");
    expect(
      restoreTutorMode([
        { type: "custom", customType: "tutor-notes", data: { file: "/x.md" } },
        userMessage("帮我改一下这个扩展"),
      ]),
    ).toBe("off");
  });

  it("lets the last explicit tutor-mode entry win", () => {
    expect(restoreTutorMode([modeEntry(true)])).toBe("on");
    expect(restoreTutorMode([modeEntry(true), modeEntry(false)])).toBe("off");
    expect(restoreTutorMode([modeEntry(false), modeEntry(true)])).toBe("on");
  });

  it("ignores entries whose payload it cannot read", () => {
    expect(
      restoreTutorMode([{ type: "custom", customType: "tutor-mode" }]),
    ).toBe("off");
    expect(
      restoreTutorMode([
        { type: "custom", customType: "tutor-mode", data: { active: "yes" } },
      ]),
    ).toBe("off");
  });

  it("falls back to the transcript when there is no entry", () => {
    expect(restoreTutorMode([userMessage(skillBlock("tutor"))])).toBe("on");
    expect(
      restoreTutorMode([
        userMessage("先聊点别的"),
        userMessage(skillBlock("tutor")),
        userMessage("继续"),
      ]),
    ).toBe("on");
    expect(
      restoreTutorMode([
        {
          type: "message",
          message: { role: "user", content: skillBlock("tutor") },
        },
      ]),
    ).toBe("on");
  });

  it("counts only user messages", () => {
    expect(
      restoreTutorMode([
        {
          type: "message",
          message: { role: "assistant", content: skillBlock("tutor") },
        },
        {
          type: "message",
          message: { role: "custom", content: skillBlock("tutor") },
        },
      ]),
    ).toBe("off");
  });

  it("lets an explicit entry overrule the transcript", () => {
    expect(
      restoreTutorMode([userMessage(skillBlock("tutor")), modeEntry(false)]),
    ).toBe("off");
    expect(restoreTutorMode([modeEntry(true)])).toBe("on");
  });
});

describe("mode-core / planToolSync", () => {
  const all = [...TUTOR_SESSION_TOOL_NAMES];

  it("removes every tutor-session tool when off and keeps the rest in order", () => {
    expect(
      planToolSync(["read", "quiz", "rg", "ask_user_question"], "off"),
    ).toEqual({
      tools: ["read", "rg"],
      changed: true,
    });
    expect(planToolSync(["read", "rg", "bash"], "off")).toEqual({
      tools: ["read", "rg", "bash"],
      changed: false,
    });
  });

  it("adds the tutor-session tools when on", () => {
    expect(planToolSync(["read", "rg"], "on")).toEqual({
      tools: ["read", "rg", ...all],
      changed: true,
    });
    expect(planToolSync(["read", "rg", ...all], "on")).toEqual({
      tools: ["read", "rg", ...all],
      changed: false,
    });
  });

  it("re-appends gated tools that sat in the middle", () => {
    expect(planToolSync(["read", "quiz", "rg"], "on").tools).toEqual([
      "read",
      "rg",
      ...all,
    ]);
  });
});

describe("mode-core / parseTutorModeCommand", () => {
  it("parses on / off / status and rejects the rest", () => {
    const cases: Array<[string, unknown]> = [
      ["", { kind: "status" }],
      ["   ", { kind: "status" }],
      ["status", { kind: "status" }],
      ["on", { kind: "on" }],
      ["OFF", { kind: "off" }],
      [" On ", { kind: "on" }],
      ["plan", { kind: "invalid", value: "plan" }],
      ["enable", { kind: "invalid", value: "enable" }],
    ];
    for (const [args, expected] of cases) {
      expect(parseTutorModeCommand(args), args).toEqual(expected);
    }
  });
});

describe("mode-core / formatTutorModeStatus", () => {
  it("reports the real visibility of every gated tool", () => {
    const all = [...TUTOR_SESSION_TOOL_NAMES];
    const onAll = formatTutorModeStatus("on", ["read", ...all]);
    expect(onAll).toContain("tutor 会话：on");
    expect(onAll).toContain("5/5");
    expect(onAll).not.toContain("缺：");

    const onPartial = formatTutorModeStatus("on", ["read", "quiz"]);
    expect(onPartial).toContain("1/5");
    expect(onPartial).toContain("缺：ask_user_question、bind_notes");

    const off = formatTutorModeStatus("off", ["read", "rg"]);
    expect(off).toContain("tutor 会话：off");
    expect(off).toContain("0/5");
    expect(off).toContain("/tutor-mode");
  });
});
