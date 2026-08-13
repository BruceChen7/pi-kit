<script lang="ts">
import { onMount } from "svelte";
import { registerGlimpseCloseShortcuts } from "../../../shared/glimpse-ui-shortcuts.ts";
import AnnotationPanel from "./annotations/annotation-panel.svelte";
import AnnotationProvider from "./annotations/annotation-provider.svelte";
import {
  dayLabel,
  groupByDay,
  timeLabel,
  typeKey,
  uniqueTypeKeys,
} from "./list-helpers.ts";
import { normalizeArtifactNodes } from "./normalize-spec.ts";
import VisualArtifactRenderer from "./renderer/visual-artifact-renderer.svelte";

type ViewType = "home" | "project";
type ProjectSummary = { name: string; artifactCount: number };
type ArtifactSummary = {
  slug: string;
  title: string;
  description?: string;
  createdAt: string;
  nodeCount: number;
  nodeTypes: string[];
};
type BootData = {
  view: "home" | "project" | "artifact";
  projectName?: string;
  artifactSlug?: string;
  artifactSpec?: unknown;
};

const boot = window.__VISUAL_ARTIFACT_BOOT__ ?? { view: "home" as const };

let currentView = $state<ViewType>(boot.view === "home" ? "home" : "project");
let projects = $state<ProjectSummary[]>([]);
let artifacts = $state<ArtifactSummary[]>([]);
let projectName = $state<string>(boot.projectName ?? "");
let searchQuery = $state("");

/* ---- Selected artifact: slug + spec cache ---- */

let selectedSlug = $state<string | null>(
  boot.view === "artifact" ? (boot.artifactSlug ?? null) : null,
);
let specCache = $state<Record<string, unknown>>(
  boot.view === "artifact" && boot.artifactSlug && boot.artifactSpec
    ? { [boot.artifactSlug]: boot.artifactSpec }
    : {},
);

let selectedSpec = $derived(
  selectedSlug ? (specCache[selectedSlug] ?? null) : null,
);

let selectedTopics = $derived(
  (selectedSpec as { topics?: string[] } | null)?.topics ?? [],
);

let totalArtifactCount = $derived(
  projects.reduce((sum, project) => sum + project.artifactCount, 0),
);

/* ---- Filtered / grouped list for the left column ---- */

let visibleArtifacts = $derived(
  searchQuery.trim()
    ? artifacts.filter((a) => {
        const q = searchQuery.trim().toLowerCase();
        return (
          a.title.toLowerCase().includes(q) ||
          a.slug.toLowerCase().includes(q) ||
          (a.description ?? "").toLowerCase().includes(q) ||
          (a.topics ?? []).some((topic) => topic.toLowerCase().includes(q))
        );
      })
    : artifacts,
);

let groupedArtifacts = $derived(groupByDay(visibleArtifacts));

/* ---- Type icon SVG map (display buckets from list-helpers) ---- */

const TYPE_ICONS: Record<string, string> = {
  mermaid:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2.5" width="5" height="3.4" rx="1"/><rect x="9" y="2.5" width="5" height="3.4" rx="1"/><rect x="5.5" y="10" width="5" height="3.4" rx="1"/><path d="M6 6v2.6h4V10"/></svg>',
  table:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="2" y="3" width="12" height="10" rx="1.2"/><path d="M2 6.5h12M6.5 3v10"/></svg>',
  kpi: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 13V9M8 13V5.5M13 13V3"/></svg>',
  accordion:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M6 6.5l2 2 2-2M6 10l2 2 2-2"/></svg>',
  text: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h7"/></svg>',
};

const TYPE_LABELS: Record<string, string> = {
  mermaid: "mermaid diagram",
  table: "table",
  kpi: "kpi-grid",
  accordion: "accordion",
  text: "text",
};

/* ---- Navigation ---- */

function goHome(): void {
  currentView = "home";
  projects = [];
  artifacts = [];
  projectName = "";
  selectedSlug = null;
  specCache = {};
  searchQuery = "";
  window.glimpse?.send({ type: "list-projects" });
}

function goProject(name: string): void {
  currentView = "project";
  projectName = name;
  artifacts = [];
  selectedSlug = null;
  specCache = {};
  searchQuery = "";
  window.glimpse?.send({ type: "list-artifacts", projectName: name });
}

function selectArtifact(slug: string): void {
  selectedSlug = slug;
  if (!specCache[slug] && projectName) {
    window.glimpse?.send({ type: "get-artifact", projectName, slug });
  }
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
    if (!detail?.spec) return;
    // Cache only the artifact the user is currently looking at — stale
    // responses for previously clicked rows must not clobber the view.
    if (detail.slug === selectedSlug) {
      specCache = { ...specCache, [detail.slug]: detail.spec };
    }
  };
  const onDeleted = (e: Event) => {
    const detail = (e as CustomEvent).detail as
      | { projectName: string; slug: string }
      | undefined;
    if (detail?.slug === selectedSlug) {
      selectedSlug = null;
    }
    if (projectName) {
      window.glimpse?.send({ type: "list-artifacts", projectName });
    }
  };
  const onError = (e: Event) => {
    console.error("VA error:", (e as CustomEvent).detail);
  };

  window.addEventListener("visual-artifact:projects", onProjects);
  window.addEventListener("visual-artifact:artifacts", onArtifacts);
  window.addEventListener("visual-artifact:artifact", onArtifact);
  window.addEventListener("visual-artifact:error", onError);
  window.addEventListener("visual-artifact:deleted", onDeleted);
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
  } else if (projectName) {
    window.glimpse?.send({ type: "list-artifacts", projectName });
    // Direct artifact boot: the spec is already cached; warm the list.
    if (selectedSlug && !specCache[selectedSlug]) {
      window.glimpse?.send({
        type: "get-artifact",
        projectName,
        slug: selectedSlug,
      });
    }
  }

  return unregisterCloseShortcuts;
});

function artifactNodes(): { type: string; props: Record<string, unknown> }[] {
  const spec = selectedSpec as
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
  if (e.type === "visual-artifact:project-cleaned") {
    goHome();
  } else if (e.type === "visual-artifact:all-cleaned") {
    projects = [];
    artifacts = [];
    selectedSlug = null;
    specCache = {};
  }
}

/* ---- Keyboard navigation ---- */

function handleKeydown(e: KeyboardEvent): void {
  const target = e.target as HTMLElement | null;
  if (target?.matches("input, textarea")) return;

  if (e.key === "Escape") {
    if (pendingCleanupAction) cancelConfirmed();
    return;
  }
  if (currentView !== "project") return;

  if (e.key === "ArrowLeft") {
    goHome();
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const slugs = visibleArtifacts.map((a) => a.slug);
    if (slugs.length === 0) return;
    const idx = selectedSlug ? slugs.indexOf(selectedSlug) : -1;
    const next =
      e.key === "ArrowDown"
        ? (idx + 1 + slugs.length) % slugs.length
        : (idx - 1 + slugs.length) % slugs.length;
    selectArtifact(slugs[next]);
  }
}
</script>

<svelte:window onkeydown={handleKeydown} />

<main class="app">
  <header class="titlebar">
    {#if currentView === "project"}
      <button type="button" class="back-button" onclick={goHome} title="Back to projects (&larr;)">&larr;</button>
    {/if}
    <h1>Visual Artifact</h1>
    {#if currentView === "project" && projectName}
      <p class="muted">· {projectName}</p>
    {/if}
    <div class="spacer"></div>
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
      <div class="history-layout">
        <!-- ============ Left: history list ============ -->
        <aside class="history-panel" aria-label="Artifact history">
          <div class="history-head">
            <div class="history-head-top">
              <h2>History</h2>
              <span class="count-pill">{visibleArtifacts.length} artifact{visibleArtifacts.length !== 1 ? "s" : ""}</span>
            </div>
            <div class="search">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
              <input
                type="text"
                placeholder="Filter by title, slug, description…"
                value={searchQuery}
                oninput={(e) => (searchQuery = e.currentTarget.value)}
                aria-label="Filter artifacts"
              />
            </div>
          </div>

          <div class="history-scroll">
            {#if groupedArtifacts.length === 0}
              <p class="list-empty">No artifacts match.</p>
            {/if}
            {#each groupedArtifacts as group (group.label)}
              <div class="day-group">
                <div class="day-label">{group.label}</div>
                {#each group.items as artifact (artifact.slug)}
                  <div class="artifact-row" class:active={artifact.slug === selectedSlug}>
                    <button
                      type="button"
                      class="artifact-item"
                      onclick={() => selectArtifact(artifact.slug)}
                    >
                      <span class="row-copy">
                        <strong class="t">{artifact.title}</strong>
                        {#if artifact.description}
                          <span class="d">{artifact.description}</span>
                        {/if}
                        <span class="meta">
                          <span class="node-badge">{artifact.nodeCount} node{artifact.nodeCount !== 1 ? "s" : ""}</span>
                          {#each uniqueTypeKeys(artifact.nodeTypes) as key (key)}
                            <span class="type-icon ti-{key}" title={TYPE_LABELS[key]}>
                              {@html TYPE_ICONS[key]}
                            </span>
                          {/each}
                          <span class="row-time">{timeLabel(artifact.createdAt)}</span>
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      class="row-clean-btn"
                      onclick={() => requestDeleteArtifact(projectName, artifact.slug)}
                      title="Delete this artifact"
                      aria-label={`Delete ${artifact.title}`}
                    >
                      &times;
                    </button>
                  </div>
                {/each}
              </div>
            {/each}
          </div>

          <div class="history-foot">
            <button
              type="button"
              class="clean-btn clean-action"
              onclick={() => requestCleanProject(projectName)}
            >
              Clean All in {projectName}
            </button>
          </div>
        </aside>

        <!-- ============ Right: detail ============ -->
        <section class="detail-panel">
          {#if selectedSpec && artifactNodes().length > 0}
            <div class="detail-toolbar">
              <span class="slug-pill">{selectedSlug}</span>
              {#if selectedTopics.length > 0}
                {#each selectedTopics as topic (topic)}
                  <span class="topic-tag">{topic}</span>
                {/each}
              {/if}
              <div class="detail-actions">
                <button
                  type="button"
                  class="clean-btn"
                  onclick={() => requestDeleteArtifact(projectName, selectedSlug ?? "")}
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
              </div>
            </div>
            <AnnotationProvider
              project={projectName}
              slug={selectedSlug ?? ""}
              bind:feedbackOpen
            >
              <div class="artifact-layout">
                <div class="artifact-main">
                  <VisualArtifactRenderer nodes={artifactNodes()} feedbackActive={feedbackOpen} />
                </div>
                <AnnotationPanel />
              </div>
            </AnnotationProvider>
          {:else if selectedSlug && !selectedSpec}
            <p class="detail-hint">Loading artifact…</p>
          {:else}
            <div class="detail-empty">
              <div class="empty-frame">
                <svg width="64" height="48" viewBox="0 0 64 48" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="4" y="4" width="24" height="18" rx="3"/>
                  <rect x="36" y="4" width="24" height="18" rx="3"/>
                  <rect x="4" y="28" width="24" height="16" rx="3"/>
                  <rect x="36" y="28" width="24" height="16" rx="3"/>
                  <path d="M16 26v2M48 26v2" stroke-dasharray="2 3"/>
                </svg>
              </div>
              <p>Select an artifact from the history</p>
              <span class="detail-hint">The rendered result appears here without leaving the list.</span>
            </div>
          {/if}
        </section>
      </div>
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

  /* ================= Master / Detail ================= */

  .history-layout {
    display: grid;
    grid-template-columns: 320px minmax(0, 1fr);
    gap: 20px;
    align-items: start;
  }

  /* ---- Left: history list ---- */

  .history-panel {
    position: sticky;
    top: 4px;
    display: flex;
    flex-direction: column;
    max-height: calc(100vh - 96px);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: color-mix(in oklch, var(--card), var(--background) 55%);
    overflow: hidden;
  }

  .history-head {
    padding: 14px 14px 12px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .history-head-top {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
  }

  .history-head h2 {
    margin: 0;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--muted-foreground);
  }

  .count-pill {
    display: inline-flex;
    align-items: center;
    min-height: 22px;
    padding: 0 9px;
    border-radius: 999px;
    background: color-mix(in oklch, var(--clay), transparent 92%);
    border: 1px solid color-mix(in oklch, var(--clay), transparent 70%);
    color: var(--clay-dark);
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
  }

  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    border: 1px solid var(--border);
    border-radius: 9px;
    background: var(--card);
    padding: 7px 10px;
  }

  .search svg {
    flex: none;
    color: var(--muted-foreground);
  }

  .search input {
    border: none;
    outline: none;
    background: none;
    font: inherit;
    font-size: 13px;
    width: 100%;
    color: var(--foreground);
  }

  .search input::placeholder {
    color: var(--muted-foreground);
  }

  .history-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 8px 8px 12px;
  }

  .day-group {
    margin-top: 8px;
  }

  .day-group:first-child {
    margin-top: 0;
  }

  .day-label {
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.6px;
    text-transform: uppercase;
    color: var(--muted-foreground);
    padding: 4px 8px 6px;
  }

  .artifact-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 34px;
    align-items: stretch;
    gap: 6px;
    margin-bottom: 4px;
  }

  .artifact-row.active .artifact-item {
    background: var(--card);
    border-color: color-mix(in oklch, var(--clay), transparent 55%);
  }

  .artifact-row.active .artifact-item::before {
    content: "";
    position: absolute;
    left: -1px;
    top: 10px;
    bottom: 10px;
    width: 3px;
    border-radius: 3px;
    background: var(--clay);
  }

  .artifact-item {
    position: relative;
    display: block;
    width: 100%;
    min-width: 0;
    text-align: left;
    border: 1px solid transparent;
    border-radius: 10px;
    padding: 10px 12px;
    background: none;
    cursor: pointer;
    font: inherit;
    color: inherit;
    transition:
      background 0.12s ease,
      border-color 0.12s ease;
  }

  .artifact-item:hover {
    background: color-mix(in oklch, var(--foreground), transparent 96%);
    border-color: var(--border);
  }

  .row-copy {
    display: block;
    min-width: 0;
  }

  .t {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.35;
    color: var(--foreground);
  }

  .d {
    display: -webkit-box;
    -webkit-line-clamp: 1;
    -webkit-box-orient: vertical;
    overflow: hidden;
    margin-top: 3px;
    font-size: 11.5px;
    color: var(--muted-foreground);
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 7px;
    font-size: 11px;
    color: var(--muted-foreground);
  }

  .node-badge {
    display: inline-flex;
    align-items: center;
    min-height: 18px;
    padding: 0 7px;
    border-radius: 999px;
    background: var(--muted);
    font-size: 10.5px;
    font-weight: 600;
    white-space: nowrap;
  }

  .type-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 19px;
    height: 19px;
    border-radius: 5px;
    flex: none;
  }

  .type-icon :global(svg) {
    width: 12px;
    height: 12px;
  }

  .ti-mermaid {
    background: color-mix(in oklch, var(--olive), transparent 88%);
    color: var(--olive-dark);
  }

  .ti-table {
    background: color-mix(in oklch, #42526e, transparent 90%);
    color: #42526e;
  }

  .ti-kpi {
    background: color-mix(in oklch, var(--clay), transparent 90%);
    color: var(--clay-dark);
  }

  .ti-accordion {
    background: color-mix(in oklch, #7a6234, transparent 90%);
    color: #7a6234;
  }

  .ti-text {
    background: var(--muted);
    color: var(--muted-foreground);
  }

  .row-time {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: 10.5px;
    white-space: nowrap;
  }

  .row-clean-btn {
    width: 34px;
    padding: 0;
    font-size: 16px;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 10px;
    border: 1px solid transparent;
    background: none;
    color: var(--muted-foreground);
    cursor: pointer;
    opacity: 0;
    transition:
      opacity 0.12s ease,
      background 0.12s ease,
      color 0.12s ease;
  }

  .artifact-row:hover .row-clean-btn,
  .artifact-row:focus-within .row-clean-btn {
    opacity: 1;
  }

  .row-clean-btn:hover {
    background: color-mix(in oklch, var(--rust), transparent 92%);
    color: var(--rust);
    border-color: color-mix(in oklch, var(--rust), transparent 70%);
  }

  .list-empty {
    color: color-mix(in oklch, var(--muted-foreground), transparent 24%);
    font-size: 13px;
    text-align: center;
    padding: 32px 12px;
  }

  .history-foot {
    padding: 10px 14px 12px;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }

  .history-foot .clean-action {
    width: 100%;
  }

  /* ---- Right: detail ---- */

  .detail-panel {
    min-width: 0;
    min-height: 60vh;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--background);
    display: flex;
    flex-direction: column;
  }

  .detail-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    border-radius: var(--radius) var(--radius) 0 0;
    background: var(--card);
    flex-shrink: 0;
  }

  .slug-pill {
    display: inline-flex;
    align-items: center;
    min-height: 26px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--muted);
    color: var(--muted-foreground);
    font-family: var(--font-mono);
    font-size: 11px;
    max-width: 340px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .topic-tag {
    display: inline-flex;
    align-items: center;
    min-height: 24px;
    padding: 0 9px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    background: var(--muted);
    color: var(--muted-foreground);
    white-space: nowrap;
  }

  .detail-actions {
    margin-left: auto;
    display: flex;
    gap: 8px;
  }

  .artifact-layout {
    display: flex;
    position: relative;
    padding: 24px;
  }

  .artifact-main {
    flex: 1;
    width: min(100%, 1440px);
    max-width: 1440px;
    min-width: 0;
    margin: 0 auto;
    transition: margin-right 0.2s ease;
  }

  .artifact-main > :global(.va-node[data-va-type="text"]) {
    max-width: 96ch;
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

  .detail-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    min-height: 60vh;
    padding: 40px;
    color: var(--muted-foreground);
    text-align: center;
  }

  .empty-frame {
    width: 150px;
    height: 110px;
    border: 1.5px dashed color-mix(in oklch, var(--border), var(--muted-foreground) 30%);
    border-radius: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in oklch, var(--card), transparent 40%);
  }

  .empty-frame svg {
    opacity: 0.45;
  }

  .detail-empty p {
    margin: 0;
    font-size: 13.5px;
    color: var(--foreground);
  }

  .detail-hint {
    color: color-mix(in oklch, var(--muted-foreground), transparent 24%);
    font-size: 12.5px;
    padding: 48px 12px;
    text-align: center;
  }

  /* ---- Home: projects ---- */

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

  .meta-pill {
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

  @media (max-width: 960px) {
    .history-layout {
      grid-template-columns: 1fr;
    }

    .history-panel {
      position: static;
      max-height: 340px;
    }
  }

  @media (max-width: 720px) {
    .app {
      padding: 16px;
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
