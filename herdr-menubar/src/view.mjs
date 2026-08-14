// popover WebView 页面:renderHtml() 生成初始 HTML;Node 侧通过 win.send 调用
// window.__render(viewData) 增量重绘,点击事件经 window.glimpse.send 回传。
// 前端状态:filter(状态筛选)在 WebView 侧维护,__render 只推送数据。

export function renderHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 13px/1.55 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
         background: #171a23; color: #e6e9f2; user-select: none; }
  * { box-sizing: border-box; }
  #root { padding: 8px 10px 10px; }
  .head { display: flex; justify-content: space-between; align-items: baseline;
          padding: 6px 6px 8px; border-bottom: 1px solid #2a2f3f; }
  .head .t { font-weight: 700; font-size: 12px; letter-spacing: .08em; color: #9aa3b8; }
  .head .s { font-size: 12px; color: #4ade80; font-variant-numeric: tabular-nums; }
  .chips { display: flex; gap: 4px; padding: 8px 4px 2px; flex-wrap: wrap; }
  .chip { font-size: 10.5px; color: #9aa3b8; background: #1e2230; border: 1px solid #2a2f3f;
          border-radius: 99px; padding: 2px 9px; cursor: pointer; }
  .chip:hover { color: #e6e9f2; }
  .chip.on { background: #2a3550; border-color: #5b8cff; color: #a5c8ff; }
  .ws { margin: 10px 4px 2px; font-size: 10.5px; letter-spacing: .07em; color: #5b8cff;
        font-family: ui-monospace, Menlo, monospace; }
  .row { margin: 3px 0; border-radius: 8px; padding: 6px 8px; cursor: pointer; }
  .row:hover { background: #1e2230; }
  .l1 { display: flex; align-items: center; gap: 7px; min-width: 0; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 8px; }
  .st-working  { background: #4ade80; box-shadow: 0 0 6px rgba(74,222,128,.7); }
  .st-idle     { background: #6b7280; }
  .st-blocked  { background: #facc15; box-shadow: 0 0 6px rgba(250,204,21,.5); }
  .st-done     { background: #60a5fa; }
  .st-unknown  { background: #c084fc; }
  .title { font-weight: 600; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .labels { font-size: 10px; color: #64748b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .badge { margin-left: auto; flex: 0 0 auto; font-size: 10px; color: #9aa3b8;
           background: #20242f; border-radius: 99px; padding: 1px 8px; }
  .msg { margin: 3px 0 0 15px; font-size: 11.5px; color: #9aa3b8; white-space: pre-wrap;
         word-break: break-all; display: -webkit-box; -webkit-line-clamp: 2;
         -webkit-box-orient: vertical; overflow: hidden; cursor: pointer; border-radius: 4px; }
  .msg:hover { color: #cdd3e0; background: #1a1e2a; }
  .msg.open { -webkit-line-clamp: unset; color: #cdd3e0; }
  .foot { margin-top: 10px; padding-top: 8px; border-top: 1px solid #2a2f3f;
          font-size: 10.5px; color: #64748b; text-align: center; }
  .foot a { color: #5b8cff; cursor: pointer; text-decoration: none; }
  .offline { padding: 24px 10px; text-align: center; color: #f87171; font-size: 13px; }
  .offline small, .empty small { display: block; margin-top: 6px; color: #9aa3b8; font-size: 11px; }
  .empty { padding: 24px 10px; text-align: center; color: #9aa3b8; font-size: 12.5px; }
</style>
</head>
<body>
<div id="root"></div>
<script>
const STATUSES = ['working', 'idle', 'blocked', 'done', 'unknown'];
let state = { byWs: [], byStatus: {}, total: 0, offline: false, filter: null };

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function onRowClick(e) {
  const row = e.currentTarget;
  if (e.target.closest('.msg')) {           // 点摘要 → 展开/收起全文
    window.glimpse.send({ expand: row.dataset.paneId });
    return;
  }
  window.glimpse.send({                       // 点行其他区域 → 拉起 agent
    activate: { source: row.dataset.source, wsId: row.dataset.wsId, paneId: row.dataset.paneId },
  });
}

window.__render = function (v) { state = { ...state, ...v }; render(); };
window.__toggleExpand = function (paneId) {
  document.querySelectorAll('.msg').forEach((m) => {
    if (m.dataset.paneId === paneId) m.classList.toggle('open');
  });
};

function renderChips() {
  const bar = el('div', 'chips');
  const opts = [null, ...STATUSES];
  for (const s of opts) {
    const c = el('span', 'chip' + (state.filter === s ? ' on' : ''), s ?? 'all');
    c.addEventListener('click', () => { state.filter = s; render(); });
    bar.append(c);
  }
  return bar;
}

function render() {
  const root = document.getElementById('root');
  root.innerHTML = '';
  if (state.offline) {
    const d = el('div', 'offline', 'herdr 未运行');
    d.append(el('small', null, '正在重连…'));
    root.append(d);
    return;
  }
  if (state.total === 0) {
    const d = el('div', 'empty', '没有检测到 agent');
    d.append(el('small', null, '打开 herdr 并启动任意 agent 后自动出现'));
    root.append(d);
    return;
  }
  const head = el('div', 'head');
  head.append(el('span', 't', 'HERDR AGENTS'));
  head.append(el('span', 's', (state.byStatus.working ?? 0) > 0
    ? '● ' + state.byStatus.working + ' working'
    : 'all idle'));
  root.append(head);
  root.append(renderChips());

  for (const ws of state.byWs) {
    const agents = state.filter ? ws.agents.filter((a) => a.status === state.filter) : ws.agents;
    if (agents.length === 0) continue;
    root.append(el('div', 'ws', ws.label));
    for (const a of agents) {
      const row = el('div', 'row');
      row.dataset.paneId = a.paneId;
      row.dataset.wsId = a.workspaceId;
      row.dataset.source = a.source;
      const l1 = el('div', 'l1');
      l1.append(el('span', 'dot st-' + a.status));
      l1.append(el('span', 'title', a.title));
      const labels = Object.entries(a.stateLabels ?? {});
      if (labels.length) {
        l1.append(el('span', 'labels', labels.map(([k, v]) => k + ': ' + v).join(' · ')));
      }
      l1.append(el('span', 'badge', a.status));
      row.append(l1);
      if (a.lastMessage) {
        const msg = el('div', 'msg', a.lastMessage);
        msg.dataset.paneId = a.paneId;
        row.append(msg);
      }
      row.addEventListener('click', onRowClick);
      root.append(row);
    }
  }

  const foot = el('div', 'foot', '');
  foot.append(el('span', null, state.total + ' agents · '));
  foot.append(el('span', null, '点击行拉起 agent · '));
  const q = el('a', null, '退出');
  q.addEventListener('click', () => window.glimpse.send({ quit: true }));
  foot.append(q);
  root.append(foot);
}
</script>
</body>
</html>`;
}
