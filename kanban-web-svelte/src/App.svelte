<script lang="ts">
import { onMount } from "svelte";

import { KanbanRuntimeApi } from "./lib/api";
import { validateRuntimeConnection } from "./lib/connection";
import {
  getBrowserStorage,
  readRuntimeConnectionFromStorage,
  writeRuntimeConnectionToStorage,
} from "./lib/runtime-settings";
import type {
  ActionState,
  BoardCard,
  BoardSnapshot,
  CardContext,
} from "./lib/types";

type ActionOption = {
  value: string;
  label: string;
  needsPrompt: boolean;
};

const ACTION_OPTIONS: ActionOption[] = [
  { value: "apply", label: "Apply", needsPrompt: false },
  { value: "open-session", label: "Open Session", needsPrompt: false },
  { value: "custom-prompt", label: "Custom Prompt", needsPrompt: true },
  { value: "reconcile", label: "Reconcile", needsPrompt: false },
  { value: "validate", label: "Validate", needsPrompt: false },
  { value: "prune-merged", label: "Prune Merged", needsPrompt: false },
];

const GLOBAL_ACTIONS = new Set(["reconcile", "validate", "prune-merged"]);

const runtimeStorage = getBrowserStorage();
const initialConnection = readRuntimeConnectionFromStorage(runtimeStorage, {
  defaultBaseUrl: "http://127.0.0.1:17888",
});

let baseUrl = initialConnection.baseUrl;
let token = initialConnection.token;

// biome-ignore lint/correctness/noUnusedVariables: Svelte template references are not tracked here.
let board: BoardSnapshot | null = null;
// biome-ignore lint/correctness/noUnusedVariables: Svelte template references are not tracked here.
let loadingBoard = false;
// biome-ignore lint/correctness/noUnusedVariables: Svelte template references are not tracked here.
let runtimeError: string | null = null;

let streamStatus: "disconnected" | "connecting" | "connected" | "error" =
  "disconnected";
// biome-ignore lint/correctness/noUnusedVariables: Svelte template references are not tracked here.
let streamError: string | null = null;
let stream: EventSource | null = null;

let latestStatusByCard: Record<string, ActionState> = {};
let actionLog: ActionState[] = [];

let activeCard: BoardCard | null = null;
let activeContext: CardContext | null = null;
// biome-ignore lint/correctness/noUnusedVariables: Svelte template references are not tracked here.
let dialogOpen = false;
// biome-ignore lint/correctness/noUnusedVariables: Svelte template references are not tracked here.
let dialogLoadingContext = false;
// biome-ignore lint/correctness/noUnusedVariables: Svelte template references are not tracked here.
let dialogError: string | null = null;
let selectedAction = "apply";
let promptText = "";
// biome-ignore lint/correctness/noUnusedVariables: Svelte template references are not tracked here.
let executingAction = false;

$: {
  writeRuntimeConnectionToStorage(runtimeStorage, {
    baseUrl,
    token,
  });
}

const selectedActionMeta = ACTION_OPTIONS.find(
  (option) => option.value === selectedAction,
);

function connectionErrorMessage(): string | null {
  return validateRuntimeConnection({
    baseUrl,
    token,
  });
}

function createApi(): KanbanRuntimeApi {
  const error = connectionErrorMessage();
  if (error) {
    throw new Error(error);
  }

  return new KanbanRuntimeApi(baseUrl.trim(), token.trim());
}

async function loadBoard(): Promise<void> {
  loadingBoard = true;
  runtimeError = null;

  try {
    const api = createApi();
    board = await api.getBoard();
  } catch (error) {
    runtimeError = error instanceof Error ? error.message : String(error);
  } finally {
    loadingBoard = false;
  }
}

function pushActionState(state: ActionState): void {
  actionLog = [state, ...actionLog].slice(0, 40);
  if (state.cardId && state.cardId !== "__global__") {
    latestStatusByCard = {
      ...latestStatusByCard,
      [state.cardId]: state,
    };
  }
}

function connectStream(): void {
  disconnectStream();
  streamStatus = "connecting";
  streamError = null;

  try {
    const api = createApi();
    const next = api.createEventSource();

    next.addEventListener("ready", () => {
      streamStatus = "connected";
    });

    next.addEventListener("state", (event) => {
      try {
        const payload = JSON.parse(
          (event as MessageEvent<string>).data,
        ) as ActionState;
        pushActionState(payload);
      } catch (error) {
        streamError = error instanceof Error ? error.message : String(error);
        streamStatus = "error";
      }
    });

    next.onerror = () => {
      if (streamStatus !== "connected") {
        streamStatus = "error";
        streamError = "Unable to connect to /kanban/stream";
      }
    };

    stream = next;
  } catch (error) {
    streamStatus = "error";
    streamError = error instanceof Error ? error.message : String(error);
  }
}

function disconnectStream(): void {
  if (stream) {
    stream.close();
    stream = null;
  }
  if (streamStatus !== "error") {
    streamStatus = "disconnected";
  }
}

// biome-ignore lint/correctness/noUnusedVariables: Svelte template references are not tracked here.
async function openActionDialog(card: BoardCard): Promise<void> {
  activeCard = card;
  activeContext = null;
  selectedAction = "apply";
  promptText = "";
  dialogError = null;
  dialogOpen = true;
  dialogLoadingContext = true;

  try {
    const api = createApi();
    activeContext = await api.getCardContext(card.id);
  } catch (error) {
    dialogError = error instanceof Error ? error.message : String(error);
  } finally {
    dialogLoadingContext = false;
  }
}

function closeDialog(): void {
  dialogOpen = false;
  activeCard = null;
  activeContext = null;
  dialogError = null;
  promptText = "";
  selectedAction = "apply";
}

// biome-ignore lint/correctness/noUnusedVariables: Svelte template references are not tracked here.
async function executeAction(): Promise<void> {
  if (!activeCard) return;

  dialogError = null;

  const isGlobalAction = GLOBAL_ACTIONS.has(selectedAction);
  if (!isGlobalAction && !activeContext) {
    dialogError = "Card context is required before executing this action.";
    return;
  }

  if (selectedActionMeta?.needsPrompt && !promptText.trim()) {
    dialogError = "Please input a prompt for custom-prompt.";
    return;
  }

  const cardId = isGlobalAction ? "__global__" : activeCard.id;
  const worktreeKey = isGlobalAction
    ? "__global__"
    : (activeContext?.worktreePath ?? activeContext?.branch ?? activeCard.id);

  executingAction = true;
  try {
    const api = createApi();
    const executeResult = await api.executeAction({
      action: selectedAction,
      cardId,
      worktreeKey,
      payload:
        selectedAction === "custom-prompt"
          ? {
              prompt: promptText,
            }
          : undefined,
    });

    pushActionState({
      requestId: executeResult.requestId,
      action: selectedAction,
      cardId,
      worktreeKey,
      status: executeResult.status,
      summary: "queued",
      startedAt: null,
      finishedAt: null,
      durationMs: null,
    });

    closeDialog();
  } catch (error) {
    dialogError = error instanceof Error ? error.message : String(error);
  } finally {
    executingAction = false;
  }
}

// biome-ignore lint/correctness/noUnusedVariables: Svelte template references are not tracked here.
function statusClass(status: ActionState["status"]): string {
  return `badge ${status}`;
}

onMount(() => {
  const initialError = connectionErrorMessage();
  if (initialError) {
    runtimeError = initialError;
  } else {
    void loadBoard();
    connectStream();
  }

  return () => {
    disconnectStream();
  };
});
</script>

<main class="app">
    <section class="panel">
        <h2>Kanban Runtime Connection</h2>
        <div class="settings-grid">
            <label for="base-url">Base URL</label>
            <input
                id="base-url"
                bind:value={baseUrl}
                placeholder="http://127.0.0.1:17888"
            />

            <label for="token">Token (Optional)</label>
            <input
                id="token"
                bind:value={token}
                placeholder="Bearer token (optional)"
            />
        </div>

        <div class="actions">
            <button on:click={() => void loadBoard()} disabled={loadingBoard}>
                {#if loadingBoard}Loading…{:else}Reload Board{/if}
            </button>
            <button on:click={connectStream}>Reconnect Stream</button>
            <button on:click={disconnectStream}>Disconnect Stream</button>
        </div>

        <p class="status">
            Stream: <strong>{streamStatus}</strong>
            {#if streamError}
                <span class="error"> · {streamError}</span>
            {/if}
        </p>
        {#if runtimeError}
            <p class="error">{runtimeError}</p>
        {/if}
    </section>

    <section class="panel">
        <h2>Board</h2>
        {#if !board}
            <p>No board loaded yet.</p>
        {:else}
            {#if board.errors.length > 0}
                <p class="error">Board errors: {board.errors.join(" | ")}</p>
            {/if}
            <div class="board">
                {#each board.lanes as lane}
                    <article class="lane">
                        <h3>{lane.name}</h3>
                        <ul class="cards">
                            {#each lane.cards as card}
                                <li>
                                    <button
                                        class="card-btn"
                                        on:click={() =>
                                            void openActionDialog(card)}
                                    >
                                        <div class="card-title">
                                            {card.title}
                                        </div>
                                        <div class="card-meta">
                                            <span>{card.id}</span>
                                            <span>{card.kind}</span>
                                        </div>
                                        {#if latestStatusByCard[card.id]}
                                            <div class="card-meta">
                                                <span
                                                    class={statusClass(
                                                        latestStatusByCard[
                                                            card.id
                                                        ].status,
                                                    )}
                                                >
                                                    {latestStatusByCard[card.id]
                                                        .status}
                                                </span>
                                                <span
                                                    >{latestStatusByCard[
                                                        card.id
                                                    ].summary}</span
                                                >
                                            </div>
                                        {/if}
                                    </button>
                                </li>
                            {/each}
                        </ul>
                    </article>
                {/each}
            </div>
        {/if}
    </section>

    <section class="panel">
        <h2>Recent Action Events</h2>
        {#if actionLog.length === 0}
            <p>No action events yet.</p>
        {:else}
            <ul class="log-list">
                {#each actionLog as state}
                    <li class="log-item">
                        <strong>{state.status}</strong>
                        · {state.action}
                        · {state.cardId}
                        <div>{state.summary}</div>
                    </li>
                {/each}
            </ul>
        {/if}
    </section>
</main>

{#if dialogOpen && activeCard}
    <div
        class="dialog-backdrop"
        role="button"
        tabindex="0"
        on:click|self={closeDialog}
        on:keydown={(event) => {
            if (event.key === "Escape" || event.key === "Enter") {
                closeDialog();
            }
        }}
    >
        <section class="dialog" role="dialog" aria-modal="true">
            <h3>{activeCard.title} ({activeCard.id})</h3>

            {#if dialogLoadingContext}
                <p>Loading card context…</p>
            {:else if activeContext}
                <p>
                    Branch: {activeContext.branch ?? "<none>"}
                    <br />
                    Worktree: {activeContext.worktreePath ?? "<none>"}
                    <br />
                    Session: {activeContext.session?.chatJid ?? "<none>"}
                </p>
            {/if}

            <label>
                Action
                <select bind:value={selectedAction}>
                    {#each ACTION_OPTIONS as option}
                        <option value={option.value}>{option.label}</option>
                    {/each}
                </select>
            </label>

            {#if selectedActionMeta?.needsPrompt}
                <label>
                    Prompt
                    <textarea
                        bind:value={promptText}
                        placeholder="Describe what the agent should do for this card"
                    ></textarea>
                </label>
            {/if}

            {#if dialogError}
                <p class="error">{dialogError}</p>
            {/if}

            <div class="actions">
                <button on:click={closeDialog}>Cancel</button>
                <button
                    on:click={() => void executeAction()}
                    disabled={executingAction}
                >
                    {#if executingAction}Executing…{:else}Confirm Execute{/if}
                </button>
            </div>
        </section>
    </div>
{/if}
