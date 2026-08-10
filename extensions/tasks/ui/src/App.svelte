<script lang="ts">
// Tasks interactive UI — 方案 1 (card-inline delegation) + creation UX.
// State comes entirely from bridge snapshots (host broadcasts on every
// tasks.json change, including herdr child-agent writes).
import { onMount } from "svelte";
import { mutate, onBridgeEvent, send, type TasksDb } from "./bridge.ts";
import Button from "./components/Button.svelte";
import DelegateForm from "./DelegateForm.svelte";
import DeleteTaskDialog from "./DeleteTaskDialog.svelte";

type Status =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "canceled";
type Priority = "urgent" | "high" | "medium" | "low" | "none";

const STATUS_ORDER: Status[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
];
const STATUS_LABEL: Record<Status, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  canceled: "Canceled",
};
const PRIORITY_LABEL: Record<Priority, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "None",
};
const STATUS_COLORS: Record<Status, string> = {
  backlog: "#6b7280",
  todo: "#6b7280",
  in_progress: "#f59e0b",
  in_review: "#a78bfa",
  done: "#22c55e",
  canceled: "#6b7280",
};
const PROJECT_COLORS = [
  "#6366f1",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#a78bfa",
  "#06b6d4",
];

let db = $state<TasksDb | null>(null);
let selectedKey = $state<string | null>(null);
let draftKey = $state<string | null>(null);
let deleteKey = $state<string | null>(null);
let deletingKey = $state<string | null>(null);
let openMenuKey = $state<string | null>(null);
let editingProjectId = $state<string | null>(null);
let editError = $state("");
let deleteProjectId = $state<string | null>(null);
let deletingProjectId = $state<string | null>(null);
let deletingProjectName = $state("");
let modal = $state<null | "task" | "project" | "folder">(null);
let toast = $state("");
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let now = $state(Date.now());
let commentDraft = $state("");
let formError = $state("");

let taskForm = $state({
  title: "",
  projectPrefix: "",
  priority: "medium",
  status: "todo",
  labels: [] as string[],
  parentKey: "",
  description: "",
});
let projectForm = $state({
  name: "",
  prefix: "",
  color: "#6366f1",
  folderId: "",
});
let editForm = $state({ name: "", color: "#6366f1", folderId: "" });
let folderForm = $state({ name: "", parentFolderId: "" });

onMount(() => {
  onBridgeEvent((e) => {
    if (e.type === "snapshot") {
      db = e.db;
      if (deletingKey && !e.db.tasks.some((task) => task.key === deletingKey)) {
        showToast(`已删除 ${deletingKey}`);
        deletingKey = null;
      }
      if (deletingProjectId) {
        if (!e.db.projects.some((p) => p.id === deletingProjectId)) {
          showToast(`已删除项目 ${deletingProjectName}`);
          deletingProjectId = null;
        }
      }
    } else {
      deletingKey = null;
      deletingProjectId = null;
      showToast(e.message);
    }
  });
  send({ type: "get-snapshot" });
  const tick = setInterval(() => (now = Date.now()), 1000);

  // ⌘W (macOS) / Ctrl+W closes the window — same as the titlebar button.
  const closeHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (deleteProjectId) {
        deleteProjectId = null;
      } else if (editingProjectId) {
        editingProjectId = null;
      } else if (deleteKey) {
        deleteKey = null;
      } else {
        openMenuKey = null;
      }
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "w") {
      e.preventDefault();
      window.glimpse?.close();
    }
  };
  document.addEventListener("keydown", closeHandler);

  return () => {
    clearInterval(tick);
    document.removeEventListener("keydown", closeHandler);
  };
});

function showToast(message: string) {
  toast = message;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast = ""), 5000);
}

/* ---- selectors ---- */

const projects = $derived(db?.projects ?? []);
const tasks = $derived(db?.tasks ?? []);
const topLevel = $derived(tasks.filter((t) => !t.parentTaskId));
const selected = $derived(tasks.find((t) => t.key === selectedKey) ?? null);
const deleteCandidate = $derived(deleteKey ? taskByKey(deleteKey) : null);
const deleteDescendants = $derived(
  deleteCandidate ? descendantsOf(deleteCandidate.id) : [],
);
const deleteCommentCount = $derived(
  deleteCandidate
    ? (db?.comments ?? []).filter((comment) =>
        [
          deleteCandidate.id,
          ...deleteDescendants.map((task) => task.id),
        ].includes(comment.taskId),
      ).length
    : 0,
);
const delegatedTasks = $derived(tasks.filter((t) => t.delegation));
const editingProject = $derived(
  editingProjectId
    ? (projects.find((p) => p.id === editingProjectId) ?? null)
    : null,
);
const deletingProject = $derived(
  deleteProjectId
    ? (projects.find((p) => p.id === deleteProjectId) ?? null)
    : null,
);
const deletingProjectStats = $derived(
  deletingProject
    ? {
        tasks: tasks.filter((t) => t.projectId === deletingProject.id).length,
        labels: (db?.labels ?? []).filter(
          (l) => l.projectId === deletingProject.id,
        ).length,
        comments: (db?.comments ?? []).filter((c) =>
          tasks.some(
            (t) => t.projectId === deletingProject.id && t.id === c.taskId,
          ),
        ).length,
      }
    : { tasks: 0, labels: 0, comments: 0 },
);

function projectById(id: string) {
  return db?.projects.find((p) => p.id === id) ?? null;
}
function projectByPrefix(prefix: string) {
  return db?.projects.find((p) => p.prefix === prefix) ?? null;
}
function taskByKey(key: string) {
  return tasks.find((t) => t.key.toUpperCase() === key.toUpperCase()) ?? null;
}
function taskLabels(taskId: string) {
  const task = tasks.find((t) => t.id === taskId);
  if (!task || !db) return [];
  return db.labels.filter((l) => task.labelIds.includes(l.id));
}
function labelOptionsFor(projectId: string) {
  return db?.labels.filter((l) => l.projectId === projectId) ?? [];
}
function subtasksOf(taskId: string) {
  return tasks.filter((t) => t.parentTaskId === taskId);
}
function descendantsOf(taskId: string) {
  const descendantIds = new Set<string>();
  const pendingIds = [taskId];
  while (pendingIds.length > 0) {
    const parentId = pendingIds.pop();
    if (!parentId) continue;
    for (const task of tasks) {
      if (task.parentTaskId === parentId && !descendantIds.has(task.id)) {
        descendantIds.add(task.id);
        pendingIds.push(task.id);
      }
    }
  }
  return tasks.filter((task) => descendantIds.has(task.id));
}
function commentsOf(taskId: string) {
  return (db?.comments ?? [])
    .filter((c) => c.taskId === taskId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
function projectTasks(projectId: string) {
  return tasks.filter((t) => t.projectId === projectId);
}
function statusCount(status: Status) {
  return topLevel.filter((t) => t.status === status).length;
}
function canDelegate(task: TasksDb["tasks"][number]): boolean {
  return (
    !task.delegation && task.status !== "done" && task.status !== "canceled"
  );
}
function canDelete(task: TasksDb["tasks"][number]): boolean {
  return (
    task.status === "backlog" &&
    !task.delegation &&
    descendantsOf(task.id).every(
      (descendant) => descendant.status === "backlog" && !descendant.delegation,
    )
  );
}
function shortAgent(id: string): string {
  return id.split("·").slice(1).join("·").trim() || id;
}
function fmtAgo(iso: string): string {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s 前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  return `${Math.floor(m / 60)} 小时前`;
}
function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* ---- actions (fire-and-forget; snapshot broadcast updates UI) ---- */

function openModal(kind: "task" | "project" | "folder") {
  formError = "";
  modal = kind;
}

function toggleTaskLabel(name: string, on: boolean) {
  taskForm.labels = on
    ? [...taskForm.labels, name]
    : taskForm.labels.filter((l) => l !== name);
}

function submitTask() {
  const title = taskForm.title.trim();
  if (!title) {
    formError = "标题不能为空";
    return;
  }
  mutate({
    type: "create-task",
    title,
    projectPrefix: taskForm.projectPrefix || (projects[0]?.prefix ?? ""),
    priority: taskForm.priority,
    status: taskForm.status,
    description: taskForm.description,
    labelNames: taskForm.labels,
    parentKey: taskForm.parentKey || undefined,
  });
  taskForm = {
    title: "",
    projectPrefix: "",
    priority: "medium",
    status: "todo",
    labels: [],
    parentKey: "",
    description: "",
  };
  modal = null;
}

function submitProject() {
  const name = projectForm.name.trim();
  const prefix = projectForm.prefix.trim().toUpperCase();
  if (!name) {
    formError = "项目名称不能为空";
    return;
  }
  if (!/^[A-Z][A-Z0-9]*$/.test(prefix) || prefix.length > 10) {
    formError = "前缀须为大写字母开头、字母数字、1–10 位";
    return;
  }
  mutate({
    type: "create-project",
    name,
    prefix,
    color: projectForm.color,
    folderId: projectForm.folderId || undefined,
  });
  projectForm = { name: "", prefix: "", color: "#6366f1", folderId: "" };
  modal = null;
}

function submitFolder() {
  const name = folderForm.name.trim();
  if (!name) {
    formError = "文件夹名称不能为空";
    return;
  }
  mutate({
    type: "create-folder",
    name,
    parentFolderId: folderForm.parentFolderId || undefined,
  });
  folderForm = { name: "", parentFolderId: "" };
  modal = null;
}

function submitComment() {
  const body = commentDraft.trim();
  if (!body || !selected) return;
  mutate({ type: "comment", taskKey: selected.key, body });
  commentDraft = "";
}

function reclaim(taskKey: string) {
  mutate({ type: "reclaim", taskKey });
}

function cleanupWorktree(taskKey: string) {
  mutate({ type: "worktree-remove", taskKey });
}

function requestDelete(taskKey: string) {
  const task = taskByKey(taskKey);
  openMenuKey = null;
  if (task && canDelete(task)) deleteKey = task.key;
}

function confirmDelete() {
  if (!deleteCandidate || !canDelete(deleteCandidate)) {
    deleteKey = null;
    return;
  }
  deletingKey = deleteCandidate.key;
  selectedKey = null;
  deleteKey = null;
  mutate({ type: "delete-task", taskKey: deletingKey });
}

function openProjectEdit(project: TasksDb["projects"][number]) {
  openMenuKey = null;
  editingProjectId = project.id;
  editError = "";
  editForm = {
    name: project.name,
    color: project.color,
    folderId: project.folderId ?? "",
  };
}

function submitProjectEdit() {
  const project = editingProject;
  if (!project) return;
  const name = editForm.name.trim();
  if (!name) {
    editError = "项目名称不能为空";
    return;
  }
  mutate({
    type: "update-project",
    projectId: project.id,
    name,
    color: editForm.color,
    folderId: editForm.folderId || undefined,
  });
  editingProjectId = null;
}

function requestProjectDelete(project: TasksDb["projects"][number]) {
  openMenuKey = null;
  deleteProjectId = project.id;
}

function confirmProjectDelete() {
  if (!deletingProject) {
    deleteProjectId = null;
    return;
  }
  deletingProjectId = deletingProject.id;
  deletingProjectName = deletingProject.name;
  deleteProjectId = null;
  if (
    selected &&
    tasks.find((t) => t.key === selected.key)?.projectId === deletingProjectId
  ) {
    selectedKey = null;
  }
  mutate({ type: "delete-project", projectId: deletingProjectId });
}

function confirmDelegate(
  key: string,
  instructions: string,
  worktree: boolean,
  baseBranch: string,
  branch: string,
) {
  mutate({
    type: "delegate",
    taskKey: key,
    instructions: instructions || undefined,
    worktree,
    baseBranch,
    branch,
  });
  draftKey = null;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task"
  );
}
</script>

{#snippet projectRow(p: TasksDb["projects"][number])}
  <div class="nav-row project-row">
    <span class="dot" style="background:{p.color}"></span>
    <span class="project-name">{p.name}</span>
    <span class="cnt">{projectTasks(p.id).length}</span>
    <button
      class="task-menu-trigger project-menu-trigger"
      type="button"
      aria-label={`更多操作：${p.name}`}
      aria-expanded={openMenuKey === `project:${p.id}`}
      onclick={(event) => {
        event.stopPropagation();
        const key = `project:${p.id}`;
        openMenuKey = openMenuKey === key ? null : key;
      }}
    >⋯</button>
    {#if openMenuKey === `project:${p.id}`}
      <div class="task-menu project-menu" role="menu">
        <button type="button" role="menuitem" onclick={() => openProjectEdit(p)}>编辑项目</button>
        <button type="button" role="menuitem" class="danger" onclick={() => requestProjectDelete(p)}>删除项目</button>
      </div>
    {/if}
  </div>
{/snippet}

<div class="app">
  <!-- Sidebar -->
  <aside class="sidebar">
    <div class="brand"><span class="brand-icon">◧</span> Tasks</div>
    <nav class="nav">
      <div class="nav-row active">
        <span>▦</span> 看板 <span class="cnt">{topLevel.length}</span>
      </div>
    </nav>
    <div class="section-label">
      Folders
      <button class="plus" onclick={() => openModal("folder")} title="新建文件夹">+</button>
    </div>
    {#each db?.folders.filter((f) => !f.parentFolderId) ?? [] as f}
      <div class="nav-row folder-row">
        <span class="folder-icon">▸</span> {f.name}
      </div>
      {#each projects.filter((p) => p.folderId === f.id) as p}
        {@render projectRow(p)}
      {/each}
    {/each}
    <div class="section-label">
      Projects
      <button class="plus" onclick={() => openModal("project")} title="新建项目">+</button>
    </div>
    {#each projects.filter((p) => !p.folderId) as p}
      {@render projectRow(p)}
    {/each}
  </aside>

  <!-- Main: board -->
  <main class="main">
    <div class="topbar">
      <span class="topbar-title">看板</span>
      <Button size="sm" variant="primary" onclick={() => openModal("task")}>+ 新建任务</Button>
      {#if delegatedTasks.length > 0}
        <span class="live-badge"><span class="pulse-dot"></span> 委托中 {delegatedTasks.length}</span>
      {/if}
    </div>
    {#if !db}
      <div class="empty-state">加载中…</div>
    {:else if projects.length === 0}
      <div class="empty-state">
        <div>还没有项目</div>
        <div class="empty-hint">先创建一个项目，任务 key 将以项目前缀命名</div>
        <Button variant="primary" onclick={() => openModal("project")}>新建项目</Button>
      </div>
    {:else}
      <div class="board">
        {#each STATUS_ORDER as s (s)}
          {@const st = s as Status}
          <div class="board-col">
            <div class="col-header">
              <span class="status-dot" style="--c:{STATUS_COLORS[st]}"></span>
              {STATUS_LABEL[st]}
              <span class="cnt">{statusCount(st)}</span>
            </div>
            <div class="col-cards">
              {#each topLevel.filter((t) => t.status === st) as t (t.key)}
                <div
                  class="card"
                  role="button"
                  tabindex="0"
                  onclick={() => (selectedKey = t.key)}
                  onkeydown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      selectedKey = t.key;
                    }
                  }}
                >
                  <div class="card-top">
                    <span class="key">{t.key}</span>
                    {#if canDelete(t)}
                      <button
                        class="task-menu-trigger"
                        type="button"
                        aria-label={`更多操作：${t.key}`}
                        aria-expanded={openMenuKey === t.key}
                        onclick={(event) => {
                          event.stopPropagation();
                          openMenuKey = openMenuKey === t.key ? null : t.key;
                        }}
                      >⋯</button>
                      {#if openMenuKey === t.key}
                        <div class="task-menu" role="menu">
                          <button
                            type="button"
                            role="menuitem"
                            onclick={(event) => {
                              event.stopPropagation();
                              requestDelete(t.key);
                            }}
                          >删除任务</button>
                        </div>
                      {/if}
                    {/if}
                    {#if t.delegation}
                      <span class="chip live-chip" title={t.delegation.agentId}>
                        <span class="pulse-dot"></span>
                        {shortAgent(t.delegation.agentId)}
                      </span>
                    {:else if t.status === "in_review" && commentsOf(t.id).some((c) => c.kind === "agent")}
                      <span class="chip review-chip">待审查</span>
                    {/if}
                  </div>
                  <div class="card-title">{t.title}</div>
                  <div class="card-rail">
                    {#each taskLabels(t.id) as l}
                      <span class="chip" style="--lc:{l.color}">{l.name}</span>
                    {/each}
                    {#if t.priority !== "none"}
                      <span class="chip prio prio-{t.priority}">{PRIORITY_LABEL[t.priority]}</span>
                    {/if}
                  </div>
                  {#if canDelegate(t) || t.delegation}
                    <div class="card-actions">
                      {#if t.delegation}
                        <Button
                          size="sm"
                          variant="danger"
                          onclick={(e) => {
                            e.stopPropagation();
                            reclaim(t.key);
                          }}
                        >回收</Button>
                      {:else}
                        <Button
                          size="sm"
                          variant="primary"
                          onclick={(e) => {
                            e.stopPropagation();
                            draftKey = t.key;
                          }}
                        >委托</Button>
                      {/if}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </main>
</div>

<!-- Detail overlay -->
{#if selected}
  {@const selProject = projectById(selected.projectId)}
  <div
    class="overlay"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) selectedKey = null;
    }}
  >
    <div class="detail">
      <div class="detail-head">
        <div>
          <div class="key-label">{selected.key}</div>
          <h2>{selected.title}</h2>
        </div>
        <div class="detail-header-actions">
          {#if canDelete(selected)}
            <button
              class="task-menu-trigger"
              type="button"
              aria-label={`更多操作：${selected.key}`}
              aria-expanded={openMenuKey === selected.key}
              onclick={() => (openMenuKey = openMenuKey === selected.key ? null : selected.key)}
            >⋯</button>
            {#if openMenuKey === selected.key}
              <div class="task-menu detail-task-menu" role="menu">
                <button type="button" role="menuitem" onclick={() => requestDelete(selected.key)}>删除任务</button>
              </div>
            {/if}
          {/if}
          <Button size="sm" class="size-7 !p-0" onclick={() => (selectedKey = null)}>×</Button>
        </div>
      </div>

      <div class="props">
        <div class="prop"><span class="k">Status</span><span>{STATUS_LABEL[selected.status]}</span></div>
        <div class="prop"><span class="k">Priority</span><span>{PRIORITY_LABEL[selected.priority]}</span></div>
        <div class="prop"><span class="k">Project</span><span>{selProject?.name ?? selected.projectId}</span></div>
        {#if selected.delegation}
          <div class="prop"><span class="k">Agent</span><span class="live-text"><span class="pulse-dot"></span>{shortAgent(selected.delegation.agentId)}</span></div>
          <div class="prop"><span class="k">Started</span><span>{fmtAgo(selected.delegation.startedAt)}</span></div>
          {#if selected.delegation.worktreePath}
            <div class="prop"><span class="k">Branch</span><span class="mono">{selected.delegation.baseBranch ?? ""}{selected.delegation.baseBranch ? " → " : ""}{selected.delegation.branch}</span></div>
            <div class="prop"><span class="k">Path</span><span class="mono">{selected.delegation.worktreePath}</span></div>
          {/if}
        {/if}
        {#if subtasksOf(selected.id).length > 0}
          <div class="prop"><span class="k">子任务</span><span>{subtasksOf(selected.id).map((s) => `${s.key} (${STATUS_LABEL[s.status]})`).join("、")}</span></div>
        {/if}
      </div>

      {#if selected.description}
        <div class="desc">{selected.description}</div>
      {/if}

      <!-- Delegation actions -->
      {#if selected.delegation}
        <div class="action-box">
          <div class="action-title">委托中 · {shortAgent(selected.delegation.agentId)}</div>
          <div class="agent-feed">
            {#each commentsOf(selected.id).filter((c) => c.kind !== "user").slice(-3) as c (c.id)}
              <div class="feed-row">
                <span class="feed-kind {c.kind}">{c.kind === "system" ? "sys" : "agent"}</span>
                <span class="feed-body">{c.body}</span>
                <span class="feed-time">{fmtClock(c.createdAt)}</span>
              </div>
            {/each}
          </div>
          <div class="agent-actions">
            {#if selected.delegation.worktreePath}
              <Button size="sm" onclick={() => cleanupWorktree(selected.key)}>清理 worktree</Button>
            {/if}
            <Button size="sm" variant="danger" onclick={() => reclaim(selected.key)}>回收</Button>
          </div>
        </div>
      {:else if canDelegate(selected)}
        <div class="action-box">
          <DelegateForm
            taskKey={selected.key}
            defaultBranch={`task/${selected.key.toLowerCase()}-${slugify(selected.title)}`}
            onConfirm={(ins, wt, base, br) => confirmDelegate(selected.key, ins, wt, base, br)}
            onCancel={() => (draftKey = null)}
          />
        </div>
      {/if}

      <!-- Comments -->
      <div class="comments">
        <div class="comments-title">评论 · {commentsOf(selected.id).length}</div>
        <div class="comment-box">
          <textarea bind:value={commentDraft} rows="2" placeholder="写评论…（Enter 发送）"></textarea>
          <Button size="sm" variant="primary" onclick={submitComment}>发送</Button>
        </div>
        {#each commentsOf(selected.id) as c (c.id)}
          <div class="comment">
            <div class="comment-meta">
              <span class="feed-kind {c.kind}">{c.kind}</span>
              <span>{c.authorName}</span>
              <span class="dim">{fmtClock(c.createdAt)} · {fmtAgo(c.createdAt)}</span>
            </div>
            <div class="comment-body">{c.body}</div>
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}

{#if deleteCandidate}
  <DeleteTaskDialog
    task={deleteCandidate}
    descendantCount={deleteDescendants.length}
    commentCount={deleteCommentCount}
    onCancel={() => (deleteKey = null)}
    onConfirm={confirmDelete}
  />
{/if}

<!-- Delegate popover (card-inline, 方案 1) -->
{#if draftKey}
  {@const draft = taskByKey(draftKey)}
  {#if draft}
    <div
      class="overlay"
      role="presentation"
      onclick={(e) => {
        if (e.target === e.currentTarget) draftKey = null;
      }}
    >
      <div class="popover">
        <DelegateForm
          taskKey={draft.key}
          defaultBranch={`task/${draft.key.toLowerCase()}-${slugify(draft.title)}`}
          onConfirm={(ins, wt, base, br) => confirmDelegate(draft.key, ins, wt, base, br)}
          onCancel={() => (draftKey = null)}
        />
      </div>
    </div>
  {/if}
{/if}

<!-- Project edit modal -->
{#if editingProject}
  <div
    class="overlay"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) editingProjectId = null;
    }}
  >
    <div class="popover">
      <div class="modal-title">编辑项目</div>
      <div class="task-form-grid">
        <label class="task-form-label" for="f-edit-name">名称 *</label>
        <input class="task-form-control" id="f-edit-name" bind:value={editForm.name} placeholder="产品开发" />
        <span class="task-form-label">前缀</span>
        <div class="prefix-note">{editingProject.prefix}（创建后不可修改）</div>
        <span class="task-form-label">颜色</span>
        <div class="task-check-group">
          {#each PROJECT_COLORS as c}
            <button
              type="button"
              class="color-swatch"
              style="background:{c}"
              class:selected={editForm.color === c}
              aria-label={`选择颜色 ${c}`}
              onclick={() => (editForm.color = c)}
            ></button>
          {/each}
        </div>
        <label class="task-form-label" for="f-edit-folder">文件夹</label>
        <select class="task-form-control task-select" id="f-edit-folder" bind:value={editForm.folderId}>
          <option value="">（不挂文件夹）</option>
          {#each db?.folders ?? [] as f}
            <option value={f.id}>{f.name}</option>
          {/each}
        </select>
      </div>
      {#if editError}
        <div class="task-form-error">{editError}</div>
      {/if}
      <div class="task-actions">
        <Button onclick={() => (editingProjectId = null)}>取消</Button>
        <Button variant="primary" onclick={submitProjectEdit}>保存</Button>
      </div>
    </div>
  </div>
{/if}

<!-- Project delete confirm -->
{#if deletingProject}
  <div
    class="overlay"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) deleteProjectId = null;
    }}
  >
    <div class="popover">
      <div class="modal-title">删除项目</div>
      <div class="delete-summary">
        <code>{deletingProject.prefix}</code>
        <span>{deletingProject.name}</span>
      </div>
      <div class="delete-copy">此操作会同时删除：</div>
      <ul class="delete-impact">
        <li>{deletingProjectStats.tasks} 个任务</li>
        <li>{deletingProjectStats.labels} 个标签</li>
        <li>{deletingProjectStats.comments} 条评论</li>
      </ul>
      <div class="delete-warning">此操作不可恢复。</div>
      <div class="task-actions">
        <Button onclick={() => (deleteProjectId = null)}>取消</Button>
        <Button variant="danger" onclick={confirmProjectDelete}>删除项目</Button>
      </div>
    </div>
  </div>
{/if}

{#if modal}
  <div
    class="overlay"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) modal = null;
    }}
  >
    <div class="popover wide">
      {#if modal === "task"}
        <div class="modal-title">新建任务</div>
        <div class="task-form-grid">
          <label class="task-form-label" for="f-task-title">标题 *</label>
          <input class="task-form-control" id="f-task-title" bind:value={taskForm.title} placeholder="任务标题" />
          <label class="task-form-label" for="f-task-project">项目</label>
          <select class="task-form-control task-select" id="f-task-project" bind:value={taskForm.projectPrefix}>
            {#each projects as p}
              <option value={p.prefix}>{p.name} ({p.prefix})</option>
            {/each}
          </select>
          <label class="task-form-label" for="f-task-priority">优先级</label>
          <select class="task-form-control task-select" id="f-task-priority" bind:value={taskForm.priority}>
            {#each Object.entries(PRIORITY_LABEL) as [v, l]}
              <option value={v}>{l}</option>
            {/each}
          </select>
          <label class="task-form-label" for="f-task-status">状态</label>
          <select class="task-form-control task-select" id="f-task-status" bind:value={taskForm.status}>
            {#each Object.entries(STATUS_LABEL) as [v, l]}
              <option value={v}>{l}</option>
            {/each}
          </select>
          <span class="task-form-label">标签</span>
          {#each [projectByPrefix(taskForm.projectPrefix || (projects[0]?.prefix ?? ""))] as labelProject}
            <div class="task-check-group">
              {#each labelOptionsFor(labelProject?.id ?? "") as l}
                <label class="f-check">
                  <input
                    type="checkbox"
                    checked={taskForm.labels.includes(l.name)}
                    onchange={(e) => toggleTaskLabel(l.name, e.currentTarget.checked)}
                  />
                  <span class="chip" style="--lc:{l.color}">{l.name}</span>
                </label>
              {/each}
            </div>
          {/each}
          <label class="task-form-label" for="f-task-parent">父任务</label>
          <select class="task-form-control task-select" id="f-task-parent" bind:value={taskForm.parentKey}>
            <option value="">（无）</option>
            {#each topLevel as t}
              <option value={t.key}>{t.key} · {t.title}</option>
            {/each}
          </select>
          <label class="task-form-label" for="f-task-desc">描述</label>
          <textarea class="task-form-control resize-y" id="f-task-desc" bind:value={taskForm.description} rows="3" placeholder="可选"></textarea>
        </div>
      {:else if modal === "project"}
        <div class="modal-title">新建项目</div>
        <div class="task-form-grid">
          <label class="task-form-label" for="f-proj-name">名称 *</label>
          <input class="task-form-control" id="f-proj-name" bind:value={projectForm.name} placeholder="产品开发" />
          <label class="task-form-label" for="f-proj-prefix">前缀 *</label>
          <input
            class="task-form-control task-mono"
            id="f-proj-prefix"
            bind:value={projectForm.prefix}
            placeholder="PROD（大写字母开头，1–10 位，全局唯一）"
            spellcheck="false"
          />
          <span class="task-form-label">颜色</span>
          <div class="task-check-group">
            {#each ["#6366f1", "#22c55e", "#f59e0b", "#ef4444", "#a78bfa", "#06b6d4"] as c}
              <label
                class="color-swatch"
                style="background:{c}"
                class:selected={projectForm.color === c}
              >
                <input
                  type="radio"
                  name="proj-color"
                  checked={projectForm.color === c}
                  onchange={() => (projectForm.color = c)}
                />
              </label>
            {/each}
          </div>
          <label class="task-form-label" for="f-proj-folder">文件夹</label>
          <select class="task-form-control task-select" id="f-proj-folder" bind:value={projectForm.folderId}>
            <option value="">（不挂文件夹）</option>
            {#each db?.folders ?? [] as f}
              <option value={f.id}>{f.name}</option>
            {/each}
          </select>
        </div>
      {:else}
        <div class="modal-title">新建文件夹</div>
        <div class="task-form-grid">
          <label class="task-form-label" for="f-folder-name">名称 *</label>
          <input class="task-form-control" id="f-folder-name" bind:value={folderForm.name} placeholder="Sprint" />
          <label class="task-form-label" for="f-folder-parent">父文件夹</label>
          <select class="task-form-control task-select" id="f-folder-parent" bind:value={folderForm.parentFolderId}>
            <option value="">（无，顶层）</option>
            {#each db?.folders.filter((f) => !f.parentFolderId) ?? [] as f}
              <option value={f.id}>{f.name}</option>
            {/each}
          </select>
        </div>
      {/if}
      {#if formError}
        <div class="task-form-error">{formError}</div>
      {/if}
      <div class="task-actions">
        <Button onclick={() => (modal = null)}>取消</Button>
        <Button
          variant="primary"
          onclick={modal === "task"
            ? submitTask
            : modal === "project"
              ? submitProject
              : submitFolder}
        >
          创建
        </Button>
      </div>
    </div>
  </div>
{/if}

<!-- Toast -->
{#if toast}
  <div class="toast">{toast}</div>
{/if}

<style>
  .app {
    height: 100vh;
    display: flex;
    flex-direction: row;
  }

  /* Sidebar */
  .sidebar {
    width: 200px;
    background: #0b0d12;
    border-right: 1px solid #1f2129;
    display: flex;
    flex-direction: column;
    padding: 10px 8px;
    flex-shrink: 0;
    overflow-y: auto;
  }
  .brand {
    font-size: 14px;
    font-weight: 700;
    padding: 4px 8px 14px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .brand-icon {
    color: #6366f1;
  }
  .nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-bottom: 12px;
  }
  .nav-row {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 28px;
    padding: 0 8px;
    border-radius: 6px;
    cursor: pointer;
    color: #6b7280;
  }
  .nav-row.active {
    background: #22252e;
    color: #e5e7eb;
    font-weight: 500;
  }
  .nav-row .cnt {
    margin-left: auto;
    font-size: 11px;
    color: #4b5563;
  }
  .section-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 8px 4px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #4b5563;
  }
  .section-label .plus {
    background: transparent;
    border: none;
    color: #6b7280;
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    padding: 0 4px;
    border-radius: 4px;
  }
  .section-label .plus:hover {
    color: #e5e7eb;
    background: #1c1f26;
  }
  .folder-row {
    color: #9ca3af;
    font-weight: 600;
  }
  .folder-icon {
    font-size: 9px;
    color: #4b5563;
  }
  .project-row {
    position: relative;
    padding-left: 22px;
  }
  .project-row .project-name {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .project-row .cnt {
    margin-left: 0;
  }
  .project-menu-trigger {
    display: none;
    margin: -2px -4px -2px 0;
    font-size: 13px;
  }
  .project-row:hover .project-menu-trigger,
  .project-menu-trigger[aria-expanded="true"] {
    display: grid;
  }
  .project-menu {
    top: 26px;
    right: 6px;
    width: 132px;
  }
  .project-menu button {
    color: #9ca3af;
  }
  .project-menu button:hover {
    background: #1c1f26;
    color: #e5e7eb;
  }
  .project-menu button.danger {
    color: #f87171;
  }
  .project-menu button.danger:hover {
    background: #2a1215;
    color: #f87171;
  }
  .nav-row .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  /* Main */
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .topbar {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 44px;
    padding: 0 14px;
    border-bottom: 1px solid #1f2129;
    flex-shrink: 0;
  }
  .topbar-title {
    font-weight: 600;
    font-size: 13px;
  }
  .live-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: #f59e0b;
    border: 1px solid #7c5a1e;
    background: #1a160d;
    border-radius: 4px;
    padding: 2px 8px;
  }
  .board {
    display: flex;
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    overflow-y: hidden;
    overscroll-behavior-inline: contain;
  }
  .board-col {
    min-width: 190px;
    flex: 1 0 190px;
    border-right: 1px solid #1f2129;
    display: flex;
    flex-direction: column;
  }
  .col-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 12px 14px 8px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #6b7280;
    border-bottom: 1px solid #1f2129;
  }
  .col-header .cnt {
    font-weight: 400;
    color: #4b5563;
  }
  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--c);
  }
  .col-cards {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
  }

  /* Card */
  .card {
    position: relative;
    background: #16181f;
    border: 1px solid #2d3039;
    border-radius: 6px;
    padding: 10px 12px;
    margin-bottom: 6px;
    cursor: pointer;
    transition: border-color 0.12s;
  }
  .card:hover {
    border-color: #3b3f4a;
    background: #1c1f26;
  }
  .card:focus-visible {
    outline: 2px solid #6366f1;
    outline-offset: 1px;
  }
  .card-top {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
    flex-wrap: wrap;
  }
  .task-menu-trigger {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    margin: -4px -4px -4px auto;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: #6b7280;
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
  }
  .task-menu-trigger:hover,
  .task-menu-trigger[aria-expanded="true"] {
    background: #292d38;
    color: #e5e7eb;
  }
  .task-menu {
    position: absolute;
    z-index: 20;
    top: 32px;
    right: 8px;
    width: 124px;
    overflow: hidden;
    border: 1px solid #404552;
    border-radius: 8px;
    background: #20232c;
    box-shadow: 0 14px 30px rgba(0, 0, 0, 0.42);
  }
  .task-menu button {
    display: block;
    width: 100%;
    border: 0;
    background: transparent;
    padding: 8px 10px;
    color: #f87171;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    text-align: left;
  }
  .task-menu button:hover {
    background: #2a1215;
  }
  .card-top .key {
    font-size: 10px;
    font-family: "SF Mono", "JetBrains Mono", Consolas, monospace;
    color: #4b5563;
  }
  .card-title {
    font-size: 12.5px;
    font-weight: 500;
    margin-bottom: 6px;
    line-height: 1.4;
  }
  .card-rail {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
  }
  .card-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 8px;
    padding-top: 6px;
    border-top: 1px dashed #22252e;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border: 1px solid #2d3039;
    border-radius: 4px;
    padding: 0 6px;
    height: 18px;
    font-size: 10px;
    color: #6b7280;
    white-space: nowrap;
  }
  .chip[style*="--lc"] {
    color: var(--lc, #6b7280);
    border-color: var(--lc, #2d3039);
  }
  .live-chip {
    color: #f59e0b;
    border-color: #7c5a1e;
    background: #1a160d;
  }
  .review-chip {
    color: #a78bfa;
    border-color: #5b4b8a;
    background: #171226;
  }
  .prio {
    border-color: transparent;
  }
  .prio-urgent {
    color: #ef4444;
    background: #2a1215;
  }
  .prio-high {
    color: #f97316;
    background: #241509;
  }
  .prio-medium {
    color: #f59e0b;
    background: #1f180a;
  }
  .prio-low {
    color: #6b7280;
    background: #16181f;
  }

  .pulse-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #f59e0b;
    animation: pulse 1.2s ease-in-out infinite;
    flex-shrink: 0;
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
      box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.5);
    }
    50% {
      opacity: 0.6;
      box-shadow: 0 0 0 4px rgba(245, 158, 11, 0);
    }
  }

  .empty-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: #6b7280;
  }
  .empty-hint {
    font-size: 12px;
    color: #4b5563;
  }

  /* Overlay / detail */
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: stretch;
    justify-content: flex-end;
    overflow-y: auto;
    background: rgba(0, 0, 0, 0.62);
    backdrop-filter: blur(2px);
  }
  .detail {
    width: min(540px, 92vw);
    height: 100%;
    min-width: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 24px;
    background: #0f1117;
    border-left: 1px solid #2d3039;
    box-shadow: -18px 0 40px rgba(0, 0, 0, 0.24);
  }
  .detail-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding-bottom: 16px;
    margin-bottom: 18px;
    border-bottom: 1px solid #1f2129;
  }
  .detail-header-actions {
    position: relative;
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 4px;
  }
  .detail-task-menu {
    top: 30px;
    right: 32px;
  }
  .detail-head > div:first-child {
    min-width: 0;
  }
  .detail-head :global(.size-7) {
    flex: 0 0 28px;
    width: 28px;
    height: 28px;
    padding: 0;
    font-size: 18px;
    line-height: 1;
  }
  .key-label {
    font-family: "SF Mono", "JetBrains Mono", Consolas, monospace;
    font-size: 11px;
    color: #6366f1;
  }
  .detail h2 {
    font-size: 18px;
    font-weight: 650;
    margin: 6px 0 0;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }
  .props {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 0 0 18px;
    padding: 14px;
    background: #13151c;
    border: 1px solid #252832;
    border-radius: 8px;
    font-size: 12px;
  }
  .prop {
    display: grid;
    grid-template-columns: 80px minmax(0, 1fr);
    column-gap: 12px;
    align-items: baseline;
    min-width: 0;
  }
  .props .k {
    color: #6b7280;
  }
  .prop > span:last-child {
    min-width: 0;
    overflow-wrap: anywhere;
    color: #d1d5db;
  }
  .mono {
    font-family: "SF Mono", "JetBrains Mono", Consolas, monospace;
    font-size: 11px;
  }
  .dim {
    color: #4b5563;
  }
  .live-text {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: #f59e0b;
  }
  .desc {
    font-size: 12.5px;
    color: #b2b8c4;
    line-height: 1.65;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    margin-bottom: 18px;
    padding: 14px;
    background: #13151c;
    border: 1px solid #252832;
    border-radius: 8px;
  }

  .action-box {
    border: 1px solid #2d3039;
    border-radius: 8px;
    padding: 12px;
    margin-bottom: 16px;
    background: #13151c;
  }
  .action-title {
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 8px;
  }
  .agent-feed {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 8px 0;
  }
  .feed-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 12px;
  }
  .feed-body {
    flex: 1;
    min-width: 0;
    color: #9ca3af;
    overflow-wrap: anywhere;
  }
  .feed-time {
    flex-shrink: 0;
    font-size: 10px;
    color: #4b5563;
    font-family: "SF Mono", Consolas, monospace;
  }
  .feed-kind {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    border-radius: 3px;
    padding: 1px 4px;
    flex-shrink: 0;
  }
  .feed-kind.agent {
    color: #f59e0b;
    background: #1f180a;
  }
  .feed-kind.system {
    color: #a78bfa;
    background: #171226;
  }
  .feed-kind.user {
    color: #22c55e;
    background: #0d1f14;
  }
  .agent-actions {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }

  /* Comments */
  .comments-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #6b7280;
    margin-bottom: 8px;
  }
  .comment-box {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    margin-bottom: 10px;
  }
  .comment-box textarea {
    flex: 1;
    min-width: 0;
    background: #1c1f26;
    border: 1px solid #3b3f4a;
    border-radius: 6px;
    color: #e5e7eb;
    padding: 8px;
    font-size: 12px;
    font-family: inherit;
    resize: vertical;
  }
  .comment {
    padding: 8px 0;
    border-bottom: 1px solid #1f2129;
    font-size: 12px;
    color: #9ca3af;
  }
  .comment-meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 11px;
    margin-bottom: 4px;
    color: #6b7280;
  }
  .comment-body {
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: #d1d5db;
  }

  @media (max-width: 720px) {
    .sidebar {
      display: none;
    }
    .board-col {
      min-width: min(280px, calc(100vw - 32px));
      flex-basis: min(280px, calc(100vw - 32px));
    }
    .overlay {
      justify-content: stretch;
    }
    .detail {
      width: 100%;
      max-width: none;
      padding: 18px 16px;
      border-left: 0;
      box-shadow: none;
    }
    .prop {
      grid-template-columns: 72px minmax(0, 1fr);
    }
  }

  /* Popover + modals */
  .popover {
    width: min(420px, calc(100vw - 32px));
    max-width: none;
    max-height: calc(100vh - 32px);
    overflow-y: auto;
    background: #16181f;
    border: 1px solid #2d3039;
    border-radius: 10px;
    padding: 16px;
    margin: clamp(16px, 12vh, 96px) auto 16px;
  }
  .popover.wide {
    width: min(560px, calc(100vw - 32px));
  }
  .modal-title {
    font-size: 14px;
    font-weight: 700;
    margin-bottom: 12px;
  }
  .prefix-note {
    grid-column: 2;
    font-size: 12px;
    color: #6b7280;
    font-family: "SF Mono", "JetBrains Mono", Consolas, monospace;
  }
  .delete-summary {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 4px 0 10px;
    border-radius: 8px;
    background: #222630;
    padding: 11px;
  }
  .delete-summary code {
    color: #a5b4fc;
    font-size: 11px;
  }
  .delete-copy {
    color: #9ca3af;
    font-size: 12.5px;
  }
  .delete-impact {
    margin: 10px 0;
    padding: 10px 12px 10px 30px;
    border: 1px solid #7f1d1d;
    border-radius: 8px;
    background: #2a1215;
    color: #fecaca;
    font-size: 12.5px;
  }
  .delete-impact li + li {
    margin-top: 4px;
  }
  .delete-warning {
    color: #fca5a5;
    font-size: 12px;
    margin-bottom: 14px;
  }
  .f-check {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    cursor: pointer;
    font-size: 12px;
  }
  .f-check input {
    margin: 0;
    width: auto;
  }
  .color-swatch {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    cursor: pointer;
    border: 2px solid transparent;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .color-swatch.selected {
    border-color: #e5e7eb;
  }
  .color-swatch input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }
  .toast {
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 500;
    background: #2a1215;
    color: #f87171;
    border: 1px solid #4c2226;
    border-radius: 8px;
    padding: 10px 16px;
    font-size: 12.5px;
    max-width: 70vw;
  }
</style>
