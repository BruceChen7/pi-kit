<script lang="ts">
import type { ActionState, BoardCard, BoardSnapshot } from "../types";

export let board: BoardSnapshot | null;
export let latestStatusByCard: Record<string, ActionState>;
export let selectedFeatureId: string | null;
export let selectedChildId: string | null;
export let activeExecutionCardId: string | null;
export let onSelectCard: (card: BoardCard) => void;
export let onOpenCardActions: (card: BoardCard) => void;
export let onStartCard: (card: BoardCard) => void;
export let onFocusRun: (card: BoardCard) => void;
export let onOpenReview: (card: BoardCard) => void;
export let onRetryCard: (card: BoardCard) => void;
export let actionsEnabled = true;

// biome-ignore lint/correctness/noUnusedVariables: Svelte template references this helper.
function statusClass(status: ActionState["status"]): string {
  return `badge ${status}`;
}

// biome-ignore lint/correctness/noUnusedVariables: Svelte template references this helper.
function isSelected(card: BoardCard): boolean {
  return card.kind === "feature"
    ? card.id === selectedFeatureId
    : card.id === selectedChildId;
}

// biome-ignore lint/correctness/noUnusedVariables: Svelte template references this helper.
function isActiveExecution(card: BoardCard): boolean {
  return card.kind === "child" && card.id === activeExecutionCardId;
}
</script>

<section class="shell-panel board-pane">
  <div class="panel-header">
    <div>
      <p class="eyebrow">Board</p>
      <h2>Feature + child lanes</h2>
    </div>
  </div>

  {#if !board}
    <p class="empty-state">No board loaded yet.</p>
  {:else}
    {#if board.errors.length > 0}
      <p class="error">Board errors: {board.errors.join(" | ")}</p>
    {/if}

    <div class="lane-grid">
      {#each board.lanes as lane}
        <article class="lane-card">
          <header class="lane-header">
            <h3>{lane.name}</h3>
            <span>{lane.cards.length}</span>
          </header>

          <ul class="lane-list">
            {#if lane.cards.length === 0}
              <li class="lane-empty">No cards</li>
            {/if}

            {#each lane.cards as card}
              <li>
                <article
                  class:selected={isSelected(card)}
                  class:active-execution={isActiveExecution(card)}
                  class="board-card"
                >
                  <button class="board-card-main" on:click={() => onSelectCard(card)}>
                    <div class="board-card-topline">
                      <span class:feature-kind={card.kind === "feature"} class="kind-pill">
                        {card.kind}
                      </span>
                      <span class="board-card-id">{card.id}</span>
                    </div>

                    <div class="board-card-title">{card.title}</div>

                    <div class="board-card-meta">
                      <span>Lane: {card.lane}</span>
                      {#if card.parentId}
                        <span>Feature: {card.parentId}</span>
                      {/if}
                    </div>

                    {#if latestStatusByCard[card.id]}
                      <div class="board-card-status">
                        <span class={statusClass(latestStatusByCard[card.id].status)}>
                          {latestStatusByCard[card.id].status}
                        </span>
                        <span>{latestStatusByCard[card.id].summary}</span>
                      </div>
                    {/if}

                    {#if isActiveExecution(card)}
                      <div class="board-card-banner">Auto-focused execution target</div>
                    {/if}
                  </button>

                  {#if actionsEnabled}
                    <div class="card-controls">
                      {#if card.kind === "child" && card.lane === "Ready"}
                        <button class="quick-button primary" on:click={() => onStartCard(card)}>
                          Start
                        </button>
                      {/if}

                      {#if card.kind === "child" && card.lane === "In Progress"}
                        <button class="quick-button" on:click={() => onFocusRun(card)}>
                          Focus Run
                        </button>
                      {/if}

                      {#if card.kind === "child" && card.lane === "Review"}
                        <button class="quick-button" on:click={() => onOpenReview(card)}>
                          Open Review
                        </button>
                      {/if}

                      {#if card.kind === "child" && latestStatusByCard[card.id]?.status === "failed"}
                        <button class="quick-button warning" on:click={() => onRetryCard(card)}>
                          Retry
                        </button>
                      {/if}

                      <button class="ghost-button" on:click={() => onOpenCardActions(card)}>
                        Actions
                      </button>
                    </div>
                  {/if}
                </article>
              </li>
            {/each}
          </ul>
        </article>
      {/each}
    </div>
  {/if}
</section>
