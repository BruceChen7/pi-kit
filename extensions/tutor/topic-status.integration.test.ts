/**
 * topic-status 集成测试（Shell：只读工具 + 首轮注入）。
 *
 * 契约：
 * - `topic_status` 只读，且**不做近似匹配**（查不到就报现有章节，让人去选）；
 * - 首轮注入每会话恰一次，只在「本会话绑了 vault 内的笔记」或「这轮是 tutor skill」时发生。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOPIC_STATUS_TOOL_NAME } from "./names.ts";
import { registerTopicStatus } from "./topic-status.ts";

type ToolExecute = (
  id: string,
  params: unknown,
  signal: unknown,
  onUpdate: unknown,
  ctx: never,
) => Promise<{
  content: Array<{ text?: string }>;
  details?: Record<string, unknown>;
  isError: boolean;
}>;

let root: string;
let vault: string;
let cwd: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tutor-topic-status-"));
  vault = path.join(root, "vault");
  cwd = path.join(root, "cwd");
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".pi", "third_extension_settings.json"),
    JSON.stringify({ tutor: { vaultRoot: vault, topDir: "Learn" } }),
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const topicDir = (topic: string): string => path.join(vault, "Learn", topic);

const seedTopic = (topic: string, chapters: string[]): string[] => {
  const dir = topicDir(topic);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${topic}.md`), `# ${topic}\n`);
  return chapters.map((name, index) => {
    const file = path.join(
      dir,
      `${String(index + 1).padStart(2, "0")}-${name}.md`,
    );
    fs.writeFileSync(file, `# 第${index + 1}章 · ${name}\n`);
    return file;
  });
};

const boundEntry = (file: string, chapter: string | null = null) => ({
  type: "custom",
  customType: "tutor-notes",
  data: { file, chapter },
});

const skillPrompt = (args = "") =>
  `<skill name="tutor" location="/x/SKILL.md">\n# Tutor\n</skill>${args ? `\n\n${args}` : ""}`;

type Harness = {
  status: (
    params: { topic?: string; chapter?: string },
    sessionEntries?: readonly unknown[],
  ) => Promise<Awaited<ReturnType<ToolExecute>>>;
  turn: (prompt: string, entries?: readonly unknown[]) => Promise<unknown[]>;
  sessionStart: (entries?: readonly unknown[]) => Promise<void>;
  entries: Array<{ customType: string; data: unknown }>;
};

const setup = (): Harness => {
  const tools = new Map<string, { execute: ToolExecute }>();
  const handlers = new Map<
    string,
    Array<(event: never, ctx: never) => unknown>
  >();
  const entries: Array<{ customType: string; data: unknown }> = [];
  registerTopicStatus({
    registerTool: (tool: { name: string }) =>
      tools.set(tool.name, tool as unknown as { execute: ToolExecute }),
    on: (event: string, handler: (event: never, ctx: never) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ customType, data });
    },
  } as never);

  const ctx = (sessionEntries: readonly unknown[]) =>
    ({
      cwd,
      sessionManager: { getEntries: () => [...sessionEntries] },
      ui: { notify: vi.fn(), setStatus: vi.fn() },
    }) as never;

  const tool = tools.get(TOPIC_STATUS_TOOL_NAME);
  if (!tool) throw new Error(`${TOPIC_STATUS_TOOL_NAME} 未注册`);

  return {
    status: (params, sessionEntries = []) =>
      tool.execute("call-1", params, undefined, undefined, ctx(sessionEntries)),
    sessionStart: async (sessionEntries = []) => {
      for (const handler of handlers.get("session_start") ?? []) {
        await handler({ type: "session_start" } as never, ctx(sessionEntries));
      }
    },
    turn: async (prompt, sessionEntries = []) => {
      const injected: unknown[] = [];
      for (const handler of handlers.get("before_agent_start") ?? []) {
        const result = await handler(
          { type: "before_agent_start", prompt } as never,
          ctx(sessionEntries),
        );
        if (result) injected.push(result);
      }
      return injected;
    },
    entries,
  };
};

const snapshot = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true, recursive: true })
        .map((entry) => `${entry.parentPath ?? ""}/${entry.name}`)
        .sort()
    : [];

const briefOf = (
  results: unknown[],
): { content: string; display: boolean } | undefined => {
  const hit = results.find(
    (result) =>
      (result as { message?: { customType?: string } }).message?.customType ===
      "tutor-brief",
  ) as { message: { content: string; display: boolean } } | undefined;
  return hit?.message;
};

describe("topic_status 工具", () => {
  it("无参：给 vault 概览 + 本会话绑定说明", async () => {
    seedTopic("redis高可用", ["四个动作", "收口三场景"]);
    seedTopic("Docker实现", ["重建地基"]);
    const h = setup();

    const result = await h.status({});

    const text = result.content[0]?.text ?? "";
    expect(result.isError).toBe(false);
    expect(text).toContain("本会话还没有绑定笔记");
    expect(text).toContain("redis高可用（2章");
    expect(text).toContain("Docker实现（1章");
  });

  it("有绑定：概览里带上绑定主题的简报（章节 / 续做 / 概念缺口）", async () => {
    const [chapter] = seedTopic("redis高可用", ["四个动作", "收口三场景"]);
    const h = setup();

    const result = await h.status({}, [boundEntry(chapter, "四个动作")]);

    const text = result.content[0]?.text ?? "";
    expect(result.details?.bound).toBe(chapter);
    expect(text).toContain(`本会话绑定：${chapter}`);
    expect(text).toContain("章节：第1章 · 四个动作（ok 0 / wrong 0 / gaps 0）");
    expect(text).toContain("续做：");
    expect(text).toContain("概念缺口：");
  });

  it("给主题：逐行简报 + 结构化 details（只读）", async () => {
    seedTopic("redis高可用", ["四个动作", "收口三场景"]);
    const h = setup();
    const before = snapshot(vault);

    const result = await h.status({ topic: "redis高可用" });

    const text = result.content[0]?.text ?? "";
    expect(text).toContain("《redis高可用》共 2 章");
    expect(text).toContain("章节：第1章 · 四个动作（ok 0 / wrong 0 / gaps 0）");
    expect(text).toContain("续做：");
    expect(text).toContain("概念缺口：");
    expect(result.details?.topic).toBe("redis高可用");
    expect(snapshot(vault)).toEqual(before);
  });

  it("给主题 + 章节：命中就给文件路径与标签；查不到就给现有章节，不做近似匹配", async () => {
    const files = seedTopic("redis高可用", ["四个动作", "收口三场景"]);
    const h = setup();

    const hit = await h.status({ topic: "redis高可用", chapter: "第2章" });
    expect(hit.content[0]?.text).toContain("当前章节：第2章 · 收口三场景");
    expect(hit.details?.path).toBe(files[1]);
    expect(hit.details?.chapter).toBe("收口三场景");

    const miss = await h.status({ topic: "redis高可用", chapter: "收口" });
    expect(miss.content[0]?.text).toContain("不做近似匹配");
    expect(miss.content[0]?.text).toContain("第1章 · 四个动作");
    expect(miss.details?.chapter).toBeNull();
  });

  it("主题不存在：报「还没有章节」，不落盘", async () => {
    const h = setup();
    const result = await h.status({ topic: "分布式共识" });

    expect(result.content[0]?.text).toContain("还没有章节");
    expect(fs.existsSync(path.join(vault, "Learn", "分布式共识"))).toBe(false);
  });
});

describe("topic-status 首轮注入", () => {
  it("已绑定：注入一次主题简报（display:false），后续轮次不再注入", async () => {
    const [chapter] = seedTopic("redis高可用", ["四个动作", "收口三场景"]);
    const h = setup();
    const entries = [boundEntry(chapter, "四个动作")];

    const first = await h.turn("继续", entries);
    const brief = briefOf(first);

    expect(brief).toBeDefined();
    expect(brief?.display).toBe(false);
    expect(brief?.content).toContain(
      "本会话已绑定《redis高可用》· 第1章 · 四个动作",
    );
    expect(brief?.content).toContain("续做：");

    const second = await h.turn("继续", entries);
    expect(briefOf(second)).toBeUndefined();
  });

  it("resume：本条分支已有 tutor-brief 条目就不再注入", async () => {
    const [chapter] = seedTopic("redis高可用", ["四个动作"]);
    const h = setup();
    await h.sessionStart([
      boundEntry(chapter),
      { type: "custom", customType: "tutor-brief", data: { at: "x" } },
    ]);

    const results = await h.turn("继续", [boundEntry(chapter)]);

    expect(briefOf(results)).toBeUndefined();
  });

  it("未绑定 + tutor skill：注入 vault 目录与「别猜主题名」的落点规则", async () => {
    const [chapter] = seedTopic("redis高可用", ["四个动作"]);
    const h = setup();
    await h.sessionStart();

    const brief = briefOf(await h.turn(skillPrompt("redis集群方案和实现")));

    expect(brief?.content).toContain("本会话未绑定笔记");
    expect(brief?.content).toContain("redis高可用（1章");
    expect(brief?.content).toContain("不要用参数去猜主题名");
    expect(chapter).toBeTruthy();
  });

  it("普通会话：什么都不注入", async () => {
    seedTopic("redis高可用", ["四个动作"]);
    const h = setup();
    await h.sessionStart();

    expect(await h.turn("帮我改一下这个扩展")).toEqual([]);
  });
});
