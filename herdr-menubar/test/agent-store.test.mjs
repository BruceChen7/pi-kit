// agent-store 纯逻辑单测:node --test
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyEvent,
  initFromSnapshot,
  rank,
  summarize,
  viewData,
} from "../src/agent-store.mjs";

function snap(panes, workspaces = []) {
  return { workspaces, panes };
}
function ws(id, label) {
  return { workspace_id: id, label };
}
function pane(id, wsId, opts = {}) {
  return {
    pane_id: id,
    workspace_id: wsId,
    agent: "agent" in opts ? opts.agent : "pi",
    title: opts.title ?? `π - ${id}`,
    agent_status: opts.status ?? "idle",
    state_labels: opts.labels ?? {},
  };
}

test("initFromSnapshot 只保留带 agent 的 pane,并按 source 加前缀", () => {
  const s = initFromSnapshot(
    snap(
      [
        pane("p1", "w1"),
        pane("p2", "w1", { agent: null }),
        pane("p3", "w2", { agent: "claude" }),
      ],
      [ws("w1", "a"), ws("w2", "b")],
    ),
    "sess",
  );
  assert.equal(s.panes.size, 2);
  assert.ok(s.panes.has("sess|p1"));
  assert.ok(s.panes.has("sess|p3"));
  assert.equal(s.panes.get("sess|p1").status, "idle");
  assert.equal(s.workspaces.get("sess|w1").label, "a");
});

test("agent_status_changed 更新状态并产出 transition", () => {
  const s = initFromSnapshot(
    snap([pane("p1", "w1", { status: "working" })], [ws("w1", "a")]),
    "default",
  );
  const { transitions, resync } = applyEvent(
    s,
    {
      event: "pane.agent_status_changed",
      data: { pane_id: "p1", workspace_id: "w1", agent_status: "done" },
    },
    "default",
  );
  assert.equal(resync, false);
  assert.deepEqual(transitions, [
    { paneId: "p1", from: "working", to: "done" },
  ]);
  assert.equal(s.panes.get("default|p1").status, "done");
});

test("working→idle/done 才算完成(transitions 供 shell 触发读消息)", () => {
  const s = initFromSnapshot(
    snap([pane("p1", "w1", { status: "idle" })], []),
    "default",
  );
  // idle → working 不产出可读消息的 transition(方向不对)
  const t1 = applyEvent(
    s,
    {
      event: "pane.agent_status_changed",
      data: { pane_id: "p1", workspace_id: "w1", agent_status: "working" },
    },
    "default",
  ).transitions;
  assert.deepEqual(t1, [{ paneId: "p1", from: "idle", to: "working" }]);
  // working → idle 是完成
  const t2 = applyEvent(
    s,
    {
      event: "pane.agent_status_changed",
      data: { pane_id: "p1", workspace_id: "w1", agent_status: "idle" },
    },
    "default",
  ).transitions;
  assert.deepEqual(t2, [{ paneId: "p1", from: "working", to: "idle" }]);
});

test("未知 pane 的状态事件 → resync=true(全量对账)", () => {
  const s = initFromSnapshot(snap([], []), "default");
  const { resync } = applyEvent(
    s,
    {
      event: "pane.agent_status_changed",
      data: { pane_id: "ghost", workspace_id: "w9", agent_status: "working" },
    },
    "default",
  );
  assert.equal(resync, true);
});

test("pane.closed 移除;pane.updated 新增/移除 agent", () => {
  const s = initFromSnapshot(snap([pane("p1", "w1")], []), "default");
  applyEvent(s, { event: "pane.closed", data: { pane_id: "p1" } }, "default");
  assert.equal(s.panes.size, 0);
  // updated 新增 agent pane
  applyEvent(
    s,
    {
      event: "pane.updated",
      data: { pane: pane("p9", "w1", { status: "working" }) },
    },
    "default",
  );
  assert.equal(s.panes.get("default|p9").status, "working");
  // updated 移除 agent(agent 为 null)
  applyEvent(
    s,
    {
      event: "pane.updated",
      data: { pane: pane("p9", "w1", { agent: null }) },
    },
    "default",
  );
  assert.equal(s.panes.size, 0);
});

test("多实例同名 pane_id 互不干扰(source 前缀隔离)", () => {
  const s1 = initFromSnapshot(
    snap([pane("p1", "w1", { status: "working" })], []),
    "a",
  );
  const s2 = initFromSnapshot(
    snap([pane("p1", "w1", { status: "idle" })], []),
    "b",
  );
  const merged = {
    panes: new Map([...s1.panes, ...s2.panes]),
    workspaces: new Map(),
  };
  applyEvent(
    merged,
    {
      event: "pane.agent_status_changed",
      data: { pane_id: "p1", workspace_id: "w1", agent_status: "done" },
    },
    "a",
  );
  assert.equal(merged.panes.get("a|p1").status, "done");
  assert.equal(merged.panes.get("b|p1").status, "idle");
});

test("viewData 按 workspace 分组、working 优先、统计 byStatus", () => {
  const s = initFromSnapshot(
    snap(
      [
        pane("p1", "w1", { status: "idle", title: "b" }),
        pane("p2", "w1", { status: "working", title: "a" }),
        pane("p3", "w2", { status: "blocked" }),
      ],
      [ws("w1", "zeta"), ws("w2", "alpha")],
    ),
    "default",
  );
  const v = viewData(s);
  assert.deepEqual(v.byStatus, {
    working: 1,
    idle: 1,
    blocked: 1,
    done: 0,
    unknown: 0,
  });
  assert.equal(v.total, 3);
  assert.deepEqual(
    v.byWs.map((w) => w.label),
    ["alpha", "zeta"],
  ); // label 排序
  assert.deepEqual(
    v.byWs[1].agents.map((a) => a.status),
    ["working", "idle"],
  ); // working 优先
});

test("summarize 取最后段落并去掉状态行噪声", () => {
  assert.equal(summarize(null), null);
  const text =
    "Working...\n\n一些中间输出\n\n✅ 完成:事件订阅重构完成,测试全部通过";
  assert.equal(summarize(text), "✅ 完成:事件订阅重构完成,测试全部通过");
  const onlyNoise = "Working...\nWorking...";
  assert.equal(summarize(onlyNoise), "(无输出)");
});

test("rank 排序稳定", () => {
  const sorted = ["working", "blocked", "done", "idle", "unknown", "nope"].sort(
    (a, b) => rank(a) - rank(b),
  );
  assert.deepEqual(sorted, [
    "working",
    "blocked",
    "done",
    "idle",
    "unknown",
    "nope",
  ]);
});
