<script lang="ts">
import { onMount } from "svelte";
import { registerGlimpseCloseShortcuts } from "../../../shared/glimpse-ui-shortcuts.ts";
import AnnotationPanel from "./annotations/annotation-panel.svelte";
import AnnotationProvider from "./annotations/annotation-provider.svelte";
import { normalizeArtifactNodes } from "./normalize-spec.ts";
import VisualArtifactRenderer from "./renderer/visual-artifact-renderer.svelte";

type ViewType = "home" | "project" | "artifact";
type ProjectSummary = { name: string; artifactCount: number };
type ArtifactSummary = { slug: string; title: string; description?: string };
type BootData = {
  view: ViewType;
  projectName?: string;
  artifactSlug?: string;
  artifactSpec?: unknown;
};

const boot = window.__VISUAL_ARTIFACT_BOOT__ ?? { view: "home" as ViewType };

let currentView = $state<ViewType>((boot as BootData).view);
let bootData = $state<BootData>(boot as BootData);
let projects = $state<ProjectSummary[]>([]);
let artifacts = $state<ArtifactSummary[]>([]);
let totalArtifactCount = $derived(
  projects.reduce((sum, project) => sum + project.artifactCount, 0),
);

/* ---- Navigation ---- */

function goHome(): void {
  currentView = "home";
  projects = [];
  artifacts = [];
  window.glimpse?.send({ type: "list-projects" });
}

function goBack(): void {
  if (currentView === "artifact") {
    goProject(bootData.projectName ?? "");
  } else {
    goHome();
  }
}

function goProject(name: string): void {
  currentView = "project";
  bootData = { ...bootData, view: "project", projectName: name };
  artifacts = [];
  window.glimpse?.send({ type: "list-artifacts", projectName: name });
}

function goArtifact(projectName: string, slug: string): void {
  currentView = "artifact";
  bootData = {
    ...bootData,
    view: "artifact",
    projectName,
    artifactSlug: slug,
  };
  window.glimpse?.send({ type: "get-artifact", projectName, slug });
}

/* ---- Event listeners ---- */

function setupListeners(): void {
  const onProjects = (e: Event) => {
    projects = (e as CustomEvent).detail?.projects ?? [];
  };
  const onArtifacts = (e: Event) => {
    artifacts = (e as CustomEvent).detail?.artifacts ?? [];
  };
  const onArtifact = (e: Event) => {
    const detail = (e as CustomEvent).detail as {
      projectName: string;
      slug: string;
      spec: unknown;
    } | null;
    if (detail?.spec) {
      bootData = {
        ...bootData,
        view: "artifact",
        projectName: detail.projectName,
        artifactSlug: detail.slug,
        artifactSpec: detail.spec,
      };
    }
  };
  const onError = (e: Event) => {
    console.error("VA error:", (e as CustomEvent).detail);
  };

  window.addEventListener("visual-artifact:projects", onProjects);
  window.addEventListener("visual-artifact:artifacts", onArtifacts);
  window.addEventListener("visual-artifact:artifact", onArtifact);
  window.addEventListener("visual-artifact:error", onError);
  window.addEventListener("visual-artifact:deleted", handleCleanupResult);
  window.addEventListener(
    "visual-artifact:project-cleaned",
    handleCleanupResult,
  );
  window.addEventListener("visual-artifact:all-cleaned", handleCleanupResult);
}

/* ---- Init ---- */

onMount(() => {
  const unregisterCloseShortcuts = registerGlimpseCloseShortcuts();
  setupListeners();

  if (currentView === "home") {
    window.glimpse?.send({ type: "list-projects" });
  } else if (currentView === "project" && bootData.projectName) {
    window.glimpse?.send({
      type: "list-artifacts",
      projectName: bootData.projectName,
    });
  } else if (
    currentView === "artifact" &&
    bootData.projectName &&
    bootData.artifactSlug
  ) {
    window.glimpse?.send({
      type: "get-artifact",
      projectName: bootData.projectName,
      slug: bootData.artifactSlug,
    });
  }

  return unregisterCloseShortcuts;
});

function artifactNodes(): { type: string; props: Record<string, unknown> }[] {
  const spec = bootData.artifactSpec as
    | { nodes?: unknown; data?: Record<string, unknown[]> }
    | undefined;
  return normalizeArtifactNodes(spec?.nodes, spec?.data);
}

/* ---- Feedback panel ---- */

let feedbackOpen = $state(false);

function toggleFeedback(): void {
  feedbackOpen = !feedbackOpen;
}

/* ---- Cleanup actions ---- */

type ConfirmAction =
  | { kind: "delete-artifact"; projectName: string; slug: string }
  | { kind: "clean-project"; projectName: string }
  | { kind: "clean-all" };

let pendingCleanupAction = $state<ConfirmAction | null>(null);

function requestDeleteArtifact(projectName: string, slug: string): void {
  pendingCleanupAction = { kind: "delete-artifact", projectName, slug };
}

function requestCleanProject(projectName: string): void {
  pendingCleanupAction = { kind: "clean-project", projectName };
}

function requestCleanAll(): void {
  pendingCleanupAction = { kind: "clean-all" };
}

function executeConfirmed(): void {
  const action = pendingCleanupAction;
  if (!action) return;

  switch (action.kind) {
    case "delete-artifact":
      window.glimpse?.send({
        type: "delete-artifact",
        projectName: action.projectName,
        slug: action.slug,
      });
      break;
    case "clean-project":
      window.glimpse?.send({
        type: "clean-project",
        projectName: action.projectName,
      });
      break;
    case "clean-all":
      window.glimpse?.send({ type: "clean-all" });
      break;
  }
  pendingCleanupAction = null;
}

function cancelConfirmed(): void {
  pendingCleanupAction = null;
}

function handleCleanupResult(e: Event): void {
  if (e.type === "visual-artifact:deleted") {
    // Refresh current view
    if (bootData.projectName) {
      window.glimpse?.send({
        type: "list-artifacts",
        projectName: bootData.projectName,
      });
    }
  } else if (e.type === "visual-artifact:project-cleaned") {
    goHome();
  } else if (e.type === "visual-artifact:all-cleaned") {
    projects = [];
    artifacts = [];
  }
}
</script>

<main class="app">
  <header class="titlebar">
    {#if currentView !== "home"}
      <button type="button" class="back-button" onclick={goBack}>&larr;</button>
    {/if}
    <h1>Visual Artifact</h1>
    {#if currentView === "artifact" && bootData.artifactSlug}
      <p class="muted">· {bootData.artifactSlug}</p>
    {:else if currentView === "project" && bootData.projectName}
      <p class="muted">· {bootData.projectName}</p>
    {/if}
    <div class="spacer"></div>

    {#if currentView === "artifact"}
      <button
        type="button"
        class="clean-btn"
        onclick={() => requestDeleteArtifact(bootData.projectName ?? "", bootData.artifactSlug ?? "")}
      >
        Delete
      </button>
      <button
        type="button"
        class="feedback-button"
        class:feedback-active={feedbackOpen}
        onclick={toggleFeedback}
        aria-pressed={feedbackOpen}
      >
        Feedback
      </button>
    {/if}
  </header>

  <section class="content">
    {#if currentView === "home"}
      {#if projects.length > 0}
        <div class="list-shell">
          <div class="list-summary">
            <div>
              <h2>Projects</h2>
              <p class="muted">Browse generated visual artifacts by workspace.</p>
            </div>
            <div class="summary-meta">
              <span class="meta-pill">{projects.length} project{projects.length !== 1 ? "s" : ""}</span>
              <span class="meta-pill">
                {totalArtifactCount} artifact{totalArtifactCount !== 1 ? "s" : ""}
              </span>
            </div>
          </div>

          <div class="grid">
            {#each projects as project}
              <button type="button" class="card-btn" onclick={() => goProject(project.name)}>
                <span>
                  <strong>{project.name}</strong>
                  <span class="muted">Open project artifacts</span>
                </span>
                <span class="count-pill">
                  {project.artifactCount} artifact{project.artifactCount !== 1 ? "s" : ""}
                </span>
              </button>
            {/each}
          </div>
          <div class="clean-bar">
            <button type="button" class="clean-btn clean-action" onclick={requestCleanAll}>
              Clean All Artifacts
            </button>
          </div>
        </div>
      {:else}
        <p class="empty">No projects yet. Create an artifact first.</p>
      {/if}

    {:else if currentView === "project"}
      {#if artifacts.length > 0}
        <div class="list-shell">
          <div class="list-summary">
            <div>
              <h2>Artifacts in {bootData.projectName}</h2>
              <p class="muted">Browse generated visual artifacts and open one to inspect the rendered result.</p>
            </div>
            <div class="summary-meta">
              <span class="meta-pill">{artifacts.length} artifact{artifacts.length !== 1 ? "s" : ""}</span>
              {#if bootData.projectName}
                <span class="meta-pill">{bootData.projectName}</span>
              {/if}
            </div>
          </div>

          <div class="list">
            {#each artifacts as artifact}
              <div class="row-wrap">
                <button
                  type="button"
                  class="row-btn"
                  onclick={() => goArtifact(bootData.projectName ?? "", artifact.slug)}
                >
                  <span class="row-copy">
                    <strong>{artifact.title}</strong>
                    {#if artifact.description}
                      <span class="muted">{artifact.description}</span>
                    {/if}
                  </span>
                  <span class="slug">{artifact.slug}</span>
                </button>
                <button
                  type="button"
                  class="clean-btn row-clean-btn"
                  onclick={() => requestDeleteArtifact(bootData.projectName ?? "", artifact.slug)}
                  title="Delete this artifact"
                  aria-label={`Delete ${artifact.title}`}
                >
                  &times;
                </button>
              </div>
            {/each}
          </div>
          <div class="clean-bar">
            <button
              type="button"
              class="clean-btn clean-action"
              onclick={() => requestCleanProject(bootData.projectName ?? "")}
            >
              Clean All in {bootData.projectName}
            </button>
          </div>
        </div>
      {:else}
        <p class="empty">No artifacts in this project.</p>
      {/if}

    {:else if currentView === "artifact"}
      {#if bootData.artifactSpec && artifactNodes().length > 0}
        {#if bootData.projectName && bootData.artifactSlug}
          <AnnotationProvider
            project={bootData.projectName}
            slug={bootData.artifactSlug}
            bind:feedbackOpen
          >
            <div class="artifact-layout" class:with-panel={feedbackOpen}>
              <div class="artifact-main">
                <VisualArtifactRenderer nodes={artifactNodes()} />
              </div>
              <AnnotationPanel />
            </div>
          </AnnotationProvider>
        {:else}
          <VisualArtifactRenderer nodes={artifactNodes()} />
        {/if}
      {:else}
        <p class="empty">Loading artifact...</p>
      {/if}
    {/if}
  </section>

  {#if pendingCleanupAction}
    <div class="confirm-overlay" role="dialog" aria-modal="true">
      <div class="confirm-dialog">
        <p>
          {#if pendingCleanupAction.kind === "delete-artifact"}
            Delete artifact <strong>{pendingCleanupAction.slug}</strong>?
          {:else if pendingCleanupAction.kind === "clean-project"}
            Delete all artifacts in <strong>{pendingCleanupAction.projectName}</strong>?
          {:else if pendingCleanupAction.kind === "clean-all"}
            Delete <strong>all artifacts</strong> across all projects?
          {/if}
        </p>
        <p class="confirm-hint">This cannot be undone.</p>
        <div class="confirm-actions">
          <button type="button" class="clean-btn" onclick={executeConfirmed}>Delete</button>
          <button type="button" class="cancel-btn" onclick={cancelConfirmed}>Cancel</button>
        </div>
      </div>
    </div>
  {/if}
</main>

<style>
  .app {
    font-family: var(--font-sans);
    padding: 24px;
    color: var(--foreground);
    background: var(--background);
    min-height: 100vh;
  }

  .titlebar {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 24px;
  }

  h1 {
    margin: 0;
    font-size: 20px;
    line-height: 1.2;
  }

  .muted {
    margin: 0;
    color: var(--muted-foreground);
    font-size: 13px;
  }

  .slug {
    display: inline-flex;
    align-items: center;
    min-width: 0;
    max-width: 260px;
    min-height: 28px;
    padding: 0 9px;
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) * 0.6);
    background: var(--muted);
    color: var(--muted-foreground);
    font-size: 11px;
    font-family: var(--font-mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .spacer {
    flex: 1;
  }

  .back-button {
    background: none;
    border: none;
    color: var(--clay-dark);
    font-size: 18px;
    cursor: pointer;
    padding: 0 4px;
  }

  .feedback-button {
    background: none;
    border: 1px solid color-mix(in oklch, var(--border), var(--foreground) 18%);
    border-radius: 999px;
    padding: 4px 12px;
    font-size: 12px;
    color: var(--foreground);
    cursor: pointer;
  }

  .feedback-button:hover {
    background: color-mix(in oklch, var(--foreground), transparent 96%);
  }

  .feedback-active {
    background: var(--clay);
    color: var(--primary-foreground);
    border-color: var(--clay);
  }

  .content {
    padding: 4px 0;
  }

  .artifact-layout {
    display: flex;
    position: relative;
  }

  .artifact-main {
    flex: 1;
    width: min(100%, 1040px);
    max-width: 1040px;
    min-width: 0;
    margin: 0 auto;
    transition: margin-right 0.2s ease;
  }

  .artifact-main > :global(.va-node[data-va-type="text"]) {
    max-width: 78ch;
    overflow-wrap: anywhere;
  }

  .artifact-main > :global(.va-node[data-va-type="badge"]) {
    display: inline-block;
    width: auto;
    margin: 0 6px 8px 0;
    vertical-align: top;
  }

  .artifact-main > :global(.va-node[data-va-type="kpi-grid"]) {
    clear: both;
    margin-top: 8px;
  }

  .with-panel .artifact-main {
    margin-right: 336px;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 12px;
  }

  .card-btn {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    text-align: left;
    min-height: 78px;
    padding: 16px;
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) * 0.8);
    background: var(--card);
    color: inherit;
    cursor: pointer;
    transition:
      background 0.15s ease,
      border-color 0.15s ease,
      transform 0.15s ease;
  }

  .card-btn:hover {
    border-color: var(--clay);
    background: color-mix(in oklch, var(--foreground), transparent 96%);
    transform: translateY(-1px);
  }

  .card-btn strong {
    display: block;
    margin-bottom: 4px;
    font-size: 15px;
    color: var(--foreground);
  }

  .list {
    display: grid;
    gap: 10px;
  }

  .list-shell {
    width: min(100%, 1120px);
    margin: 0 auto;
  }

  .list-summary {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: end;
    gap: 16px;
    margin-bottom: 16px;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--border);
  }

  .list-summary h2 {
    margin: 0 0 4px;
    font-size: 16px;
    font-weight: 650;
    line-height: 1.3;
    color: var(--foreground);
  }

  .summary-meta {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 8px;
  }

  .meta-pill,
  .count-pill {
    display: inline-flex;
    align-items: center;
    min-height: 28px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--muted);
    color: var(--muted-foreground);
    font-size: 12px;
    white-space: nowrap;
  }

  .count-pill {
    background: color-mix(in oklch, var(--clay), transparent 92%);
    border-color: color-mix(in oklch, var(--clay), transparent 70%);
    color: var(--clay-dark);
  }

  .row-btn {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 18px;
    min-height: 74px;
    text-align: left;
    padding: 14px 16px;
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) * 0.8);
    background: var(--card);
    color: inherit;
    cursor: pointer;
    transition:
      background 0.15s ease,
      border-color 0.15s ease;
  }

  .row-btn:hover {
    border-color: var(--clay);
    background: color-mix(in oklch, var(--foreground), transparent 96%);
  }

  .row-btn strong {
    display: block;
    margin-bottom: 4px;
    font-size: 15px;
    color: var(--foreground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row-copy {
    display: block;
    min-width: 0;
  }

  .row-copy .muted {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .empty {
    color: color-mix(in oklch, var(--muted-foreground), transparent 24%);
    font-size: 14px;
    text-align: center;
    padding: 48px 12px;
    border: 1px dashed var(--border);
    border-radius: calc(var(--radius) * 0.8);
  }

  /* ---- Cleanup buttons ---- */

  .clean-btn {
    background: none;
    border: 1px solid color-mix(in oklch, var(--border), var(--foreground) 18%);
    border-radius: calc(var(--radius) * 0.8);
    padding: 5px 12px;
    font-size: 12px;
    color: var(--muted-foreground);
    cursor: pointer;
  }

  .clean-btn:hover {
    background: color-mix(in oklch, var(--foreground), transparent 96%);
    color: var(--rust);
    border-color: var(--rust);
  }

  .clean-bar {
    display: flex;
    justify-content: flex-end;
    margin-top: 14px;
  }

  .clean-action {
    min-height: 32px;
  }

  .row-wrap {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 42px;
    align-items: stretch;
    gap: 10px;
  }

  .row-wrap .row-btn {
    min-width: 0;
  }

  .row-clean-btn {
    width: 42px;
    height: auto;
    min-height: 74px;
    padding: 0;
    font-size: 16px;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: calc(var(--radius) * 0.8);
    border: 1px solid var(--border);
  }

  @media (max-width: 720px) {
    .app {
      padding: 16px;
    }

    .with-panel .artifact-main {
      margin-right: 0;
    }

    .titlebar {
      align-items: flex-start;
      flex-wrap: wrap;
    }

    .list-summary {
      grid-template-columns: 1fr;
      align-items: start;
    }

    .summary-meta,
    .clean-bar {
      justify-content: flex-start;
    }

    .row-wrap,
    .row-btn {
      grid-template-columns: 1fr;
    }

    .row-clean-btn {
      width: 100%;
      min-height: 36px;
    }

    .slug {
      width: fit-content;
      max-width: 100%;
    }
  }

  /* ---- Confirmation dialog ---- */

  .confirm-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .confirm-dialog {
    background: var(--card);
    border: 1px solid color-mix(in oklch, var(--border), var(--foreground) 18%);
    border-radius: var(--radius);
    padding: 24px;
    max-width: 400px;
    width: 90%;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }

  .confirm-dialog p {
    margin: 0 0 8px;
  }

  .confirm-hint {
    color: color-mix(in oklch, var(--muted-foreground), transparent 24%);
    font-size: 13px;
    margin-bottom: 16px;
  }

  .confirm-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }

  .cancel-btn {
    background: none;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 4px 16px;
    font-size: 12px;
    color: var(--foreground);
    cursor: pointer;
  }

  .cancel-btn:hover {
    background: color-mix(in oklch, var(--foreground), transparent 96%);
  }
</style>
