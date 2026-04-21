<script lang="ts">
import { tick } from "svelte";

import InspectorTerminal from "./InspectorTerminal.svelte";

import type { InspectorTab } from "../ui-types";
import type {
  ActionState,
  BoardCard,
  CardContext,
  ChildLifecycleEvent,
} from "../types";

export let selectedFeature: BoardCard | null;
export let selectedChild: BoardCard | null;
export let activeExecutionCardId: string | null;
export let activeTab: InspectorTab;
export let context: CardContext | null;
export let loadingContext: boolean;
export let contextError: string | null;
export let latestStatus: ActionState | null;
export let latestLifecycle: ChildLifecycleEvent | null;
export let actionLog: ActionState[];
export let onSelectTab: (tab: InspectorTab) => void;
export let onOpenActionDialog: (card: BoardCard) => void;
export let onOpenChildForm: () => void;
export let onChangeChildTitle: (value: string) => void;
export let onSubmitChildForm: () => void;
export let onCancelChildForm: () => void;
export let actionsEnabled = true;
export let childFormOpen = false;
export let childTitle = "";
export let childError: string | null = null;
export let childSubmitting = false;
export let terminalUnavailableMessage: string | null = null;

let childTitleInput: HTMLInputElement | null = null;

const tabs: InspectorTab[] = ["terminal", "context", "logs", "handoff"];

$: latestStatusLabel = latestLifecycle
  ? latestLifecycle.type.replace("child-", "")
  : (latestStatus?.status ?? "idle");
$: if (childFormOpen) {
  void focusChildTitleInput();
}
$: latestSummary =
  latestLifecycle?.summary ?? latestStatus?.summary ?? "No action summary yet";

async function focusChildTitleInput(): Promise<void> {
  await tick();
  childTitleInput?.focus();
}
</script>

<section class="shell-panel inspector-pane">
  <div class="panel-header inspector-header">
    <div>
      <p class="eyebrow">Inspector</p>
      <h2>{selectedChild ? selectedChild.title : "Select a child card"}</h2>
      {#if selectedFeature}
        <p class="subtle">Feature scope: {selectedFeature.title} ({selectedFeature.id})</p>
      {/if}
    </div>
    <div class="inspector-header-actions">
      {#if selectedFeature}
        <button on:click={onOpenChildForm}>+ Add Child</button>
      {/if}
      {#if selectedChild && actionsEnabled}
        <button on:click={() => onOpenActionDialog(selectedChild)}>Actions</button>
      {/if}
    </div>
  </div>

  {#if childFormOpen}
    <form class="inline-form" on:submit|preventDefault={onSubmitChildForm}>
      <label>
        <span>Title</span>
        <input
          bind:this={childTitleInput}
          value={childTitle}
          placeholder="e.g. Implement form validation"
          on:input={(event) =>
            onChangeChildTitle((event.currentTarget as HTMLInputElement).value)}
        />
      </label>

      {#if childError}
        <p class="error form-error">{childError}</p>
      {/if}

      <div class="inline-form-actions">
        <button type="button" on:click={onCancelChildForm} disabled={childSubmitting}>
          Cancel
        </button>
        <button type="submit" disabled={childSubmitting}>
          {#if childSubmitting}Creating…{:else}Create Child{/if}
        </button>
      </div>
    </form>
  {/if}

  {#if !selectedChild}
    <p class="empty-state">
      {#if selectedFeature}
        {#if childFormOpen}
          Add a child under the current feature, or choose an existing child card to inspect.
        {:else}
          Feature selected. Add a child from the button above, or choose an existing child card to inspect.
        {/if}
      {:else}
        Choose a feature first, then add or inspect child cards here.
      {/if}
    </p>
  {:else}
    <div class="inspector-summary-row">
      <div class="summary-pill">
        <span class="pill-label">Execution focus</span>
        <strong>{activeExecutionCardId === selectedChild.id ? "active" : "standby"}</strong>
      </div>
      <div class="summary-pill">
        <span class="pill-label">Latest status</span>
        <strong>{latestStatusLabel}</strong>
      </div>
      <div class="summary-pill wide">
        <span class="pill-label">Summary</span>
        <strong>{latestSummary}</strong>
      </div>
    </div>

    <div class="tabs" role="tablist" aria-label="Inspector tabs">
      {#each tabs as tab}
        <button
          class:tab-active={tab === activeTab}
          class="tab-button"
          role="tab"
          aria-selected={tab === activeTab}
          on:click={() => onSelectTab(tab)}
        >
          {tab}
        </button>
      {/each}
    </div>

    <div class="inspector-body">
      {#if activeTab === "terminal"}
        <InspectorTerminal
          cardId={selectedChild.id}
          {activeExecutionCardId}
          unavailableMessage={terminalUnavailableMessage}
        />
      {:else if activeTab === "context"}
        {#if loadingContext}
          <p>Loading child context…</p>
        {:else if contextError}
          <p class="error">{contextError}</p>
        {:else if context}
          <dl class="detail-grid">
            <div><dt>Card</dt><dd>{context.cardId}</dd></div>
            <div><dt>Title</dt><dd>{context.title}</dd></div>
            <div><dt>Kind</dt><dd>{context.kind}</dd></div>
            <div><dt>Lane</dt><dd>{context.lane}</dd></div>
            <div><dt>Feature</dt><dd>{context.parentCardId ?? "<none>"}</dd></div>
            <div><dt>Branch</dt><dd>{context.branch ?? "<none>"}</dd></div>
            <div><dt>Base Branch</dt><dd>{context.baseBranch ?? "<none>"}</dd></div>
            <div><dt>Merge Target</dt><dd>{context.mergeTarget ?? "<none>"}</dd></div>
            <div><dt>Worktree</dt><dd>{context.worktreePath ?? "<none>"}</dd></div>
            <div><dt>Session</dt><dd>{context.session?.chatJid ?? "<none>"}</dd></div>
          </dl>
        {:else}
          <p class="empty-state">No context available for the selected child.</p>
        {/if}
      {:else if activeTab === "logs"}
        {#if actionLog.length === 0}
          <p class="empty-state">No action events for the current selection.</p>
        {:else}
          <ul class="log-list">
            {#each actionLog as state}
              <li class="log-item">
                <div class="log-title-row">
                  <strong>{state.status}</strong>
                  <span>{state.action}</span>
                </div>
                <div>{state.summary}</div>
                <div class="log-meta-grid">
                  <span>request: {state.requestId}</span>
                  <span>card: {state.cardId}</span>
                  <span>started: {state.startedAt ?? "<none>"}</span>
                  <span>finished: {state.finishedAt ?? "<none>"}</span>
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      {:else if activeTab === "handoff"}
        <section class="handoff-placeholder">
          <p class="placeholder-title">Review-ready handoff</p>
          <p class="subtle">This view only becomes authoritative after a real child-completed signal.</p>
          <dl class="detail-grid">
            <div>
              <dt>Latest runtime event</dt>
              <dd>{latestLifecycle?.type ?? "<none>"}</dd>
            </div>
            <div>
              <dt>Summary</dt>
              <dd>{latestSummary}</dd>
            </div>
            <div>
              <dt>Session</dt>
              <dd>{context?.session?.chatJid ?? "<none>"}</dd>
            </div>
            <div>
              <dt>Worktree</dt>
              <dd>{context?.worktreePath ?? "<none>"}</dd>
            </div>
            <div>
              <dt>Branch</dt>
              <dd>{context?.branch ?? "<none>"}</dd>
            </div>
            <div>
              <dt>Review lane</dt>
              <dd>{context?.lane ?? selectedChild.lane}</dd>
            </div>
          </dl>
        </section>
      {/if}
    </div>
  {/if}
</section>
