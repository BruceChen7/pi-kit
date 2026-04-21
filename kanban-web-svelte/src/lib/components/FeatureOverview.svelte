<script lang="ts">
import type { ActionState, BoardCard } from "../types";
import type { OverviewAction } from "../ui-types";

export let feature: BoardCard | null;
export let runningCount: number;
export let reviewCount: number;
export let blockedCount: number;
export let recentAction: ActionState | null;
export let actions: OverviewAction[];
export let onRunAction: (actionId: string) => void;
</script>

<section class="shell-panel overview-pane">
  <div class="panel-header">
    <div>
      <p class="eyebrow">Feature Overview</p>
      <h2>{feature ? feature.title : "Select a feature"}</h2>
    </div>
    {#if feature}
      <span class="feature-id">{feature.id}</span>
    {/if}
  </div>

  {#if !feature}
    <p class="empty-state">Select a feature card to scope the overview strip.</p>
  {:else}
    <div class="overview-grid">
      <article class="overview-stat">
        <span class="overview-label">Running</span>
        <strong>{runningCount}</strong>
      </article>
      <article class="overview-stat">
        <span class="overview-label">Review</span>
        <strong>{reviewCount}</strong>
      </article>
      <article class="overview-stat">
        <span class="overview-label">Blocked</span>
        <strong>{blockedCount}</strong>
      </article>
      <article class="overview-stat recent-action">
        <span class="overview-label">Recent Action</span>
        {#if recentAction}
          <strong>{recentAction.action}</strong>
          <span>{recentAction.summary}</span>
        {:else}
          <strong>None yet</strong>
          <span>Waiting for action events</span>
        {/if}
      </article>
    </div>

    {#if actions.length > 0}
      <div class="overview-actions">
        {#each actions as action}
          <button disabled={action.disabled} on:click={() => onRunAction(action.id)}>
            {action.label}
          </button>
        {/each}
      </div>

      <ul class="overview-hints">
        {#each actions as action}
          <li class:muted={action.disabled}>{action.label}: {action.hint}</li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>
