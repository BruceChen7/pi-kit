<script lang="ts">
import { onMount } from "svelte";

import { KanbanRuntimeApi } from "./lib/api";
// biome-ignore lint/correctness/noUnusedImports: Svelte template references component import.
import RequirementCreateForm from "./lib/components/RequirementCreateForm.svelte";
// biome-ignore lint/correctness/noUnusedImports: Svelte template references component import.
import RequirementTerminal from "./lib/components/RequirementTerminal.svelte";
import {
  pickProjectDirectory,
  supportsProjectDirectoryAccess,
} from "./lib/project-browser-access";
import type {
  HomeResponse,
  RequirementDetail,
  RequirementRunStage,
} from "./lib/types";

const api = new KanbanRuntimeApi();

// biome-ignore lint/correctness/noUnusedVariables: Svelte template consumes this state.
let appPhase: "booting" | "ready" | "error" = "booting";
// biome-ignore lint/correctness/noUnusedVariables: Svelte template consumes this state.
let appError: string | null = null;
let home: HomeResponse | null = null;
let detail: RequirementDetail | null = null;
// biome-ignore lint/correctness/noUnusedVariables: Svelte template consumes this state.
let createModalOpen = false;
let createSubmitting = false;
let actionSubmitting = false;
// biome-ignore lint/correctness/noUnusedVariables: Svelte template consumes this state.
let createError: string | null = null;
// biome-ignore lint/correctness/noUnusedVariables: Svelte template consumes this state.
let workbenchError: string | null = null;
let commandDraft = "";
let createTitle = "";
let createPrompt = "";
let createProjectId: string | null = null;
let createProjectName = "";
let createProjectPath = "";
let authorizedProjectIds: string[] = [];
let collapsedGroups: Record<string, boolean> = {};
// biome-ignore lint/correctness/noUnusedVariables: Svelte template consumes this state.
let selectedRequirementId: string | null = null;
let lastDetailId = "";

onMount(() => {
  void initialize();
  const keyHandler = (event: KeyboardEvent) => {
    if (
      event.key.toLowerCase() === "t" &&
      event.ctrlKey &&
      event.shiftKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      openCreateModal();
    }
  };

  window.addEventListener("keydown", keyHandler);
  return () => {
    window.removeEventListener("keydown", keyHandler);
  };
});

$: if (detail && detail.requirement.id !== lastDetailId) {
  lastDetailId = detail.requirement.id;
  commandDraft =
    detail.activeSession?.command ?? `pi ${detail.requirement.prompt}`;
}

$: if (!detail) {
  lastDetailId = "";
}

async function initialize(): Promise<void> {
  appPhase = "booting";
  appError = null;

  try {
    await waitForBootstrapReady();
    await refreshHome();
    appPhase = "ready";
  } catch (error) {
    appPhase = "error";
    appError = error instanceof Error ? error.message : String(error);
  }
}

async function waitForBootstrapReady(): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const bootstrap = await api.bootstrap();
    if (bootstrap.status === "ready") {
      return;
    }
    if (bootstrap.status === "failed") {
      throw new Error(bootstrap.error);
    }

    await new Promise((resolve) => {
      setTimeout(resolve, bootstrap.retryAfterMs);
    });
  }

  throw new Error("kanban bootstrap did not become ready");
}

async function refreshHome(): Promise<void> {
  home = await api.getHome();
  seedCreateProjectDefaults();
}

function seedCreateProjectDefaults(): void {
  if (createProjectId || createProjectName || createProjectPath) {
    return;
  }

  const preferredProject =
    detail?.project ??
    home?.recentProjects.find(
      (project) => project.id === home?.lastViewedProjectId,
    ) ??
    home?.recentProjects[0] ??
    null;
  if (!preferredProject) {
    return;
  }

  createProjectId = preferredProject.id;
  createProjectName = preferredProject.name;
  createProjectPath = preferredProject.path;
}

function openCreateModal(): void {
  createModalOpen = true;
  seedCreateProjectDefaults();
}

// biome-ignore lint/correctness/noUnusedVariables: Svelte template event handlers reference this function.
function closeCreateModal(): void {
  if (createSubmitting) {
    return;
  }
  createModalOpen = false;
  createError = null;
}

// biome-ignore lint/correctness/noUnusedVariables: Svelte template event handlers reference this function.
function chooseProject(projectId: string): void {
  const project = home?.recentProjects.find(
    (candidate) => candidate.id === projectId,
  );
  if (!project) {
    return;
  }

  createProjectId = project.id;
  createProjectName = project.name;
  createProjectPath = project.path;
}

// biome-ignore lint/correctness/noUnusedVariables: Svelte form handlers reference this function.
async function submitCreate(): Promise<void> {
  createSubmitting = true;
  createError = null;

  try {
    detail = await api.createRequirement({
      title: createTitle,
      prompt: createPrompt,
      projectId: createProjectId,
      projectName: createProjectName,
      projectPath: createProjectPath,
    });
    selectedRequirementId = detail.requirement.id;
    createModalOpen = false;
    createTitle = "";
    createPrompt = "";
    createProjectId = detail.project.id;
    createProjectName = detail.project.name;
    createProjectPath = detail.project.path;
    await refreshHome();
  } catch (error) {
    createError = error instanceof Error ? error.message : String(error);
  } finally {
    createSubmitting = false;
  }
}

// biome-ignore lint/correctness/noUnusedVariables: Svelte event handlers reference this function.
async function openRequirement(requirementId: string): Promise<void> {
  workbenchError = null;
  selectedRequirementId = requirementId;
  try {
    detail = await api.getRequirement(requirementId);
    await refreshHome();
  } catch (error) {
    workbenchError = error instanceof Error ? error.message : String(error);
  }
}

// biome-ignore lint/correctness/noUnusedVariables: Svelte event handlers reference this function.
async function backToHome(): Promise<void> {
  detail = null;
  selectedRequirementId = null;
  workbenchError = null;
  await refreshHome();
}

// biome-ignore lint/correctness/noUnusedVariables: Svelte template references this helper.
function stageLabel(stage: RequirementRunStage): string {
  switch (stage) {
    case "launch":
      return "启动";
    case "running":
      return "正在运行";
    case "review":
      return "Review";
    case "done":
      return "Done";
  }
}

// biome-ignore lint/correctness/noUnusedVariables: Svelte template references this helper.
function boardLabel(status: string): string {
  switch (status) {
    case "inbox":
      return "Inbox";
    case "in_progress":
      return "In Progress";
    case "done":
      return "Done";
    default:
      return status;
  }
}

function groupKey(
  projectId: string,
  lane: "inbox" | "inProgress" | "done",
): string {
  return `${projectId}:${lane}`;
}

function isCollapsed(
  projectId: string,
  lane: "inbox" | "inProgress" | "done",
): boolean {
  const key = groupKey(projectId, lane);
  if (key in collapsedGroups) {
    return collapsedGroups[key] ?? false;
  }
  return lane === "done";
}

// biome-ignore lint/correctness/noUnusedVariables: Svelte event handlers reference this function.
function toggleGroup(
  projectId: string,
  lane: "inbox" | "inProgress" | "done",
): void {
  const key = groupKey(projectId, lane);
  collapsedGroups = {
    ...collapsedGroups,
    [key]: !isCollapsed(projectId, lane),
  };
}

async function ensureProjectAuthorized(projectId: string): Promise<boolean> {
  if (authorizedProjectIds.includes(projectId)) {
    return true;
  }
  if (!supportsProjectDirectoryAccess()) {
    return true;
  }

  try {
    await pickProjectDirectory();
    authorizedProjectIds = [...authorizedProjectIds, projectId];
    return true;
  } catch {
    return false;
  }
}

// biome-ignore lint/correctness/noUnusedVariables: Svelte event handlers reference this function.
async function startRequirement(): Promise<void> {
  if (!detail || actionSubmitting) {
    return;
  }

  workbenchError = null;
  const authorized = await ensureProjectAuthorized(detail.project.id);
  if (!authorized) {
    workbenchError =
      "Project authorization is required before starting the prototype session.";
    return;
  }

  actionSubmitting = true;
  try {
    detail = await api.startRequirement(
      detail.requirement.id,
      commandDraft.trim() || `pi ${detail.requirement.prompt}`,
    );
    await refreshHome();
  } catch (error) {
    workbenchError = error instanceof Error ? error.message : String(error);
  } finally {
    actionSubmitting = false;
  }
}

// biome-ignore lint/correctness/noUnusedVariables: Svelte event handlers reference this function.
async function restartRequirement(): Promise<void> {
  if (!detail || actionSubmitting) {
    return;
  }

  actionSubmitting = true;
  workbenchError = null;
  try {
    detail = await api.restartRequirement(
      detail.requirement.id,
      commandDraft.trim() || `pi ${detail.requirement.prompt}`,
    );
    await refreshHome();
  } catch (error) {
    workbenchError = error instanceof Error ? error.message : String(error);
  } finally {
    actionSubmitting = false;
  }
}

// biome-ignore lint/correctness/noUnusedVariables: Svelte event handlers reference this function.
async function moveToReview(): Promise<void> {
  if (!detail || actionSubmitting) {
    return;
  }

  actionSubmitting = true;
  workbenchError = null;
  try {
    detail = await api.openRequirementReview(detail.requirement.id);
    await refreshHome();
  } catch (error) {
    workbenchError = error instanceof Error ? error.message : String(error);
  } finally {
    actionSubmitting = false;
  }
}

// biome-ignore lint/correctness/noUnusedVariables: Svelte event handlers reference this function.
async function completeReview(): Promise<void> {
  if (!detail || actionSubmitting) {
    return;
  }

  actionSubmitting = true;
  workbenchError = null;
  try {
    detail = await api.completeRequirementReview(detail.requirement.id);
    await refreshHome();
  } catch (error) {
    workbenchError = error instanceof Error ? error.message : String(error);
  } finally {
    actionSubmitting = false;
  }
}

// biome-ignore lint/correctness/noUnusedVariables: Svelte event handlers reference this function.
async function reopenReview(): Promise<void> {
  if (!detail || actionSubmitting) {
    return;
  }

  actionSubmitting = true;
  workbenchError = null;
  try {
    detail = await api.reopenRequirementReview(detail.requirement.id);
    await refreshHome();
  } catch (error) {
    workbenchError = error instanceof Error ? error.message : String(error);
  } finally {
    actionSubmitting = false;
  }
}
</script>

<svelte:head>
  <title>Kanban prototype</title>
</svelte:head>

{#if appPhase === "booting"}
  <main class="app-shell centered-shell">
    <div class="hero-card">
      <p class="label">Kanban</p>
      <h1>Loading prototype…</h1>
      <p class="subtle">Bootstrapping daemon-backed requirement workspace.</p>
    </div>
  </main>
{:else if appPhase === "error"}
  <main class="app-shell centered-shell">
    <div class="hero-card">
      <p class="label">Kanban</p>
      <h1>Failed to load</h1>
      <p class="error">{appError}</p>
      <button class="primary-button" on:click={() => initialize()}>Retry</button>
    </div>
  </main>
{:else}
  <main class="app-shell">
    <header class="topbar">
      <div>
        <p class="label">Requirement-centered kanban</p>
        <h1>{detail ? detail.requirement.title : "Kanban home"}</h1>
      </div>
      <div class="topbar-actions">
        {#if detail}
          <button class="secondary-button" on:click={() => backToHome()}>Back home</button>
        {/if}
        <button class="primary-button" on:click={openCreateModal}>New requirement</button>
      </div>
    </header>

    {#if detail}
      <section class="workbench-grid">
        <article class="workbench-panel">
          <div class="workbench-panel__header">
            <div>
              <p class="label">Project</p>
              <h2>{detail.project.name}</h2>
            </div>
            <div class="badge-row">
              <span class="status-chip">{boardLabel(detail.requirement.boardStatus)}</span>
              <span class="status-chip emphasis">{stageLabel(detail.requirement.runStage)}</span>
            </div>
          </div>

          <div class="meta-list">
            <div>
              <span class="meta-label">Prompt</span>
              <p>{detail.requirement.prompt}</p>
            </div>
            <div>
              <span class="meta-label">Project path</span>
              <p>{detail.project.path}</p>
            </div>
            <div>
              <span class="meta-label">Session</span>
              <p>{detail.activeSession?.id ?? "<none>"}</p>
            </div>
          </div>

          <div class="stage-bar">
            {#each ["launch", "running", "review", "done"] as stage}
              <div class:active={detail.requirement.runStage === stage} class="stage-step">
                <span>{stageLabel(stage as RequirementRunStage)}</span>
              </div>
            {/each}
          </div>

          <label class="field-group">
            <span>Launch command</span>
            <textarea bind:value={commandDraft} class="field-textarea" rows="4"></textarea>
          </label>

          {#if workbenchError}
            <p class="error">{workbenchError}</p>
          {/if}

          <div class="action-grid">
            {#if detail.requirement.runStage === "launch"}
              <button class="primary-button" disabled={actionSubmitting} on:click={startRequirement}>
                {actionSubmitting ? "Starting…" : "Start prototype session"}
              </button>
            {:else if detail.requirement.runStage === "running"}
              <button class="primary-button" disabled={actionSubmitting} on:click={moveToReview}>
                {actionSubmitting ? "Saving…" : "Move to review"}
              </button>
              <button class="secondary-button" disabled={actionSubmitting} on:click={restartRequirement}>
                Restart session
              </button>
            {:else if detail.requirement.runStage === "review"}
              <button class="primary-button" disabled={actionSubmitting} on:click={completeReview}>
                Mark done
              </button>
              <button class="secondary-button" disabled={actionSubmitting} on:click={reopenReview}>
                Back to in progress
              </button>
            {:else}
              <button class="secondary-button" on:click={() => backToHome()}>Back to home</button>
            {/if}
          </div>
        </article>

        <RequirementTerminal {detail} />
      </section>
    {:else if home?.mode === "empty-create"}
      <section class="centered-shell">
        <form class="hero-card large" on:submit|preventDefault={submitCreate}>
          <RequirementCreateForm
            bind:title={createTitle}
            bind:prompt={createPrompt}
            bind:selectedProjectId={createProjectId}
            bind:projectName={createProjectName}
            bind:projectPath={createProjectPath}
            error={createError}
            recentProjects={home?.recentProjects ?? []}
            submitting={createSubmitting}
            subheading="No unfinished requirements yet. Start from a single demand, prompt, and project path."
            onChooseProject={chooseProject}
          />
        </form>
      </section>
    {:else}
      <section class="project-board">
        {#each home?.projectGroups ?? [] as group}
          <article class="project-section">
            <header class="project-section__header">
              <div>
                <h2>{group.project.name}</h2>
                <p class="subtle">{group.project.path}</p>
              </div>
              <button class="secondary-button small" on:click={openCreateModal}>Add requirement</button>
            </header>

            <div class="lane-grid">
              {#each [
                { key: "inbox", title: "Inbox", items: group.inbox },
                { key: "inProgress", title: "In Progress", items: group.inProgress },
                { key: "done", title: "Done", items: group.done },
              ] as lane}
                <section class="lane-panel">
                  <button class="lane-panel__header" on:click={() => toggleGroup(group.project.id, lane.key as "inbox" | "inProgress" | "done") }>
                    <span>{lane.title}</span>
                    <span>{lane.items.length} · {isCollapsed(group.project.id, lane.key as "inbox" | "inProgress" | "done") ? "collapsed" : "open"}</span>
                  </button>

                  {#if !isCollapsed(group.project.id, lane.key as "inbox" | "inProgress" | "done")}
                    <div class="lane-list">
                      {#if lane.items.length === 0}
                        <p class="subtle">No requirements</p>
                      {/if}

                      {#each lane.items as requirement}
                        <button
                          class:selected={selectedRequirementId === requirement.id}
                          class="requirement-card"
                          on:click={() => openRequirement(requirement.id)}
                        >
                          <div class="requirement-card__topline">
                            <strong>{requirement.title}</strong>
                            <span class="status-chip">{stageLabel(requirement.runStage)}</span>
                          </div>
                          <p>{requirement.prompt}</p>
                          <div class="requirement-card__meta">
                            <span>{new Date(requirement.updatedAt).toLocaleString()}</span>
                            {#if requirement.hasActiveSession}
                              <span>active session</span>
                            {/if}
                          </div>
                        </button>
                      {/each}
                    </div>
                  {/if}
                </section>
              {/each}
            </div>
          </article>
        {/each}
      </section>
    {/if}

    {#if createModalOpen}
      <div
        aria-hidden="true"
        class="modal-backdrop"
        on:click={closeCreateModal}
        on:keydown={(event) => {
          if (event.key === "Escape") {
            closeCreateModal();
          }
        }}
      >
        <div
          aria-modal="true"
          class="modal-card-shell"
          role="dialog"
          tabindex="-1"
          on:click|stopPropagation
          on:keydown|stopPropagation={() => {}}
        >
          <form class="modal-card" on:submit|preventDefault={submitCreate}>
            <div class="modal-card__header">
              <div>
                <p class="label">Ctrl + Shift + T</p>
                <h2>Create requirement</h2>
              </div>
              <button class="icon-button" type="button" on:click={closeCreateModal}>✕</button>
            </div>

            <RequirementCreateForm
              bind:title={createTitle}
              bind:prompt={createPrompt}
              bind:selectedProjectId={createProjectId}
              bind:projectName={createProjectName}
              bind:projectPath={createProjectPath}
              error={createError}
              recentProjects={home?.recentProjects ?? []}
              submitting={createSubmitting}
              subheading="Default project follows the last requirement workbench you opened."
              onChooseProject={chooseProject}
            />
          </form>
        </div>
      </div>
    {/if}
  </main>
{/if}
