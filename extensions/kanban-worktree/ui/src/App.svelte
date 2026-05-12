<!-- biome-ignore-all lint/correctness/noUnusedVariables: Svelte template references are not visible to Biome. -->
<script lang="ts">
import { onMount } from "svelte";

type KanbanStatus = "in-box" | "doing" | "done" | "archived";

type IssueSummary = {
  issueId: string;
  originProvider: string;
  originId: string;
  title: string;
  description?: string;
  status: KanbanStatus | string;
  repoRoot?: string;
  baseBranch?: string;
  slug?: string;
  workBranch?: string;
  worktreePath?: string;
  createdAt?: string;
  updatedAt?: string;
  pendingCreateId?: string;
};

type CreateResult =
  | {
      type: "create-result";
      ok: true;
      clientRequestId: string | null;
      issue: IssueSummary;
    }
  | {
      type: "create-result";
      ok: false;
      clientRequestId: string | null;
      error: string;
    };

type LaunchRun = {
  branch?: unknown;
  worktreePath?: unknown;
  updatedAt?: unknown;
};

type LaunchResult =
  | {
      type: "launch-result";
      ok: true;
      originProvider: string;
      originId: string;
      run: LaunchRun | null;
    }
  | {
      type: "launch-result";
      ok: false;
      originProvider: string;
      originId: string;
      error: string;
    };

type BranchesResult =
  | {
      type: "branches-result";
      ok: true;
      branches: string[];
      defaultBranch: string;
    }
  | {
      type: "branches-result";
      ok: false;
      error: string;
    };

type DeleteResult =
  | {
      type: "delete-result";
      ok: true;
      originProvider: string;
      originId: string;
      issue: IssueSummary | null;
    }
  | {
      type: "delete-result";
      ok: false;
      originProvider: string;
      originId: string;
      error: string;
    };

type Theme = "dark" | "light";
type HistoryTab = "done" | "archived";
type Readiness = "ready" | "small" | "needs plan";

type BootData = {
  issues: IssueSummary[];
};

declare global {
  interface Window {
    __KANBAN_BOOT__?: BootData;
    glimpse?: {
      send(message: unknown): void;
      close(): void;
    };
  }
}

const boot = window.__KANBAN_BOOT__ ?? { issues: [] };
let issues = $state<IssueSummary[]>(boot.issues);
let theme = $state<Theme>("dark");
let historyTab = $state<HistoryTab>("done");
let newTitle = $state("");
let showAddDetails = $state(false);
let newBaseBranch = $state("main");
let newWorkBranch = $state("");
let branchOptions = $state<string[]>(["main"]);
let branchesLoading = $state(false);
let branchesLoaded = $state(false);
let branchesError = $state("");
let newReadiness = $state<Readiness>("ready");
let createError = $state("");
let launchError = $state("");
let deleteError = $state("");
let confirmingDeleteKey = $state<string | null>(null);
let deletingIssueKeys = $state<string[]>([]);
let launchingIssueKeys = $state<string[]>([]);

const inboxIssues = $derived(issues.filter((issue) => issue.status === "in-box"));
const doingIssues = $derived(issues.filter((issue) => issue.status === "doing"));
const doneIssues = $derived(issues.filter((issue) => issue.status === "done"));
const archivedIssues = $derived(
  issues.filter((issue) => issue.status === "archived"),
);
const historyIssues = $derived(
  historyTab === "done" ? doneIssues : archivedIssues,
);
const readyToLaunch = $derived(inboxIssues.slice(0, 3));
const activeWorktrees = $derived(doingIssues.slice(0, 3));

onMount(() => {
  const createListener = (event: Event) => handleCreateResult(event);
  const launchListener = (event: Event) => handleLaunchResult(event);
  const branchesListener = (event: Event) => handleBranchesResult(event);
  const deleteListener = (event: Event) => handleDeleteResult(event);
  const keydownListener = (event: KeyboardEvent) => handleCloseShortcut(event);
  window.addEventListener("kanban:create-result", createListener);
  window.addEventListener("kanban:launch-result", launchListener);
  window.addEventListener("kanban:branches-result", branchesListener);
  window.addEventListener("kanban:delete-result", deleteListener);
  window.addEventListener("keydown", keydownListener);
  return () => {
    window.removeEventListener("kanban:create-result", createListener);
    window.removeEventListener("kanban:launch-result", launchListener);
    window.removeEventListener("kanban:branches-result", branchesListener);
    window.removeEventListener("kanban:delete-result", deleteListener);
    window.removeEventListener("keydown", keydownListener);
  };
});

function handleCloseShortcut(event: KeyboardEvent): void {
  if (!event.metaKey || event.key.toLowerCase() !== "w") return;
  event.preventDefault();
  window.glimpse?.close();
}

function launch(issue: IssueSummary): void {
  if (isLaunching(issue)) return;

  markLaunching(issue);
  launchError = "";
  if (!window.glimpse) {
    clearLaunching(issue.originProvider, issue.originId);
    launchError = "Glimpse host is not available.";
    return;
  }

  window.glimpse.send({
    type: "launch",
    originProvider: issue.originProvider,
    originId: issue.originId,
  });
}

function createTodo(launchAfterCreate = false): void {
  const title = newTitle.trim();
  if (!title) {
    createError = "Enter a TODO title.";
    return;
  }
  const workBranch = selectedWorkBranch();
  if (!workBranch) {
    createError = "Enter a work branch name.";
    openAddDetails();
    return;
  }

  createError = "";
  const clientRequestId = createClientRequestId();
  const optimisticIssue = optimisticInboxIssue(
    title,
    workBranch,
    clientRequestId,
  );
  issues = [optimisticIssue, ...issues];
  if (launchAfterCreate) markLaunching(optimisticIssue);
  newTitle = "";
  newWorkBranch = "";
  showAddDetails = false;
  window.glimpse?.send({
    type: "create",
    title,
    baseBranch: selectedBaseBranch(),
    workBranch,
    launch: launchAfterCreate,
    clientRequestId,
  });
}

function createClientRequestId(): string {
  return `create-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function optimisticInboxIssue(
  title: string,
  workBranch: string,
  pendingCreateId: string,
): IssueSummary {
  const id = `local-${Date.now()}`;
  const now = new Date().toISOString();
  return {
    issueId: `pending:${pendingCreateId}`,
    originProvider: "todo-workflow",
    originId: id,
    title,
    description: title,
    status: "in-box",
    baseBranch: selectedBaseBranch(),
    workBranch,
    slug: id,
    createdAt: now,
    updatedAt: now,
    pendingCreateId,
  };
}

function handleCreateResult(event: Event): void {
  const detail = (event as CustomEvent<unknown>).detail;
  if (!isCreateResult(detail) || !detail.clientRequestId) return;

  if (detail.ok) {
    replacePendingIssue(detail.clientRequestId, detail.issue);
    return;
  }

  const pendingIssue = findPendingIssue(detail.clientRequestId);
  if (pendingIssue) clearLaunching(pendingIssue.originProvider, pendingIssue.originId);
  issues = issues.filter(
    (issue) => issue.pendingCreateId !== detail.clientRequestId,
  );
  createError = detail.error;
}

function handleLaunchResult(event: Event): void {
  const detail = (event as CustomEvent<unknown>).detail;
  if (!isLaunchResult(detail)) return;

  clearLaunching(detail.originProvider, detail.originId);
  if (!detail.ok) {
    launchError = detail.error;
    return;
  }

  issues = issues.map((issue) => {
    if (!matchesOrigin(issue, detail.originProvider, detail.originId)) {
      return issue;
    }
    return launchedIssue(issue, detail.run);
  });
}

function deleteTodo(issue: IssueSummary): void {
  if (isDeleting(issue)) return;
  markDeleting(issue);
  deleteError = "";
  if (!window.glimpse) {
    clearDeleting(issue.originProvider, issue.originId);
    deleteError = "Glimpse host is not available.";
    return;
  }

  window.glimpse.send({
    type: "delete",
    originProvider: issue.originProvider,
    originId: issue.originId,
  });
}

function handleDeleteResult(event: Event): void {
  const detail = (event as CustomEvent<unknown>).detail;
  if (!isDeleteResult(detail)) return;

  clearDeleting(detail.originProvider, detail.originId);
  if (!detail.ok) {
    deleteError = detail.error;
    return;
  }

  confirmingDeleteKey = null;
  issues = issues.filter(
    (issue) => !matchesOrigin(issue, detail.originProvider, detail.originId),
  );
}

function handleBranchesResult(event: Event): void {
  const detail = (event as CustomEvent<unknown>).detail;
  if (!isBranchesResult(detail)) return;

  branchesLoading = false;
  branchesLoaded = true;
  if (!detail.ok) {
    branchesError = detail.error;
    branchOptions = [selectedBaseBranch()];
    return;
  }

  branchesError = "";
  branchOptions = detail.branches.length > 0 ? detail.branches : [detail.defaultBranch];
  newBaseBranch = branchOptions.includes(detail.defaultBranch)
    ? detail.defaultBranch
    : branchOptions[0] ?? "main";
}

function replacePendingIssue(
  clientRequestId: string,
  createdIssue: IssueSummary,
): void {
  const pendingIssue = findPendingIssue(clientRequestId);
  const wasLaunching = pendingIssue ? isLaunching(pendingIssue) : false;
  let replaced = false;
  issues = issues.map((issue) => {
    if (issue.pendingCreateId !== clientRequestId) return issue;
    replaced = true;
    return createdIssue;
  });
  if (!replaced && !issues.some((issue) => issue.issueId === createdIssue.issueId)) {
    issues = [createdIssue, ...issues];
  }
  if (wasLaunching && pendingIssue) transferLaunching(pendingIssue, createdIssue);
}

function findPendingIssue(clientRequestId: string): IssueSummary | undefined {
  return issues.find((issue) => issue.pendingCreateId === clientRequestId);
}

function launchedIssue(issue: IssueSummary, run: LaunchRun | null): IssueSummary {
  return {
    ...issue,
    status: "doing",
    workBranch: readString(run, "branch") ?? issue.workBranch,
    worktreePath: readString(run, "worktreePath") ?? issue.worktreePath,
    updatedAt: readString(run, "updatedAt") ?? new Date().toISOString(),
  };
}

function isCreateResult(value: unknown): value is CreateResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<CreateResult>;
  if (result.type !== "create-result" || typeof result.ok !== "boolean") {
    return false;
  }
  if (result.ok) return isIssueSummary(result.issue);
  return typeof result.error === "string";
}

function isLaunchResult(value: unknown): value is LaunchResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<LaunchResult>;
  if (
    result.type !== "launch-result" ||
    typeof result.ok !== "boolean" ||
    typeof result.originProvider !== "string" ||
    typeof result.originId !== "string"
  ) {
    return false;
  }
  if (!result.ok) return typeof result.error === "string";
  return result.run === null || typeof result.run === "object";
}

function isBranchesResult(value: unknown): value is BranchesResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<BranchesResult>;
  if (result.type !== "branches-result" || typeof result.ok !== "boolean") {
    return false;
  }
  if (!result.ok) return typeof result.error === "string";
  return Array.isArray(result.branches) && typeof result.defaultBranch === "string";
}

function isDeleteResult(value: unknown): value is DeleteResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<DeleteResult>;
  if (
    result.type !== "delete-result" ||
    typeof result.ok !== "boolean" ||
    typeof result.originProvider !== "string" ||
    typeof result.originId !== "string"
  ) {
    return false;
  }
  if (!result.ok) return typeof result.error === "string";
  return true;
}

function isIssueSummary(value: unknown): value is IssueSummary {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as IssueSummary).issueId === "string" &&
    typeof (value as IssueSummary).originProvider === "string" &&
    typeof (value as IssueSummary).originId === "string" &&
    typeof (value as IssueSummary).title === "string" &&
    typeof (value as IssueSummary).status === "string"
  );
}

function handleQuickAddKeydown(event: KeyboardEvent): void {
  if (event.key !== "Enter") return;
  event.preventDefault();
  if (event.shiftKey) {
    openAddDetails();
    return;
  }
  createTodo(false);
}

function openAddDetails(): void {
  showAddDetails = true;
  requestBranches();
}

function requestBranches(): void {
  if (branchesLoaded || branchesLoading) return;
  branchesError = "";
  if (!window.glimpse) {
    branchesLoaded = true;
    branchesError = "Glimpse host is not available.";
    return;
  }

  branchesLoading = true;
  window.glimpse.send({ type: "branches:list" });
}

function selectedBaseBranch(): string {
  return newBaseBranch.trim() || "main";
}

function selectedWorkBranch(): string {
  return newWorkBranch.trim();
}

function readinessFor(issue: IssueSummary): Readiness {
  const title = issue.title.toLowerCase();
  if (title.includes("plan") || title.includes("design")) return "needs plan";
  if (title.includes("fix") || title.includes("small")) return "small";
  return "ready";
}

function freshness(issue: IssueSummary): string {
  const timestamp = issue.updatedAt ?? issue.createdAt;
  if (!timestamp) return "updated recently";
  const time = new Date(timestamp).getTime();
  if (Number.isNaN(time)) return "updated recently";
  const diff = Math.max(0, Date.now() - time);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `updated ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `updated ${hours}h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `updated ${days}d`;
}

function shortPath(path: string | undefined): string {
  if (!path) return "worktree pending";
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2) return path;
  return `.../${parts.slice(-2).join("/")}`;
}

function baseBranch(issue: IssueSummary): string {
  return issue.baseBranch ?? "main";
}

function workBranch(issue: IssueSummary): string {
  return issue.workBranch ?? "branch missing";
}

function isLaunching(issue: IssueSummary): boolean {
  return launchingIssueKeys.includes(launchKey(issue.originProvider, issue.originId));
}

function isDeleting(issue: IssueSummary): boolean {
  return deletingIssueKeys.includes(launchKey(issue.originProvider, issue.originId));
}

function markLaunching(issue: IssueSummary): void {
  const key = launchKey(issue.originProvider, issue.originId);
  if (!launchingIssueKeys.includes(key)) launchingIssueKeys = [...launchingIssueKeys, key];
}

function clearLaunching(originProvider: string, originId: string): void {
  const key = launchKey(originProvider, originId);
  launchingIssueKeys = launchingIssueKeys.filter((issueKey) => issueKey !== key);
}

function markDeleting(issue: IssueSummary): void {
  const key = launchKey(issue.originProvider, issue.originId);
  if (!deletingIssueKeys.includes(key)) deletingIssueKeys = [...deletingIssueKeys, key];
}

function clearDeleting(originProvider: string, originId: string): void {
  const key = launchKey(originProvider, originId);
  deletingIssueKeys = deletingIssueKeys.filter((issueKey) => issueKey !== key);
}

function transferLaunching(from: IssueSummary, to: IssueSummary): void {
  clearLaunching(from.originProvider, from.originId);
  markLaunching(to);
}

function matchesOrigin(
  issue: IssueSummary,
  originProvider: string,
  originId: string,
): boolean {
  return issue.originProvider === originProvider && issue.originId === originId;
}

function readString(value: LaunchRun | null, key: keyof LaunchRun): string | undefined {
  const field = value?.[key];
  return typeof field === "string" && field.trim() ? field : undefined;
}

function launchKey(originProvider: string, originId: string): string {
  return `${originProvider}:${originId}`;
}

function rowKey(issue: IssueSummary): string {
  return issue.issueId || `${issue.originProvider}:${issue.originId}`;
}
</script>

<main class="app" data-theme={theme}>
  <header class="titlebar">
    <div>
      <h1>Kanban Worktree</h1>
      <p>Launch waiting tasks, resume active worktrees, and review completed work.</p>
    </div>
    <div class="title-actions" aria-label="Kanban actions">
      <div class="theme-toggle" aria-label="Theme">
        <button
          type="button"
          class:active={theme === "dark"}
          onclick={() => (theme = "dark")}>Dark</button
        >
        <button
          type="button"
          class:active={theme === "light"}
          onclick={() => (theme = "light")}>Light</button
        >
      </div>
      <button
        type="button"
        class="button button-blue"
        onclick={openAddDetails}>+ TODO</button
      >
    </div>
  </header>

  {#if launchError}
    <p class="form-error launch-error">{launchError}</p>
  {/if}
  {#if deleteError}
    <p class="form-error launch-error">{deleteError}</p>
  {/if}

  <section class="top-grid" aria-label="Quick queues">
    <section class="panel panel-inbox">
      <div class="panel-head">
        <strong>Ready to launch</strong>
        <span>from Inbox · {readyToLaunch.length} suggested</span>
      </div>
      <div class="list">
        {#each readyToLaunch as issue (rowKey(issue))}
          <article class="row row-inbox">
            <div class="row-main">
              <strong>{issue.title}</strong>
              <div class="meta">
                <span>{issue.originId}</span>
                <span>{workBranch(issue)}</span>
                <span>{baseBranch(issue)}</span>
                <span>{freshness(issue)}</span>
                <span class={`chip chip-${readinessFor(issue).replace(" ", "-")}`}>
                  {readinessFor(issue)}
                </span>
              </div>
            </div>
            <button
              type="button"
              class="button button-blue"
              class:button-loading={isLaunching(issue)}
              disabled={isLaunching(issue)}
              onclick={() => launch(issue)}
              >{isLaunching(issue) ? "Launching..." : "Launch"}</button
            >
          </article>
        {:else}
          <p class="empty-row">No launch-ready TODOs yet.</p>
        {/each}
      </div>
    </section>

    <section class="panel panel-doing">
      <div class="panel-head">
        <strong>Active worktrees</strong>
        <span>{activeWorktrees.length} resumable</span>
      </div>
      <div class="list">
        {#each activeWorktrees as issue (rowKey(issue))}
          <article class="row row-doing">
            <div class="row-main">
              <strong>{issue.title}</strong>
              <div class="meta meta-green">
                <span>{issue.workBranch ?? issue.slug ?? issue.originId}</span>
                <span>{shortPath(issue.worktreePath) || freshness(issue)}</span>
              </div>
            </div>
            <button
              type="button"
              class="button button-green"
              class:button-loading={isLaunching(issue)}
              disabled={isLaunching(issue)}
              onclick={() => launch(issue)}
              >{isLaunching(issue) ? "Resuming..." : "Resume"}</button
            >
          </article>
        {:else}
          <p class="empty-row empty-green">No active worktrees.</p>
        {/each}
      </div>
    </section>
  </section>

  <section class="main-grid" aria-label="Kanban board">
    <div class="left-stack">
      <section class="panel panel-inbox">
        <div class="panel-head">
          <strong>Inbox</strong>
          <span>{inboxIssues.length} waiting</span>
        </div>

        <div class="quick-add">
          {#if showAddDetails}
            <div class="add-details">
              <label>
                <span>Title</span>
                <input
                  bind:value={newTitle}
                  placeholder="Add keyboard shortcuts for kanban"
                  onkeydown={handleQuickAddKeydown}
                />
              </label>
              <div class="form-grid">
                <label>
                  <span>Base branch</span>
                  <select bind:value={newBaseBranch} disabled={branchesLoading}>
                    {#if branchesLoading}
                      <option value={selectedBaseBranch()}>Loading branches...</option>
                    {:else}
                      {#each branchOptions as branch}
                        <option value={branch}>{branch}</option>
                      {/each}
                    {/if}
                  </select>
                </label>
                <label>
                  <span>Work branch</span>
                  <input
                    bind:value={newWorkBranch}
                    placeholder="feature/my-work-branch"
                    onkeydown={handleQuickAddKeydown}
                  />
                </label>
                <label>
                  <span>Readiness</span>
                  <select bind:value={newReadiness}>
                    <option value="ready">ready</option>
                    <option value="small">small</option>
                    <option value="needs plan">needs plan</option>
                  </select>
                </label>
              </div>
              {#if branchesError}
                <p class="form-error">{branchesError}</p>
              {/if}
              {#if createError}
                <p class="form-error">{createError}</p>
              {/if}
              <div class="form-actions">
                <button
                  type="button"
                  class="button button-ghost"
                  onclick={() => {
                    showAddDetails = false;
                    createError = "";
                  }}>Cancel</button
                >
                <button
                  type="button"
                  class="button button-ghost"
                  onclick={() => createTodo(false)}>Add to Inbox</button
                >
                <button
                  type="button"
                  class="button button-blue"
                  onclick={() => createTodo(true)}>Add & Launch</button
                >
              </div>
            </div>
          {:else}
            <div class="quick-add-line">
              <label class="sr-only" for="quick-todo">Add a TODO</label>
              <input
                id="quick-todo"
                bind:value={newTitle}
                placeholder="Add a TODO..."
                onkeydown={handleQuickAddKeydown}
              />
              <button
                type="button"
                class="button button-blue"
                onclick={() => createTodo(false)}>Add</button
              >
            </div>
            <div class="quick-hint">Enter asks for branch · Shift+Enter for details</div>
            {#if createError}
              <p class="form-error">{createError}</p>
            {/if}
          {/if}
        </div>

        <div class="list">
          {#each inboxIssues as issue (rowKey(issue))}
            {#if confirmingDeleteKey === rowKey(issue)}
              <article class="row row-danger">
                <div class="row-main">
                  <strong>Delete TODO?</strong>
                  <div class="meta meta-danger">
                    <span>{issue.title}</span>
                  </div>
                </div>
                <div class="row-actions">
                  <button
                    type="button"
                    class="button button-ghost compact"
                    onclick={() => (confirmingDeleteKey = null)}>Cancel</button
                  >
                  <button
                    type="button"
                    class="button button-danger compact"
                    class:button-loading={isDeleting(issue)}
                    disabled={isDeleting(issue)}
                    onclick={() => deleteTodo(issue)}
                    >{isDeleting(issue) ? "Deleting..." : "Delete"}</button
                  >
                </div>
              </article>
            {:else}
              <article class="row row-inbox">
                <div class="row-main">
                  <strong>{issue.title}</strong>
                  <div class="meta">
                    <span>{issue.originId}</span>
                    <span>{workBranch(issue)}</span>
                    <span>{baseBranch(issue)}</span>
                    <span>{freshness(issue)}</span>
                  </div>
                </div>
                <div class="row-actions">
                  {#if isLaunching(issue)}
                    <span class="chip chip-launching">launching</span>
                  {:else}
                    <span class={`chip chip-${readinessFor(issue).replace(" ", "-")}`}>
                      {readinessFor(issue)}
                    </span>
                  {/if}
                  <button
                    type="button"
                    class="button button-ghost compact"
                    onclick={() => (confirmingDeleteKey = rowKey(issue))}
                    >Delete...</button
                  >
                </div>
              </article>
            {/if}
          {:else}
            <p class="empty-row">Create a TODO to start your inbox.</p>
          {/each}
        </div>
      </section>

      <aside class="panel panel-history">
        <div class="panel-head">
          <strong>History</strong>
          <span>recent activity</span>
        </div>
        <div class="tabs" role="tablist" aria-label="History status">
          <button
            type="button"
            class:active={historyTab === "done"}
            onclick={() => (historyTab = "done")}>Done · {doneIssues.length}</button
          >
          <button
            type="button"
            class:active={historyTab === "archived"}
            onclick={() => (historyTab = "archived")}
            >Archive · {archivedIssues.length}</button
          >
        </div>
        <div class="list">
          {#each historyIssues.slice(0, 3) as issue (rowKey(issue))}
            <article class="row row-history">
              <div class="row-main">
                <strong>{issue.title}</strong>
                <div class="meta meta-history">
                  <span>{issue.status}</span>
                  <span>{freshness(issue)}</span>
                </div>
              </div>
              <button type="button" class="button button-ghost compact">Show</button>
            </article>
          {:else}
            <p class="empty-row empty-history">No completed or archived work yet.</p>
          {/each}
        </div>
      </aside>
    </div>

    <section class="panel panel-doing doing-detail">
      <div class="panel-head">
        <strong>Doing</strong>
        <span>active worktree detail</span>
      </div>
      <div class="list">
        {#each doingIssues as issue (rowKey(issue))}
          <article class="doing-card row-doing">
            <strong>{issue.title}</strong>
            <div class="meta meta-green">
              <span>{issue.workBranch ?? issue.slug ?? issue.originId}</span>
              <span>{shortPath(issue.worktreePath)}</span>
            </div>
            <div class="card-actions">
              <button
                type="button"
                class="button button-green"
                class:button-loading={isLaunching(issue)}
                disabled={isLaunching(issue)}
                onclick={() => launch(issue)}
                >{isLaunching(issue) ? "Resuming..." : "Resume"}</button
              >
              <button type="button" class="button button-ghost">Show</button>
            </div>
          </article>
        {:else}
          <div class="empty-doing">
            <strong>No active worktree</strong>
            <p>Launch a task from Ready to launch or add a new TODO.</p>
          </div>
        {/each}
      </div>
    </section>
  </section>
</main>
