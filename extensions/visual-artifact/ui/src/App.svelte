<script lang="ts">
// biome-ignore lint/correctness/noUnusedImports: used in template

import { onMount } from "svelte";
import { normalizeArtifactNodes } from "./normalize-spec.ts";
// biome-ignore lint/correctness/noUnusedImports: used in template
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
let theme = $state<"dark" | "light">("dark");
let projects = $state<ProjectSummary[]>([]);
let artifacts = $state<ArtifactSummary[]>([]);

/* ---- Navigation ---- */

function goHome(): void {
  currentView = "home";
  projects = [];
  artifacts = [];
  window.glimpse?.send({ type: "list-projects" });
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
}

/* ---- Init ---- */

onMount(() => {
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
});

function handleThemeToggle(next: string): void {
  theme = next as "dark" | "light";
}

function artifactNodes(): { type: string; props: Record<string, unknown> }[] {
  const spec = bootData.artifactSpec as
    | { nodes?: unknown; data?: Record<string, unknown[]> }
    | undefined;
  return normalizeArtifactNodes(spec?.nodes, spec?.data);
}
</script>

<main class="app" data-theme={theme}>
  <header class="titlebar">
    {#if currentView !== "home"}
      <button type="button" class="back-button" onclick={goHome}>&larr;</button>
    {/if}
    <h1>Visual Artifact</h1>
    {#if currentView === "artifact" && bootData.artifactSlug}
      <p class="muted">· {bootData.artifactSlug}</p>
    {:else if currentView === "project" && bootData.projectName}
      <p class="muted">· {bootData.projectName}</p>
    {/if}
    <div class="spacer"></div>
    <ThemeToggle {theme} onToggle={handleThemeToggle} />
  </header>

  <section class="content">
    {#if currentView === "home"}
      {#if projects.length > 0}
        <div class="grid">
          {#each projects as project}
            <button type="button" class="card-btn" onclick={() => goProject(project.name)}>
              <strong>{project.name}</strong>
              <span class="muted">{project.artifactCount} artifact{project.artifactCount !== 1 ? "s" : ""}</span>
            </button>
          {/each}
        </div>
      {:else}
        <p class="empty">No projects yet. Create an artifact first.</p>
      {/if}

    {:else if currentView === "project"}
      {#if artifacts.length > 0}
        <div class="list">
          {#each artifacts as artifact}
            <button
              type="button"
              class="row-btn"
              onclick={() => goArtifact(bootData.projectName ?? "", artifact.slug)}
            >
              <strong>{artifact.title}</strong>
              {#if artifact.description}
                <span class="muted">{artifact.description}</span>
              {/if}
              <span class="slug">{artifact.slug}</span>
            </button>
          {/each}
        </div>
      {:else}
        <p class="empty">No artifacts in this project.</p>
      {/if}

    {:else if currentView === "artifact"}
      {#if bootData.artifactSpec && artifactNodes().length > 0}
        <VisualArtifactRenderer nodes={artifactNodes()} />
      {:else}
        <p class="empty">Loading artifact...</p>
      {/if}
    {/if}
  </section>
</main>

<style>
  .app {
    font-family: var(--va-font-sans);
    padding: 24px;
    color: var(--va-text-primary);
    background: var(--va-bg-app);
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
    color: var(--va-text-muted);
    font-size: 13px;
  }

  .slug {
    color: var(--va-text-subtle);
    font-size: 11px;
    font-family: monospace;
  }

  .spacer {
    flex: 1;
  }

  .back-button {
    background: none;
    border: none;
    color: var(--va-accent-primary-text);
    font-size: 18px;
    cursor: pointer;
    padding: 0 4px;
  }

  .content {
    padding: 4px;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 12px;
  }

  .card-btn {
    display: block;
    text-align: left;
    padding: 16px;
    border: 1px solid var(--va-border-default);
    border-radius: var(--va-radius-lg);
    background: var(--va-bg-surface);
    cursor: pointer;
  }

  .card-btn:hover {
    border-color: var(--va-accent-primary);
  }

  .card-btn strong {
    display: block;
    margin-bottom: 4px;
    font-size: 15px;
    color: var(--va-text-primary);
  }

  .list {
    display: grid;
    gap: 8px;
  }

  .row-btn {
    display: block;
    text-align: left;
    padding: 12px 14px;
    border: 1px solid var(--va-border-default);
    border-radius: var(--va-radius-md);
    background: var(--va-bg-surface);
    cursor: pointer;
  }

  .row-btn:hover {
    border-color: var(--va-accent-primary);
  }

  .row-btn strong {
    display: block;
    margin-bottom: 2px;
    font-size: 14px;
    color: var(--va-text-primary);
  }

  .empty {
    color: var(--va-text-subtle);
    font-size: 14px;
    text-align: center;
    padding: 48px 12px;
    border: 1px dashed var(--va-border-default);
    border-radius: var(--va-radius-md);
  }
</style>
