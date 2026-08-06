import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  buildAgentArgs,
  buildAgentName,
  buildPlaceholderData,
  FORK_PANEL_CUSTOM_TYPE,
  FORK_PANEL_LABEL,
  findOwnPlaceholder,
  isForkBranchTarget,
  parseForkPanelArgs,
  refreshSafetyCheck,
  shouldBlockTreeNavigation,
  splitPlanForTab,
  summarizePrompt,
} from "./core.ts";

describe("parseForkPanelArgs", () => {
  it("普通参数全部拼为 prompt", () => {
    expect(parseForkPanelArgs(["审查", "这个", "设计"])).toEqual({
      prompt: "审查 这个 设计",
    });
  });

  it("首 token 为 --model 时解析模型，其余拼 prompt", () => {
    expect(
      parseForkPanelArgs([
        "--model",
        "openai-codex/gpt-5.6-terra",
        "跑",
        "调研",
      ]),
    ).toEqual({
      model: "openai-codex/gpt-5.6-terra",
      prompt: "跑 调研",
    });
  });

  it("只有 --model 没有 prompt 时 prompt 为空字符串", () => {
    expect(parseForkPanelArgs(["--model", "x/y"])).toEqual({
      model: "x/y",
      prompt: "",
    });
  });

  it("空参数 prompt 为空", () => {
    expect(parseForkPanelArgs([])).toEqual({ prompt: "" });
  });

  it("prompt 内部含 --model 字样不被误解析（非首 token）", () => {
    expect(parseForkPanelArgs(["对比", "--model", "A", "和", "B"])).toEqual({
      prompt: "对比 --model A 和 B",
    });
  });
});

describe("summarizePrompt", () => {
  it("短 prompt 原样返回", () => {
    expect(summarizePrompt("grill me")).toBe("grill me");
  });

  it("长 prompt 折叠空白并截断", () => {
    const long = `第一行\n\n  第二行  第三行${"x".repeat(100)}`;
    const s = summarizePrompt(long, 20);
    expect(s.length).toBeLessThanOrEqual(20);
    expect(s.endsWith("…")).toBe(true);
    expect(s).not.toContain("\n");
  });

  it("默认最大长度 40", () => {
    const s = summarizePrompt("y".repeat(80));
    expect(s).toBe(`${"y".repeat(39)}…`);
  });
});

describe("buildPlaceholderData", () => {
  it("包含 prompt、摘要与可选模型", () => {
    const data = buildPlaceholderData({
      prompt: "用 grill-me 流程审查这个设计",
      model: "m/x",
      createdAt: "2026-08-06T00:00:00.000Z",
    });
    expect(data).toEqual({
      version: 1,
      prompt: "用 grill-me 流程审查这个设计",
      promptSummary: "用 grill-me 流程审查这个设计",
      model: "m/x",
      createdAt: "2026-08-06T00:00:00.000Z",
    });
  });

  it("无模型时省略 model 字段", () => {
    const data = buildPlaceholderData({
      prompt: "hi",
      createdAt: "t",
    });
    expect("model" in data).toBe(false);
  });

  it("customType 常量正确", () => {
    expect(FORK_PANEL_CUSTOM_TYPE).toBe("fork-panel");
    expect(FORK_PANEL_LABEL).toBe("fork-panel");
  });
});

describe("splitPlanForTab", () => {
  it("1 个 pane → 右侧 split 该 pane", () => {
    expect(splitPlanForTab([{ paneId: "p1", x: 0 }])).toEqual({
      direction: "right",
      targetPaneId: "p1",
    });
  });

  it("2 个 pane → 对最右侧（x 最大）向下 split", () => {
    expect(
      splitPlanForTab([
        { paneId: "p1", x: 0 },
        { paneId: "p2", x: 120 },
      ]),
    ).toEqual({ direction: "down", targetPaneId: "p2" });
  });

  it("3 个 pane → 仍对最右侧向下 split", () => {
    expect(
      splitPlanForTab([
        { paneId: "p1", x: 0 },
        { paneId: "p2", x: 120 },
        { paneId: "p3", x: 60 },
      ]),
    ).toEqual({ direction: "down", targetPaneId: "p2" });
  });

  it("无 pane → 报错", () => {
    expect(() => splitPlanForTab([])).toThrow("没有可用的 pane");
  });
});

describe("isForkBranchTarget", () => {
  // 树：a → b → c；c → d1（旧分支），c → p（占位）→ d2（panel 分支）
  const parents = new Map<string, string | null>([
    ["a", null],
    ["b", "a"],
    ["c", "b"],
    ["d1", "c"],
    ["p", "c"],
    ["d2", "p"],
  ]);
  const parentOf = (id: string) => parents.get(id);

  it("目标在 panel 分支（占位节点后代）→ true", () => {
    expect(isForkBranchTarget("d2", new Set(["p"]), parentOf)).toBe(true);
  });

  it("目标就是占位节点 → true", () => {
    expect(isForkBranchTarget("p", new Set(["p"]), parentOf)).toBe(true);
  });

  it("目标在旧分支 → false", () => {
    expect(isForkBranchTarget("d1", new Set(["p"]), parentOf)).toBe(false);
    expect(isForkBranchTarget("c", new Set(["p"]), parentOf)).toBe(false);
    expect(isForkBranchTarget("a", new Set(["p"]), parentOf)).toBe(false);
  });

  it("未知 id（parentOf 返回 undefined）→ false 不崩溃", () => {
    expect(isForkBranchTarget("nope", new Set(["p"]), parentOf)).toBe(false);
  });

  it("多个占位节点任一命中即 true", () => {
    expect(isForkBranchTarget("d2", new Set(["p", "p2"]), parentOf)).toBe(true);
  });

  it("无占位节点 → 恒 false", () => {
    expect(isForkBranchTarget("d2", new Set(), parentOf)).toBe(false);
  });
});

describe("findOwnPlaceholder", () => {
  // 树：a → b → c → d；c → p（占位）→ e → f（panel leaf）
  const parents = new Map<string, string | null>([
    ["a", null],
    ["b", "a"],
    ["c", "b"],
    ["d", "c"],
    ["p", "c"],
    ["e", "p"],
    ["f", "e"],
  ]);
  const parentOf = (id: string) => parents.get(id);
  const isPlaceholder = (id: string) => id === "p";

  it("从 panel leaf 向上找到分叉起点", () => {
    expect(findOwnPlaceholder("f", isPlaceholder, parentOf)).toBe("p");
    expect(findOwnPlaceholder("e", isPlaceholder, parentOf)).toBe("p");
    expect(findOwnPlaceholder("p", isPlaceholder, parentOf)).toBe("p");
  });

  it("旧分支 leaf 向上找不到占位节点", () => {
    expect(findOwnPlaceholder("d", isPlaceholder, parentOf)).toBeUndefined();
    expect(findOwnPlaceholder("c", isPlaceholder, parentOf)).toBeUndefined();
  });

  it("leaf 为 null（空会话）→ undefined", () => {
    expect(findOwnPlaceholder(null, isPlaceholder, parentOf)).toBeUndefined();
  });
});

describe("shouldBlockTreeNavigation", () => {
  // 树：a → b → c；c → d1（旧分支），c → p（占位）→ d2（panel 分支）
  const parents = new Map<string, string | null>([
    ["a", null],
    ["b", "a"],
    ["c", "b"],
    ["d1", "c"],
    ["p", "c"],
    ["d2", "p"],
  ]);
  const parentOf = (id: string) => parents.get(id);
  const placeholders = new Set(["p"]);
  const base = { placeholderIds: placeholders, parentOf };

  it("无占位节点 → 不拦截", () => {
    expect(
      shouldBlockTreeNavigation({
        ...base,
        targetId: "d2",
        placeholderIds: new Set(),
      }),
    ).toBe(false);
  });

  it("旧 session 角色：目标是 panel 分支 → 拦截", () => {
    expect(shouldBlockTreeNavigation({ ...base, targetId: "d2" })).toBe(true);
    expect(shouldBlockTreeNavigation({ ...base, targetId: "p" })).toBe(true);
  });

  it("旧 session 角色：目标在旧分支 → 不拦截", () => {
    expect(shouldBlockTreeNavigation({ ...base, targetId: "d1" })).toBe(false);
    expect(shouldBlockTreeNavigation({ ...base, targetId: "c" })).toBe(false);
  });

  it("panel 角色：目标在自己分支内 → 不拦截", () => {
    expect(
      shouldBlockTreeNavigation({
        ...base,
        ownPlaceholderId: "p",
        targetId: "d2",
      }),
    ).toBe(false);
    expect(
      shouldBlockTreeNavigation({
        ...base,
        ownPlaceholderId: "p",
        targetId: "p",
      }),
    ).toBe(false);
  });

  it("panel 角色：目标在旧分支（占位祖先链外）→ 拦截", () => {
    expect(
      shouldBlockTreeNavigation({
        ...base,
        ownPlaceholderId: "p",
        targetId: "d1",
      }),
    ).toBe(true);
    expect(
      shouldBlockTreeNavigation({
        ...base,
        ownPlaceholderId: "p",
        targetId: "a",
      }),
    ).toBe(true);
  });
});

describe("refreshSafetyCheck", () => {
  const header = (version: number): FileEntry => ({
    type: "session",
    version,
    id: "uuid",
    timestamp: "t",
    cwd: "/tmp",
  });
  const entry = (id: string, parentId: string | null): FileEntry => ({
    type: "message",
    id,
    parentId,
    timestamp: "t",
    message: { role: "user", content: "x", timestamp: 1 },
  });

  it("v3 文件无重复 id → ok", () => {
    const entries = [header(3), entry("a", null), entry("b", "a")];
    expect(refreshSafetyCheck(entries)).toEqual({ ok: true });
  });

  it("版本不一致 → 跳过并说明原因", () => {
    const entries = [header(2), entry("a", null)];
    const r = refreshSafetyCheck(entries);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("版本");
  });

  it("重复 id → 跳过并说明原因", () => {
    const entries = [header(3), entry("a", null), entry("a", "b")];
    const r = refreshSafetyCheck(entries);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("重复 entry id");
  });

  it("无 header（异常文件）→ ok（交给 SessionManager 自行处理）", () => {
    const entries = [entry("a", null)];
    expect(refreshSafetyCheck(entries)).toEqual({ ok: true });
  });
});

describe("buildAgentName", () => {
  it("英文摘要 → slug", () => {
    expect(buildAgentName("Review the design", "fallback")).toBe(
      "review-the-design",
    );
  });

  it("中文摘要（无合法字符）→ fallback", () => {
    expect(buildAgentName("只回复四个字", "fork-panel-abc")).toBe(
      "fork-panel-abc",
    );
  });

  it("混合内容：非合法字符折叠为连字符", () => {
    expect(buildAgentName("Fork: 调查 Cache-层!", "fb")).toBe("fork-cache");
  });

  it("截断到 25 字符（预留唯一后缀空间）", () => {
    const s = buildAgentName("a".repeat(50), "fb");
    expect(s.length).toBeLessThanOrEqual(25);
  });
});

describe("buildAgentArgs", () => {
  it("含 --session 与 --name", () => {
    expect(
      buildAgentArgs({ sessionFile: "/tmp/s.jsonl", name: "Fork: x" }),
    ).toEqual(["--session", "/tmp/s.jsonl", "--name", "Fork: x"]);
  });

  it("含模型时追加 --model", () => {
    expect(
      buildAgentArgs({
        sessionFile: "/tmp/s.jsonl",
        name: "Fork: x",
        model: "m/y",
      }),
    ).toEqual([
      "--session",
      "/tmp/s.jsonl",
      "--name",
      "Fork: x",
      "--model",
      "m/y",
    ]);
  });
});
