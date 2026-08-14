// agent-store.mjs — 纯逻辑层:状态模型 + 视图数据。
// 无 IO、无副作用,value in / value out,可直接单元测试。
//
// 状态模型:
//   state = { panes: Map<"source|paneId", Pane>, workspaces: Map<"source|wsId", Workspace> }
//   Pane = { key, paneId, workspaceId, source, agent, title, status, lastMessage }
// 事件 → transitions:applyEvent 返回 [{ paneId, from, to }],由 shell 负责
// 对 working→idle/done 的 transition 执行 pane.read(IO)并回填 lastMessage。

export const STATUS_ORDER = ["working", "blocked", "done", "idle", "unknown"];

export function rank(status) {
  const i = STATUS_ORDER.indexOf(status);
  return i === -1 ? STATUS_ORDER.length : i;
}

export function toPane(p, source) {
  return {
    key: `${source}|${p.pane_id}`,
    paneId: p.pane_id,
    workspaceId: p.workspace_id,
    source,
    agent: p.agent,
    title: p.title ?? p.display_agent ?? p.agent,
    status: p.agent_status ?? "unknown",
    stateLabels: p.state_labels ?? {},
    lastMessage: null, // 初始无;待该 agent 完成一轮后由 shell 读取回填
  };
}

/** 由 session.snapshot 初始化状态(只保留带 agent 的 pane)。 */
export function initFromSnapshot(snapshot, source) {
  const panes = new Map();
  const workspaces = new Map();
  for (const w of snapshot.workspaces ?? []) {
    workspaces.set(`${source}|${w.workspace_id}`, w);
  }
  for (const p of snapshot.panes ?? []) {
    if (p.agent) {
      const pane = toPane(p, source);
      panes.set(pane.key, pane);
    }
  }
  return { panes, workspaces };
}

/**
 * 应用一条订阅事件。
 * @param source 事件来源实例名(default / session 名),用于区分多实例中同名的 pane_id
 * @returns { state, transitions, resync } — resync=true 表示集合变化需要 shell 重新 snapshot
 */
export function applyEvent(state, ev, source = "default") {
  const d = ev.data ?? {};
  const panes = state.panes;
  const transitions = [];

  switch (ev.event) {
    case "pane.agent_status_changed": {
      const key = `${source}|${d.pane_id}`;
      const p = panes.get(key);
      if (!p) return { state, transitions, resync: true }; // 未知 pane(订阅建立后新增)→ 全量对账
      const prev = p.status;
      p.status = d.agent_status;
      if (d.title != null) p.title = d.title;
      if (d.display_agent != null && !p.title) p.title = d.display_agent;
      if (prev !== d.agent_status)
        transitions.push({ paneId: p.paneId, from: prev, to: d.agent_status });
      return { state, transitions, resync: false };
    }
    case "pane.closed": {
      panes.delete(`${source}|${d.pane_id}`);
      return { state, transitions, resync: false };
    }
    case "pane.updated": {
      const p = d.pane;
      if (p?.agent) {
        const pane = toPane(p, source);
        panes.set(pane.key, pane);
      } else {
        panes.delete(`${source}|${p?.pane_id ?? d.pane_id}`);
      }
      return { state, transitions, resync: false };
    }
    case "pane.created":
    case "pane.agent_detected":
    case "workspace.created":
    case "workspace.closed":
    case "workspace.renamed":
    case "workspace.moved":
      // 集合变化 → shell 重新 snapshot 全量对账(agent 订阅列表也要重建)
      return { state, transitions, resync: true };
    default:
      return { state, transitions, resync: false };
  }
}

/** 聚合视图数据:按 workspace 分组、working 优先排序。 */
export function viewData(state) {
  const { panes, workspaces } = state;
  const byWs = [];
  const wsMap = new Map();
  for (const p of panes.values()) {
    const wsKey = `${p.source}|${p.workspaceId}`;
    if (!wsMap.has(wsKey)) {
      const w = workspaces.get(wsKey);
      const label =
        w?.label ??
        (p.source === "default"
          ? p.workspaceId
          : `${p.source}/${p.workspaceId}`);
      wsMap.set(wsKey, { label, source: p.source, agents: [] });
      byWs.push(wsMap.get(wsKey));
    }
    wsMap.get(wsKey).agents.push({
      paneId: p.paneId,
      workspaceId: p.workspaceId,
      source: p.source,
      title: p.title,
      status: p.status,
      stateLabels: p.stateLabels,
      lastMessage: p.lastMessage,
    });
  }
  for (const ws of byWs) {
    ws.agents.sort(
      (a, b) =>
        rank(a.status) - rank(b.status) || a.title.localeCompare(b.title),
    );
  }
  byWs.sort((a, b) => a.label.localeCompare(b.label));

  const byStatus = { working: 0, idle: 0, blocked: 0, done: 0, unknown: 0 };
  for (const p of panes.values())
    byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;

  return { byWs, byStatus, total: panes.size };
}

/** recent 输出 → 最后一条消息摘要:最后一个完整段落,去掉状态行噪声。 */
export function summarize(text) {
  if (!text) return null;
  const paras = text
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  let last = paras[paras.length - 1] ?? "";
  last = last
    .split("\n")
    .filter((l) => !/^(working\.\.\.|thinking\.\.\.|•?…?)$/i.test(l.trim()))
    .join("\n")
    .trim();
  return last.slice(0, 300) || "(无输出)";
}
