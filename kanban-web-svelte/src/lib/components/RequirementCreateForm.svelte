<script lang="ts">
export let heading = "Create requirement";
export let subheading = "";
export let recentProjects: Array<{ id: string; name: string; path: string }> =
  [];
export let selectedProjectId: string | null = null;
export let title = "";
export let prompt = "";
export let projectName = "";
export let projectPath = "";
export let submitting = false;
export let error: string | null = null;
export let submitLabel = "Create and open";
export let onChooseProject: (projectId: string) => void = () => {};
</script>

<section class="create-form-shell">
  <div class="create-form-shell__header">
    <div>
      <p class="label">Quick create</p>
      <h2>{heading}</h2>
    </div>
    {#if subheading}
      <p class="subtle">{subheading}</p>
    {/if}
  </div>

  {#if recentProjects.length > 0}
    <div class="project-choice-row">
      {#each recentProjects as project}
        <button
          class:selected={selectedProjectId === project.id}
          class="project-chip"
          type="button"
          on:click={() => onChooseProject(project.id)}
        >
          <span>{project.name}</span>
          <small>{project.path}</small>
        </button>
      {/each}
    </div>
  {/if}

  <label class="field-group">
    <span>Requirement name</span>
    <input bind:value={title} class="field-input" placeholder="e.g. Redesign kanban home" />
  </label>

  <label class="field-group">
    <span>Prompt</span>
    <textarea
      bind:value={prompt}
      class="field-textarea"
      placeholder="Describe what pi should work on"
      rows="5"
    ></textarea>
  </label>

  <div class="field-grid">
    <label class="field-group">
      <span>Project name</span>
      <input bind:value={projectName} class="field-input" placeholder="e.g. pi-kit" />
    </label>

    <label class="field-group">
      <span>Project path</span>
      <input
        bind:value={projectPath}
        class="field-input"
        placeholder="/Users/.../repo"
      />
    </label>
  </div>

  {#if error}
    <p class="error">{error}</p>
  {/if}

  <div class="create-form-actions">
    <button class="primary-button" type="submit" disabled={submitting}>
      {submitting ? "Creating…" : submitLabel}
    </button>
  </div>
</section>
