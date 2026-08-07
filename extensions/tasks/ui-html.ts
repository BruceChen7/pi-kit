/**
 * Tasks Glimpse UI — generate the list/board/detail HTML (方案 A layout)
 * and open a Glimpse window.
 *
 * Static HTML snapshot: the window renders current data; refreshes happen by
 * reopening. Uses the shared Glimpse window helper.
 */

import {
  type GlimpseWindowOptions,
  openGlimpseWindow,
} from "../shared/glimpse-window.ts";
import {
  type Label,
  PRIORITY_LABELS,
  STATUS_LABELS,
  type Task,
  type TasksDb,
} from "./contract.ts";
import { defaultDbPath, readDb } from "./db.ts";
import * as S from "./store.ts";

const STATUS_COLORS: Record<string, string> = {
  backlog: "#6b7280",
  todo: "#6b7280",
  in_progress: "#f59e0b",
  in_review: "#a78bfa",
  done: "#22c55e",
  canceled: "#6b7280",
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function statusIcon(status: string): string {
  const color = STATUS_COLORS[status] ?? "#6b7280";
  switch (status) {
    case "in_progress":
      return `<svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="${color}" stroke-width="1.5"/><path d="M7 7 7 2.5A4.5 4.5 0 0 1 11 9.5Z" fill="${color}"/></svg>`;
    case "done":
      return `<svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="${color}" stroke-width="1.5"/><path d="M4.5 7.5 6.2 9.2 9.5 5.5" fill="none" stroke="${color}" stroke-width="1.5"/></svg>`;
    case "canceled":
      return `<svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="${color}" stroke-width="1.5"/><path d="M5 5l4 4M9 5l-4 4" stroke="${color}" stroke-width="1.2"/></svg>`;
    case "backlog":
      return `<svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="${color}" stroke-width="1.5" stroke-dasharray="2 2.5"/></svg>`;
    case "in_review":
      return `<svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="${color}" stroke-width="1.5"/><path d="M7 7 7 2.5A4.5 4.5 0 1 1 6.99 2.5Z" fill="${color}"/></svg>`;
    default:
      return `<svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="${color}" stroke-width="1.5"/></svg>`;
  }
}

function priorityBadge(p: string): string {
  const colors: Record<string, string> = {
    urgent: "#ef4444",
    high: "#f59e0b",
    medium: "#6366f1",
    low: "#6b7280",
    none: "#4b5563",
  };
  const c = colors[p] ?? "#4b5563";
  return `<span class="chip" style="color:${c}">${PRIORITY_LABELS[p] ?? p}</span>`;
}

function labelChips(labels: Label[], labelIds: string[]): string {
  return labelIds
    .map((id) => labels.find((l) => l.id === id))
    .filter(Boolean)
    .map(
      (l) =>
        `<span class="chip"><span class="dot" style="background:${l.color}"></span>${esc(l.name)}</span>`,
    )
    .join("");
}

function listRows(tasks: Task[], labels: Label[]): string {
  const byStatus = new Map<string, Task[]>();
  for (const status of [
    "backlog",
    "todo",
    "in_progress",
    "in_review",
    "done",
    "canceled",
  ]) {
    byStatus.set(status, []);
  }
  for (const t of tasks) byStatus.get(t.status)?.push(t);

  let html = "";
  for (const [status, group] of byStatus) {
    if (group.length === 0) continue;
    html += `<div class="list-header">${statusIcon(status)} ${STATUS_LABELS[status as keyof typeof STATUS_LABELS]} — ${group.length}</div>`;
    for (const t of group) {
      html += `<div class="list-row" data-task="${esc(t.key)}" data-labels="${t.labelIds.join(",")}">
        ${statusIcon(t.status)}
        <span class="key">${esc(t.key)}</span>
        <span class="title">${esc(t.title)}</span>
        <div class="rail">${labelChips(labels, t.labelIds)}${priorityBadge(t.priority)}</div>
      </div>`;
    }
  }
  return html;
}

function boardColumns(tasks: Task[], labels: Label[]): string {
  const byStatus = new Map<string, Task[]>();
  for (const status of [
    "backlog",
    "todo",
    "in_progress",
    "in_review",
    "done",
    "canceled",
  ]) {
    byStatus.set(status, []);
  }
  for (const t of tasks) byStatus.get(t.status)?.push(t);

  let html = "";
  for (const [status, group] of byStatus) {
    html += `<div class="board-col">
      <div class="board-col-header">${statusIcon(status)} ${STATUS_LABELS[status as keyof typeof STATUS_LABELS]} <span class="count">${group.length}</span></div>
      <div class="board-col-cards">`;
    for (const t of group) {
      html += `<div class="card" data-task="${esc(t.key)}">
        <div class="card-top"><span class="key">${esc(t.key)}</span></div>
        <div class="card-title">${esc(t.title)}</div>
        <div class="card-rail">${labelChips(labels, t.labelIds)}${priorityBadge(t.priority)}</div>
      </div>`;
    }
    html += `</div></div>`;
  }
  return html;
}

export async function createTasksHtml(projectRoot: string): Promise<string> {
  const db: TasksDb = await readDb(defaultDbPath(projectRoot));
  const topLevel = S.listTopLevelTasks(db);
  const labels = db.labels;

  const sidebar = `
    <aside class="sidebar">
      <nav class="sidebar-nav">
        <div class="sidebar-row active"><span class="icon">◧</span><span>All tasks</span><span class="count">${topLevel.length}</span></div>
        <div class="sidebar-section"><div class="sidebar-section-label">Projects</div>
          ${db.projects.map((p) => `<div class="sidebar-row"><span class="dot" style="background:${p.color}"></span><span>${esc(p.name)}</span><span class="count">${S.listTopLevelTasks(db, p.id).length}</span></div>`).join("")}
        </div>
      </nav>
    </aside>`;

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tasks — ${esc(projectRoot.split("/").pop() ?? "")}</title>
<style>
  :root {
    --bg:#0f1117; --bg-raised:#16181f; --bg-hover:#1c1f26; --bg-active:#22252e;
    --bg-sidebar:#0b0d12; --bg-muted:#1c1f26; --bg-secondary:#1c1f26; --bg-overlay:rgba(0,0,0,.6);
    --fg:#e5e7eb; --fg-muted:#6b7280; --fg-dim:#4b5563;
    --border:#2d3039; --border-hairline:#1f2129; --border-input:#3b3f4a;
    --primary:#6366f1; --success:#22c55e; --attention:#f59e0b; --timeline:#a78bfa; --danger:#ef4444;
    --font:-apple-system,BlinkMacSystemFont,"Segoe UI","Inter",Roboto,sans-serif;
    --mono:"SF Mono","JetBrains Mono",Consolas,monospace;
  }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:var(--font); font-size:13px; color:var(--fg); background:var(--bg); height:100vh; overflow:hidden; }
  .app { height:100vh; display:flex; flex-direction:row-reverse; }
  .sidebar { width:208px; background:var(--bg-sidebar); border-left:1px solid var(--border-hairline); display:flex; flex-direction:column; flex-shrink:0; }
  .sidebar-nav { flex:1; overflow-y:auto; padding:6px 8px; }
  .sidebar-row { display:flex; align-items:center; gap:6px; height:28px; padding:0 8px; border-radius:6px; cursor:pointer; font-size:13px; color:var(--fg-muted); }
  .sidebar-row:hover { background:var(--bg-hover); color:var(--fg); }
  .sidebar-row.active { background:var(--bg-muted); color:var(--fg); font-weight:500; }
  .sidebar-row .count { margin-left:auto; font-size:11px; color:var(--fg-dim); }
  .sidebar-row .dot { width:10px; height:10px; border-radius:2px; flex-shrink:0; }
  .sidebar-section-label { padding:8px 8px 4px; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; color:var(--fg-muted); }
  .main-area { flex:1; min-width:0; display:flex; flex-direction:column; }
  .topbar { display:flex; align-items:center; gap:8px; height:44px; padding:0 14px; border-bottom:1px solid var(--border-hairline); }
  .topbar .title { font-weight:600; }
  .view-toggle { display:flex; background:var(--bg-muted); border-radius:6px; padding:2px; margin-left:12px; }
  .view-toggle button { padding:2px 10px; border-radius:3px; font-size:11px; border:none; background:transparent; color:var(--fg-muted); cursor:pointer; }
  .view-toggle button.active { background:var(--bg); color:var(--fg); }
  .view-toggle button:hover:not(.active) { color:var(--fg); }
  .content { flex:1; overflow:auto; min-height:0; }
  .list-header { display:flex; align-items:center; gap:8px; padding:12px 16px 8px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; color:var(--fg-muted); }
  .list-row { display:flex; align-items:center; gap:8px; height:34px; padding:0 16px; cursor:pointer; border-bottom:1px solid var(--border-hairline); }
  .list-row:hover { background:var(--bg-hover); }
  .list-row .key { color:var(--fg-dim); font-size:11px; font-family:var(--mono); width:60px; flex-shrink:0; }
  .list-row .title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .list-row .rail { display:flex; align-items:center; gap:4px; flex-shrink:0; }
  .chip { display:inline-flex; align-items:center; gap:4px; border:1px solid var(--border); border-radius:4px; padding:0 6px; height:18px; font-size:10px; color:var(--fg-muted); white-space:nowrap; }
  .chip .dot { width:6px; height:6px; border-radius:50%; flex-shrink:0; }
  .board { display:flex; height:100%; overflow-x:auto; }
  .board-col { min-width:280px; max-width:320px; flex:1; border-right:1px solid var(--border-hairline); display:flex; flex-direction:column; }
  .board-col-header { display:flex; align-items:center; gap:6px; padding:12px 14px 8px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; color:var(--fg-muted); border-bottom:1px solid var(--border-hairline); }
  .board-col-header .count { font-weight:400; color:var(--fg-dim); }
  .board-col-cards { flex:1; overflow-y:auto; padding:8px; }
  .card { background:var(--bg-raised); border:1px solid var(--border); border-radius:6px; padding:10px 12px; margin-bottom:6px; cursor:pointer; }
  .card:hover { border-color:var(--border-input); background:var(--bg-hover); }
  .card .card-top { display:flex; align-items:center; gap:6px; margin-bottom:6px; }
  .card .card-top .key { font-size:10px; font-family:var(--mono); color:var(--fg-dim); }
  .card .card-title { font-size:12.5px; font-weight:500; margin-bottom:6px; line-height:1.4; }
  .card .card-rail { display:flex; align-items:center; gap:4px; flex-wrap:wrap; }
  /* detail overlay */
  .detail-overlay { position:fixed; inset:0; z-index:100; background:var(--bg-overlay); display:none; align-items:flex-start; justify-content:flex-end; }
  .detail-overlay.open { display:flex; }
  .detail-panel { width:520px; max-width:90vw; height:100%; background:var(--bg); border-left:1px solid var(--border); overflow-y:auto; padding:20px; }
  .detail-panel .key-label { font-family:var(--mono); font-size:11px; color:var(--fg-dim); }
  .detail-panel h2 { font-size:15px; font-weight:600; margin:8px 0 12px; line-height:1.4; }
  .detail-panel .desc { font-size:12.5px; color:var(--fg-muted); line-height:1.6; white-space:pre-wrap; }
  .detail-panel .props { display:grid; grid-template-columns:80px 1fr; gap:8px; margin:16px 0; font-size:12px; }
  .detail-panel .props .k { color:var(--fg-dim); }
  .detail-panel .comments { margin-top:16px; }
  .detail-panel .comments .title { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; color:var(--fg-muted); margin-bottom:8px; }
  .detail-panel .comment { padding:8px 0; border-bottom:1px solid var(--border-hairline); font-size:12px; color:var(--fg-muted); }
  .detail-panel .comment .meta { font-size:11px; margin-bottom:4px; color:var(--fg-dim); }
  .detail-panel .close-btn { position:sticky; top:0; float:right; background:var(--bg-hover); border:1px solid var(--border); color:var(--fg-muted); border-radius:6px; width:28px; height:28px; cursor:pointer; font-size:14px; }
  .empty-state { display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; color:var(--fg-muted); gap:8px; }
</style>
</head>
<body>
<div class="app">
  ${sidebar}
  <main class="main-area">
    <header class="topbar">
      <div class="title">Tasks</div>
      <div class="view-toggle">
        <button class="active" data-view="list" onclick="switchView('list')">List</button>
        <button data-view="board" onclick="switchView('board')">Board</button>
      </div>
    </header>
    <div class="content">
      <div class="list" id="list-view">
        ${listRows(topLevel, labels) || `<div class="empty-state">No tasks yet. Use /issue create to add one.</div>`}
      </div>
      <div class="board" id="board-view" style="display:none">
        ${boardColumns(topLevel, labels)}
      </div>
    </div>
  </main>
</div>
<div class="detail-overlay" id="detail-overlay">
  <div class="detail-panel" id="detail-panel"></div>
</div>
<script>
  const TASKS = ${JSON.stringify(
    topLevel.map((t) => ({
      id: t.id,
      key: t.key,
      title: t.title,
      status: t.status,
      priority: t.priority,
      description: t.description,
      createdAt: t.createdAt,
      labels: t.labelIds
        .map((id) => labels.find((l) => l.id === id))
        .filter((l): l is Label => l !== undefined)
        .map((l) => l.name),
    })),
  )};
  const COMMENTS = ${JSON.stringify(
    Object.fromEntries(
      db.comments
        .slice()
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((c) => [
          c.taskId,
          db.comments.filter((x) => x.taskId === c.taskId),
        ]),
    ),
  )};

  function switchView(view) {
    document.getElementById('list-view').style.display = view === 'list' ? '' : 'none';
    document.getElementById('board-view').style.display = view === 'board' ? '' : 'none';
    document.querySelectorAll('.view-toggle button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  }

  function openDetail(key) {
    const t = TASKS.find(x => x.key === key);
    if (!t) return;
    const comments = COMMENTS[t.id] || [];
    const commentsHtml = comments.map(c => \`
      <div class="comment">
        <div class="meta">\${c.authorName} · \${c.createdAt.slice(0, 10)}</div>
        \${c.body}
      </div>\`).join('');
    document.getElementById('detail-panel').innerHTML = \`
      <button class="close-btn" onclick="document.getElementById('detail-overlay').classList.remove('open')">×</button>
      <div class="key-label">\${t.key}</div>
      <h2>\${t.title}</h2>
      <div class="props">
        <span class="k">Status</span><span>\${t.status}</span>
        <span class="k">Priority</span><span>\${t.priority}</span>
        <span class="k">Labels</span><span>\${t.labels.join(', ') || '—'}</span>
        <span class="k">Created</span><span>\${t.createdAt.slice(0, 10)}</span>
      </div>
      <div class="desc">\${t.description || '(no description)'}</div>
      <div class="comments">
        <div class="title">Activity</div>
        \${commentsHtml || '<div class="comment" style="color:var(--fg-dim)">No comments yet.</div>'}
      </div>
    \`;
    document.getElementById('detail-overlay').classList.add('open');
  }

  document.querySelectorAll('[data-task]').forEach(el => {
    el.addEventListener('click', () => openDetail(el.dataset.task));
  });
  document.getElementById('detail-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
  });

  // ⌘W / Ctrl+W closes the board window (native close, same as the titlebar button).
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      window.glimpse?.close();
    }
  });
</script>
</body>
</html>`;
  return html;
}

const WINDOW_OPTIONS: GlimpseWindowOptions = {
  width: 1100,
  height: 720,
  title: "Tasks",
};

export async function openTasksBoard(projectRoot: string): Promise<void> {
  const html = await createTasksHtml(projectRoot);
  openGlimpseWindow(html, WINDOW_OPTIONS);
}
