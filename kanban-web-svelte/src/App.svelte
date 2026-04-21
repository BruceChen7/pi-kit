<script lang="ts">
import { onMount } from "svelte";

import {
  deriveFeatureOverview,
  deriveSelectionState,
  deriveVisibleActionLog,
} from "./lib/board-view-model";
import BoardPane from "./lib/components/BoardPane.svelte";
import FeatureOverview from "./lib/components/FeatureOverview.svelte";
import InspectorPane from "./lib/components/InspectorPane.svelte";
import ProjectContextBar from "./lib/components/ProjectContextBar.svelte";
import ProjectPickerView from "./lib/components/ProjectPickerView.svelte";
import {
  buildInitialProjectBoard,
  createProjectBoardFile,
  readProjectBoardFile,
} from "./lib/project-board-file";
import {
  BrowserProjectAccessStore,
  type BrowserRecentProject,
  ensureProjectAccess,
  pickProjectDirectory,
  supportsProjectDirectoryAccess,
} from "./lib/project-browser-access";
import { openProjectWorkspace } from "./lib/project-entry-controller";
import type { BoardCard, BoardSnapshot } from "./lib/types";
import type { InspectorTab, OverviewAction } from "./lib/ui-types";

const projectAccessStore =
  typeof window === "undefined" ? null : new BrowserProjectAccessStore();
const overviewActions: OverviewAction[] = [];
const terminalUnavailableMessage: string | null = null;

let projectPhase:
  | "restoring-last-project"
  | "needs-project-selection"
  | "project-init-required"
  | "loading-project-board"
  | "project-data-error"
  | "workspace-ready"
  | "unsupported-browser" = "restoring-last-project";
let projectError: string | null = null;
let projectDataError: string | null = null;
let initializationError: string | null = null;
let loadingProject = false;

let recentProjects: BrowserRecentProject[] = [];
let currentProject: BrowserRecentProject | null = null;
let pendingProject: BrowserRecentProject | null = null;
let board: BoardSnapshot | null = null;

let selectedFeatureId: string | null = null;
let selectedChildId: string | null = null;
let activeInspectorTab: InspectorTab = "context";

$: selectedFeature =
  board?.cards.find(
    (card) => card.kind === "feature" && card.id === selectedFeatureId,
  ) ?? null;
$: selectedChild =
  board?.cards.find(
    (card) => card.kind === "child" && card.id === selectedChildId,
  ) ?? null;
$: featureOverview = deriveFeatureOverview(board, selectedFeatureId, {
  latestStatusByCard: {},
  actionLog: [],
});
$: visibleActionLog = deriveVisibleActionLog(
  [],
  board,
  selectedFeatureId,
  selectedChildId,
);
$: if (board) {
  const normalized = deriveSelectionState(board, {
    selectedFeatureId,
    selectedChildId,
  });
  if (
    normalized.selectedFeatureId !== selectedFeatureId ||
    normalized.selectedChildId !== selectedChildId
  ) {
    selectedFeatureId = normalized.selectedFeatureId;
    selectedChildId = normalized.selectedChildId;
  }
} else if (selectedFeatureId || selectedChildId) {
  selectedFeatureId = null;
  selectedChildId = null;
}

function selectCard(card: BoardCard): void {
  if (card.kind === "feature") {
    selectedFeatureId = card.id;
    selectedChildId = null;
    return;
  }

  selectedFeatureId = card.parentId;
  selectedChildId = card.id;
}

function runOverviewAction(_actionId: string): void {}

function openUnavailableActionDialog(_card: BoardCard): void {
  projectError =
    "Runtime actions are unavailable for local project boards in this flow.";
}

async function initializeProjectAccess(): Promise<void> {
  if (!supportsProjectDirectoryAccess()) {
    projectPhase = "unsupported-browser";
    return;
  }

  await refreshRecentProjects();

  const lastProject = await projectAccessStore?.getLastProject();
  if (!lastProject) {
    projectPhase = "needs-project-selection";
    return;
  }

  await openProject(lastProject, "restore");
}

async function refreshRecentProjects(): Promise<void> {
  recentProjects = (await projectAccessStore?.listRecentProjects()) ?? [];
}

async function selectFolder(): Promise<void> {
  if (!projectAccessStore) {
    return;
  }

  loadingProject = true;
  projectError = null;

  try {
    const handle = await pickProjectDirectory();
    const candidate = await projectAccessStore.rememberProject(handle);
    await refreshRecentProjects();
    await openProject(candidate, "select");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== "The user aborted a request.") {
      projectError = message;
    }
  } finally {
    loadingProject = false;
  }
}

async function openRecentProject(project: BrowserRecentProject): Promise<void> {
  await openProject(project, "recent");
}

async function reloadProject(): Promise<void> {
  if (!currentProject) {
    return;
  }

  await openProject(currentProject, "recent");
}

async function openProject(
  project: BrowserRecentProject,
  mode: "restore" | "select" | "recent",
): Promise<void> {
  loadingProject = true;
  projectError = null;
  projectDataError = null;
  initializationError = null;
  projectPhase =
    mode === "restore" ? "restoring-last-project" : "loading-project-board";

  try {
    const result = await openProjectWorkspace({
      candidate: project,
      mode,
      ensureAccess: async (candidate) =>
        ensureProjectAccess({
          handle: candidate.handle,
          mode,
        }),
      readBoard: async (candidate) => readProjectBoardFile(candidate.handle),
    });

    if (result.status === "access-error") {
      pendingProject = null;
      if (!currentProject) {
        board = null;
        projectPhase = "needs-project-selection";
      } else {
        projectPhase = "workspace-ready";
      }
      projectError = result.message;
      await refreshRecentProjects();
      return;
    }

    if (result.status === "init-required") {
      pendingProject = result.project;
      projectPhase = "project-init-required";
      await refreshRecentProjects();
      return;
    }

    currentProject = result.project;
    pendingProject = null;
    board = result.board;
    projectPhase = "workspace-ready";
    await projectAccessStore?.markProjectActive(result.project);
    await refreshRecentProjects();
  } catch (error) {
    projectDataError = error instanceof Error ? error.message : String(error);
    pendingProject = null;
    if (!currentProject) {
      board = null;
      projectPhase = "project-data-error";
    } else {
      projectPhase = "workspace-ready";
    }
  } finally {
    loadingProject = false;
  }
}

async function createPendingProjectBoard(): Promise<void> {
  if (!pendingProject) {
    return;
  }

  loadingProject = true;
  initializationError = null;

  try {
    await createProjectBoardFile(
      pendingProject.handle,
      buildInitialProjectBoard(pendingProject.name),
    );
    await openProject(pendingProject, "recent");
  } catch (error) {
    initializationError =
      error instanceof Error ? error.message : String(error);
  } finally {
    loadingProject = false;
  }
}

onMount(() => {
  void initializeProjectAccess();
});
</script>

<main class="app-shell">
  {#if currentProject && board}
    <ProjectContextBar
      currentProjectName={currentProject.name}
      currentProjectId={currentProject.id}
      {recentProjects}
      loading={loadingProject}
      onSelectFolder={() => void selectFolder()}
      onReloadProject={() => void reloadProject()}
      onSelectRecent={(project) => {
        void openRecentProject(project);
      }}
    />

    {#if projectError}
      <section class="shell-panel connection-panel">
        <p class="error">{projectError}</p>
      </section>
    {/if}
    {#if projectDataError}
      <section class="shell-panel connection-panel">
        <p class="error">{projectDataError}</p>
      </section>
    {/if}

    <section class="shell-panel connection-panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Local Project Board</p>
          <h1>Kanban Drive Console</h1>
          <p class="subtle">
            Local project board loaded from `.pi/kanban/board.json`. Runtime automation stays read-only in this flow.
          </p>
        </div>
      </div>
    </section>

    <FeatureOverview
      feature={featureOverview.feature}
      runningCount={featureOverview.runningCount}
      reviewCount={featureOverview.reviewCount}
      blockedCount={featureOverview.blockedCount}
      recentAction={featureOverview.recentAction}
      actions={overviewActions}
      onRunAction={runOverviewAction}
    />

    <section class="workspace-grid">
      <BoardPane
        {board}
        latestStatusByCard={{}}
        {selectedFeatureId}
        {selectedChildId}
        activeExecutionCardId={null}
        actionsEnabled={false}
        onSelectCard={selectCard}
        onOpenCardActions={openUnavailableActionDialog}
        onStartCard={() => {}}
        onFocusRun={() => {}}
        onOpenReview={() => {}}
        onRetryCard={() => {}}
      />

      <InspectorPane
        {selectedFeature}
        {selectedChild}
        activeExecutionCardId={null}
        activeTab={activeInspectorTab}
        context={null}
        loadingContext={false}
        contextError={null}
        latestStatus={null}
        latestLifecycle={null}
        actionLog={visibleActionLog}
        actionsEnabled={false}
        {terminalUnavailableMessage}
        onSelectTab={(tab) => {
          activeInspectorTab = tab;
        }}
        onOpenActionDialog={openUnavailableActionDialog}
      />
    </section>
  {:else if projectPhase === "unsupported-browser"}
    <section class="shell-panel project-picker-pane">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Browser Support</p>
          <h1>Open this app in Chrome or Edge</h1>
          <p class="subtle">
            This browser can't choose folders directly. For the best experience, reopen this page in the desktop version of Chrome or Edge.
          </p>
        </div>
      </div>
    </section>
  {:else if projectPhase === "project-data-error"}
    <section class="shell-panel project-picker-pane">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Project Error</p>
          <h1>Unable to read the project board</h1>
          <p class="subtle">{projectDataError ?? "The board file is invalid or unreadable."}</p>
        </div>
      </div>

      <div class="actions">
        <button on:click={() => void selectFolder()} disabled={loadingProject}>Select Folder</button>
      </div>
    </section>
  {:else}
    <ProjectPickerView
      loading={loadingProject}
      error={projectError}
      {recentProjects}
      onSelectFolder={() => void selectFolder()}
      onSelectRecent={(project) => {
        void openRecentProject(project);
      }}
    />
  {/if}
</main>

{#if projectPhase === "project-init-required" && pendingProject}
  <div
    class="dialog-backdrop"
    role="button"
    tabindex="0"
    on:click|self={() => {
      pendingProject = null;
      initializationError = null;
      projectPhase = currentProject ? "workspace-ready" : "needs-project-selection";
    }}
    on:keydown={(event) => {
      if (event.key === "Escape") {
        pendingProject = null;
        initializationError = null;
        projectPhase = currentProject ? "workspace-ready" : "needs-project-selection";
      }
    }}
  >
    <section class="dialog" role="dialog" aria-modal="true">
      <p class="eyebrow">Project Setup Required</p>
      <h3>No board file found for {pendingProject.name}</h3>
      <p>
        This project does not have `.pi/kanban/board.json` yet. Continuing will create:
      </p>

      <ul class="dialog-list">
        <li>`.pi/kanban/`</li>
        <li>`.pi/kanban/board.json`</li>
        <li>an empty board with Inbox, In Progress, and Done lanes</li>
      </ul>

      {#if initializationError}
        <p class="error">{initializationError}</p>
      {/if}

      <div class="actions">
        <button
          on:click={() => {
            pendingProject = null;
            initializationError = null;
            projectPhase = currentProject ? "workspace-ready" : "needs-project-selection";
          }}
        >
          Cancel
        </button>
        <button on:click={() => void createPendingProjectBoard()} disabled={loadingProject}>
          {#if loadingProject}Creating…{:else}Create and Open Board{/if}
        </button>
      </div>
    </section>
  </div>
{/if}
