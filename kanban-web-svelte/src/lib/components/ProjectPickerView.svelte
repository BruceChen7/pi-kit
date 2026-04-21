<script lang="ts">
import type { BrowserRecentProject } from "../project-browser-access";

export let loading = false;
export let error: string | null = null;
export let recentProjects: BrowserRecentProject[] = [];
export let onSelectFolder: () => void;
export let onSelectRecent: (project: BrowserRecentProject) => void;
</script>

<section class="shell-panel project-picker-pane">
  <div class="panel-header">
    <div>
      <p class="eyebrow">Project Selection</p>
      <h1>Select a work project</h1>
      <p class="subtle">
        Choose a project folder to load its kanban board from `.pi/kanban/board.json`.
      </p>
    </div>
  </div>

  {#if error}
    <p class="error">{error}</p>
  {/if}

  <div class="project-picker-actions">
    <button on:click={onSelectFolder} disabled={loading}>
      {#if loading}Opening…{:else}Select Folder{/if}
    </button>
  </div>

  <div class="recent-projects-section">
    <div class="recent-projects-header">
      <h2>Recent Projects</h2>
      <span>{recentProjects.length}</span>
    </div>

    {#if recentProjects.length === 0}
      <p class="empty-state">No recent projects yet.</p>
    {:else}
      <ul class="recent-project-list">
        {#each recentProjects as project}
          <li>
            <button class="recent-project-card" on:click={() => onSelectRecent(project)}>
              <strong>{project.name}</strong>
              <span>Last used: {new Date(project.lastUsedAt).toLocaleString()}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</section>
