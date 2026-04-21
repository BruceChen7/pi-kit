<script lang="ts">
import type { BrowserRecentProject } from "../project-browser-access";

export let currentProjectName: string;
export let currentProjectId: string | null = null;
export let recentProjects: BrowserRecentProject[] = [];
export let loading = false;
export let onSelectFolder: () => void;
export let onReloadProject: () => void;
export let onSelectRecent: (project: BrowserRecentProject) => void;
</script>

<section class="shell-panel project-context-bar">
  <div class="panel-header">
    <div>
      <p class="eyebrow">Current Project</p>
      <h2>{currentProjectName}</h2>
      <p class="subtle">Board file: `.pi/kanban/board.json`</p>
    </div>
    <div class="actions project-context-actions">
      <button on:click={onSelectFolder} disabled={loading}>Select Folder</button>
      <button on:click={onReloadProject} disabled={loading}>
        {#if loading}Loading…{:else}Reload Project{/if}
      </button>
    </div>
  </div>

  <div class="recent-projects-section compact">
    <div class="recent-projects-header">
      <h3>Recent Projects</h3>
    </div>

    {#if recentProjects.length === 0}
      <p class="empty-state">No recent projects yet.</p>
    {:else}
      <div class="recent-project-chip-row">
        {#each recentProjects as project}
          <button
            class:current-project-chip={project.id === currentProjectId}
            class="recent-project-chip"
            on:click={() => onSelectRecent(project)}
          >
            {project.name}
          </button>
        {/each}
      </div>
    {/if}
  </div>
</section>
