// Herdr Agent 状态系统菜单栏 (glimpse statusItem)
// 薄壳:连接/订阅/IO/渲染编排;状态逻辑在 agent-store.mjs(纯函数,可单测)。
import { execFile } from "node:child_process";
import { statusItem } from "glimpseui";
import {
  applyEvent,
  initFromSnapshot,
  summarize,
  viewData,
} from "./agent-store.mjs";
import { HerdrClient } from "./herdr-client.mjs";
import { listSocketPaths } from "./socket-detect.mjs";
import { renderHtml } from "./view.mjs";

const item = statusItem(renderHtml(), { title: "…", width: 400, height: 560 });

const instances = new Map(); // name -> { client, subSock }
const store = { panes: new Map(), workspaces: new Map() };
let connected = false;
let reconnectTimer = null;

// ---------- 连接与同步 ----------

item.on("ready", () => {
  connectAll();
  setInterval(() => {
    if (connected) reconcileAll(); // 30s 对账,防事件漂移
  }, 30000);
});

async function connectAll() {
  for (const { path, name } of listSocketPaths()) {
    if (instances.has(name)) continue;
    const client = new HerdrClient(path);
    instances.set(name, { client, subSock: null });
    await syncInstance(name).catch((e) => {
      console.error(`[menubar] ${name} connect failed:`, e.message);
      instances.delete(name);
    });
  }
  connected = instances.size > 0;
  paint();
  if (!connected) scheduleReconnect();
}

/** snapshot 全量对账 + 重建订阅(某实例集合变化 / 重连 / 定时对账时调用) */
async function syncInstance(name) {
  const inst = instances.get(name);
  if (!inst) return;
  const snap = (
    await inst.client.request(`snap:${name}`, "session.snapshot", {})
  ).snapshot;
  mergeSnapshot(snap, name);
  rebuildSubscriptions(name);
}

function mergeSnapshot(snapshot, source) {
  const prefix = `${source}|`;
  for (const key of [...store.panes.keys()])
    if (key.startsWith(prefix)) store.panes.delete(key);
  for (const key of [...store.workspaces.keys()])
    if (key.startsWith(prefix)) store.workspaces.delete(key);
  const fresh = initFromSnapshot(snapshot, source);
  for (const [k, v] of fresh.panes) store.panes.set(k, v);
  for (const [k, v] of fresh.workspaces) store.workspaces.set(k, v);
}

function rebuildSubscriptions(name) {
  const inst = instances.get(name);
  if (!inst) return;
  if (inst.subSock) {
    inst.subSock.destroy();
    inst.subSock = null;
  }
  const subs = [
    ...[...store.panes.values()]
      .filter((p) => p.source === name)
      .map((p) => ({ type: "pane.agent_status_changed", pane_id: p.paneId })),
    { type: "pane.created" },
    { type: "pane.closed" },
    { type: "pane.updated" },
    { type: "pane.agent_detected" },
    { type: "workspace.created" },
    { type: "workspace.closed" },
    { type: "workspace.renamed" },
    { type: "workspace.moved" },
  ];
  inst.subSock = inst.client.subscribe(subs, (ev) =>
    handleEvent(name, ev).catch(() => {}),
  );
  inst.subSock.on("close", () => {
    if (instances.has(name)) scheduleReconnect();
  });
  inst.subSock.on("error", () => {});
}

async function handleEvent(source, msg) {
  const { transitions, resync } = applyEvent(store, msg, source);
  if (resync) {
    await syncInstance(source);
    paint();
    return;
  }
  // 本轮完成 → 读取最后一条消息(仅状态切换瞬间,不做轮询)
  for (const t of transitions) {
    if (t.from === "working" && (t.to === "idle" || t.to === "done")) {
      await readLastMessage(source, t.paneId);
    }
  }
  paint();
}

async function readLastMessage(source, paneId) {
  const pane = store.panes.get(`${source}|${paneId}`);
  if (!pane) return;
  try {
    const r = await instances
      .get(source)
      ?.client.request(`read:${source}|${paneId}`, "pane.read", {
        pane_id: paneId,
        source: "recent",
        lines: 80,
        format: "text",
        strip_ansi: true,
      });
    pane.lastMessage = r ? summarize(r.text) : null;
  } catch {
    pane.lastMessage = "(读取失败)";
  }
  paint();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectAll();
  }, 3000);
}

async function reconcileAll() {
  for (const name of instances.keys()) {
    await syncInstance(name).catch((e) => {
      console.error(`[menubar] ${name} reconcile failed:`, e.message);
      instances.delete(name);
      scheduleReconnect();
    });
  }
  paint();
}

// ---------- 渲染 ----------

function paint() {
  const v = viewData(store);
  const working = v.byStatus.working ?? 0;

  if (!connected) {
    item.setTitle("");
    item._write({
      type: "icon",
      symbol: "xmark.circle.fill",
      color: "#f87171",
    });
  } else if (working > 0) {
    item.setTitle(String(working));
    item._write({ type: "icon", symbol: "circle.fill", color: "#4ade80" });
  } else if (v.total > 0) {
    item.setTitle("");
    item._write({ type: "icon", symbol: "circle", color: "#9ca3af" });
  } else {
    item.setTitle("");
    item._write({ type: "icon", symbol: "circle.dashed", color: "#9ca3af" });
  }

  // popover 自适应高度:随行数伸缩
  const rows = v.byWs.reduce((n, ws) => n + ws.agents.length, 0);
  const height = Math.min(
    620,
    Math.max(220, 110 + rows * 38 + v.byWs.length * 20),
  );
  item.resize(400, height);

  item.send(`window.__render(${JSON.stringify(v)})`);
}

// ---------- 交互 ----------

item.on("message", (m) => {
  if (m.activate) {
    const { wsId, paneId, source } = m.activate;
    if (!connected) return;
    const client = instances.get(source ?? "default")?.client;
    if (!client) return;
    client
      .request("wf", "workspace.focus", { workspace_id: wsId })
      .catch((e) => {
        console.error("[menubar] workspace.focus failed:", e.message);
      });
    client.request("af", "agent.focus", { target: paneId }).catch((e) => {
      console.error("[menubar] agent.focus failed:", e.message);
    });
    activateHerdr();
  } else if (m.expand) {
    item.send(`window.__toggleExpand(${JSON.stringify(m.expand)})`);
  } else if (m.quit) {
    process.exit(0);
  }
});

// ---------- macOS 前台激活 ----------

// herdr TUI 是终端里的 CLI(通常在 Ghostty),需要激活其所在终端 app;
// 沿父进程链探测,避免硬编码。
const TERMINAL_HINTS =
  /\.app\/|Ghostty|Terminal|iTerm|kitty|alacritty|wezterm|Warp|Konsole/;

function findHerdrTerminalApp(cb) {
  execFile("ps", ["-A", "-o", "pid=,comm="], (e, out) => {
    if (e) return cb(null);
    let tuiPid = null;
    let serverPid = null;
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!m) continue;
      const [pid, comm] = [m[1], m[2]];
      if (comm === "herdr") tuiPid ??= pid;
      else if (comm.includes("herdr") && comm.includes("/")) serverPid ??= pid;
    }
    const pid = tuiPid ?? serverPid;
    if (!pid) return cb(null);
    const collect = (p) => {
      execFile("ps", ["-o", "ppid=,comm=", "-p", p], (e2, out2) => {
        if (e2) return cb(null);
        const m2 = out2.trim().match(/^\s*(\d+)\s+(.+)$/);
        if (!m2) return cb(null);
        const [ppid, comm] = [m2[1], m2[2]];
        if (TERMINAL_HINTS.test(comm))
          return cb(
            comm
              .split("/")
              .pop()
              .replace(/\.app.*$/, ""),
          );
        if (ppid === "1" || ppid === "0") return cb(null);
        collect(ppid);
      });
    };
    collect(pid);
  });
}

function activateHerdr() {
  findHerdrTerminalApp((app) => {
    const name = app ?? "Ghostty";
    execFile(
      "osascript",
      ["-e", `tell application "${name}" to activate`],
      (err) => {
        if (err) console.error("[menubar] activate failed:", name, err.message);
      },
    );
  });
}

item.on("error", (e) => console.error("[menubar] glimpse error:", e.message));
process.on("SIGINT", () => process.exit(0));
console.log(
  "[menubar] started, sockets:",
  listSocketPaths()
    .map((s) => s.name)
    .join(", "),
);
