import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

// ─── 帮助函数 ────────────────────────────────────────────────────────

function userMsg(text: string): Message {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

function assistantMsg(text: string): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function readEntries(file: string): SessionMessageEntry[] {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as SessionMessageEntry)
    .filter((e) => e.type === "message");
}

function findNode(
  roots: Array<{ entry: SessionMessageEntry; children: unknown[] }>,
  id: string,
): { entry: SessionMessageEntry; children: unknown[] } | undefined {
  for (const root of roots) {
    const hit = findNodeRec(root, id);
    if (hit) return hit;
  }
  return undefined;
}

function findNodeRec(
  node: { entry: SessionMessageEntry; children: unknown[] },
  id: string,
): { entry: SessionMessageEntry; children: unknown[] } | undefined {
  if (node.entry.id === id) return node;
  for (const child of node.children as Array<{
    entry: SessionMessageEntry;
    children: unknown[];
  }>) {
    const hit = findNodeRec(child, id);
    if (hit) return hit;
  }
  return undefined;
}

// ─── Spike 1：refresh 机制（setSessionFile(同路径) + branch 回） ────

describe("fork-panel refresh 机制（Spike 1）", () => {
  it("双进程追加同一文件后，A refresh 能看到 B 的分支，且继续 append 挂回自己分支", () => {
    const dir = mkdtempSync(join(tmpdir(), "fork-panel-spike-"));
    const sessionDir = join(dir, "sessions");

    // 进程 A：创建会话并写满一条分支（user→assistant×2），触发落盘
    const a = SessionManager.create(dir, sessionDir);
    const file = a.getSessionFile() ?? expect.fail("未创建 session 文件");
    a.appendMessage(userMsg("hi"));
    a.appendMessage(assistantMsg("hello"));
    a.appendMessage(userMsg("q2"));
    const a2 = a.appendMessage(assistantMsg("a2")); // A 的 leaf
    expect(a.getLeafId()).toBe(a2);

    // 进程 B：打开同一文件，leaf 应从文件尾部恢复为 a2
    const b = SessionManager.open(file, sessionDir, dir);
    expect(b.getLeafId()).toBe(a2);

    // 进程 B：追加 panel 分支（parent = a2）
    const p1 = b.appendMessage(userMsg("panel prompt"));
    const p2 = b.appendMessage(assistantMsg("panel reply"));
    expect(b.getLeafId()).toBe(p2);

    // 磁盘上应有两分支的全部 entry
    const onDisk = readEntries(file);
    expect(onDisk.map((e) => e.id)).toEqual([
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      p1,
      p2,
    ]);

    // 进程 A：refresh（重读 + branch 回自己的 leaf）
    const leaf0 = a.getLeafId();
    a.setSessionFile(file);
    expect(a.getLeafId()).toBe(p2); // 重读后 leaf 指向文件尾部（B 的最后一条）
    a.branch(leaf0 ?? expect.fail("无 leaf"));
    expect(a.getLeafId()).toBe(a2);

    // A 的 tree 现在应包含两条分支：a2 有两个孩子（p1 与 A 尚未新增的旧分支孩子）
    const roots = a.getTree() as unknown as Array<{
      entry: SessionMessageEntry;
      children: unknown[];
    }>;
    const nodeA2 = findNode(roots, a2);
    expect(nodeA2).toBeTruthy();
    if (!nodeA2) throw new Error("a2 节点不存在");
    expect(
      (nodeA2.children as Array<{ entry: SessionMessageEntry }>).map(
        (c) => c.entry.id,
      ),
    ).toEqual([p1]);

    // A 继续 append → 挂回 a2 之下（旧分支），不与 panel 分支交叉
    const u3 = a.appendMessage(userMsg("继续"));
    expect(a.getLeafId()).toBe(u3);
    const entriesAfter = readEntries(file);
    const a2Node =
      entriesAfter.find((e) => e.id === a2) ?? expect.fail("a2 节点不存在");
    const children = entriesAfter
      .filter((e) => e.parentId === a2)
      .map((e) => e.id)
      .sort();
    expect(children).toEqual([p1, u3].sort());
  });

  it("B 侧 refresh 对称：B 重读后 branch 回自己的分支，继续 append 不污染 A 的分支", () => {
    const dir = mkdtempSync(join(tmpdir(), "fork-panel-spike-"));
    const sessionDir = join(dir, "sessions");

    const a = SessionManager.create(dir, sessionDir);
    const file = a.getSessionFile()!;
    a.appendMessage(userMsg("hi"));
    a.appendMessage(assistantMsg("hello"));
    a.appendMessage(userMsg("q2"));
    const aLeaf = a.appendMessage(assistantMsg("a2")); // A 的 leaf

    const b = SessionManager.open(file, sessionDir, dir);
    const p1 = b.appendMessage(userMsg("panel prompt"));
    const p2 = b.appendMessage(assistantMsg("panel reply"));

    // A 继续
    const u3 = a.appendMessage(userMsg("继续"));

    // B refresh：重读（leaf 变成 u3）+ branch 回 p2
    const leaf0 = b.getLeafId();
    expect(leaf0).toBe(p2);
    b.setSessionFile(file);
    expect(b.getLeafId()).toBe(u3);
    b.branch(leaf0 ?? expect.fail("无 leaf"));
    expect(b.getLeafId()).toBe(p2);

    // B 继续 append → 挂回 p2 之下
    const p3 = b.appendMessage(userMsg("panel next"));
    const p2Children = readEntries(file)
      .filter((e) => e.parentId === p2)
      .map((e) => e.id);
    expect(p2Children).toEqual([p3]);

    // 两分支完整：aLeaf 的孩子 = [p1(panel 首条), u3(旧分支)]；p1 → p2 → p3 为 panel 分支
    const all = readEntries(file);
    expect(
      all
        .filter((e) => e.parentId === aLeaf)
        .map((e) => e.id)
        .sort(),
    ).toEqual([p1, u3].sort());
    expect(all.filter((e) => e.parentId === p1).map((e) => e.id)).toEqual([p2]);
  });
});
