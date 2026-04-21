<script lang="ts">
import { onMount } from "svelte";

import { KanbanRuntimeApi } from "./lib/api";
import {
  applyLaneTransition,
  deriveAutomationReaction,
  deriveAutoDispatchCardIds,
  serializeBoardSnapshot,
} from "./lib/board-automation";
import {
  deriveFeatureOverview,
  deriveOverviewActionTargets,
  deriveSelectionState,
  deriveVisibleActionLog,
} from "./lib/board-view-model";
import BoardPane from "./lib/components/BoardPane.svelte";
import FeatureOverview from "./lib/components/FeatureOverview.svelte";
import InspectorPane from "./lib/components/InspectorPane.svelte";
import { waitForBootstrapReady } from "./lib/bootstrap";
import { deriveChildLifecycleReaction } from "./lib/runtime-lifecycle";
import type { InspectorTab, OverviewAction } from "./lib/ui-types";
import type {
  ActionState,
  BoardCard,
  BoardLane,
  BoardSnapshot,
  CardContext,
  ChildLifecycleEvent,
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
const inFlightAutoDispatchCardIds = new Set<string>();
const api = new KanbanRuntimeApi();

let appPhase: "initializing" | "ready" | "degraded" | "fatal-error" =
  "initializing";
let bootstrapError: string | null = null;
let syncWarning: string | null = null;
let board: BoardSnapshot | null = null;
let loadingBoard = false;
let runtimeError: string | null = null;
let stream: EventSource | null = null;
let streamReconnectTimer: ReturnType<typeof setTimeout> | null = null;

let latestStatusByCard: Record<string, ActionState> = {};
let latestLifecycleByCard: Record<string, ChildLifecycleEvent> = {};
let actionLog: ActionState[] = [];

let selectedFeatureId: string | null = null;
let selectedChildId: string | null = null;
let activeExecutionCardId: string | null = null;
let activeInspectorTab: InspectorTab = "terminal";

let inspectorContext: CardContext | null = null;
let loadingInspectorContext = false;
let inspectorError: string | null = null;
let inspectorContextCardId: string | null = null;
let inspectorContextRequestId = 0;

let activeCard: BoardCard | null = null;
let activeContext: CardContext | null = null;
let dialogOpen = false;
let dialogLoadingContext = false;
let dialogError: string | null = null;
let selectedAction = "apply";
let promptText = "";
let executingAction = false;

$: selectedFeature =
  board?.cards.find(
    (card) => card.kind === "feature" && card.id === selectedFeatureId,
  ) ?? null;

$: selectedChild =
  board?.cards.find(
    (card) => card.kind === "child" && card.id === selectedChildId,
  ) ?? null;

$: selectedLifecycle = selectedChild
  ? (latestLifecycleByCard[selectedChild.id] ?? null)
  : null;

$: featureOverview = deriveFeatureOverview(board, selectedFeatureId, {
  latestStatusByCard,
  actionLog,
});

$: overviewTargets = deriveOverviewActionTargets(
  featureOverview.children,
  latestStatusByCard,
);

$: visibleActionLog = deriveVisibleActionLog(
  actionLog,
  board,
  selectedFeatureId,
  selectedChildId,
);

$: overviewActions = buildOverviewActions(overviewTargets);

$: if (selectedChildId !== inspectorContextCardId) {
  void refreshInspectorContext(selectedChildId);
}

const selectedActionMeta = ACTION_OPTIONS.find(
  (option) => option.value === selectedAction,
);

function clearSyncWarning(): void {
  syncWarning = null;
  if (appPhase !== "fatal-error") {
    appPhase = "ready";
  }
}

function setSyncWarning(message: string): void {
  syncWarning = message;
  if (appPhase !== "fatal-error") {
    appPhase = "degraded";
  }
}

function scheduleStreamReconnect(): void {
  if (streamReconnectTimer) {
    return;
  }

  streamReconnectTimer = setTimeout(() => {
    streamReconnectTimer = null;
    void loadBoard();
    connectStream();
  }, 1_500);
}

async function loadBoard(): Promise<boolean> {
  const previousBoard = board;
  loadingBoard = true;
  runtimeError = null;

  try {
    const nextBoard = await api.getBoard();
    board = nextBoard;

    const normalizedSelection = deriveSelectionState(nextBoard, {
      selectedFeatureId,
      selectedChildId,
    });
    selectedFeatureId = normalizedSelection.selectedFeatureId;
    selectedChildId = normalizedSelection.selectedChildId;

    const autoDispatchCardIds = deriveAutoDispatchCardIds(
      previousBoard,
      nextBoard,
      latestStatusByCard,
    ).filter((cardId) => !inFlightAutoDispatchCardIds.has(cardId));

    for (const cardId of autoDispatchCardIds) {
      const childCard = nextBoard.cards.find(
        (card) => card.kind === "child" && card.id === cardId,
      );
      if (!childCard || childCard.kind !== "child") {
        continue;
      }

      await autoDispatchChild(childCard);
    }

    return true;
  } catch (error) {
    runtimeError = error instanceof Error ? error.message : String(error);
    return false;
  } finally {
    loadingBoard = false;
  }
}

async function fetchCardContext(cardId: string): Promise<CardContext> {
  return api.getCardContext(cardId);
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

function pushLifecycleEvent(event: ChildLifecycleEvent): void {
  latestLifecycleByCard = {
    ...latestLifecycleByCard,
    [event.cardId]: event,
  };
}

function connectStream(): void {
  disconnectStream();

  try {
    const next = api.createEventSource();

    next.addEventListener("ready", () => {
      clearSyncWarning();
    });

    next.addEventListener("state", (event) => {
      try {
        const payload = JSON.parse(
          (event as MessageEvent<string>).data,
        ) as ActionState;
        clearSyncWarning();
        void handleIncomingActionState(payload);
      } catch (error) {
        setSyncWarning(error instanceof Error ? error.message : String(error));
      }
    });

    for (const lifecycleType of [
      "child-running",
      "child-completed",
      "child-failed",
    ] as const) {
      next.addEventListener(lifecycleType, (event) => {
        try {
          const payload = JSON.parse(
            (event as MessageEvent<string>).data,
          ) as ChildLifecycleEvent;
          clearSyncWarning();
          void handleIncomingChildLifecycleEvent(payload);
        } catch (error) {
          setSyncWarning(
            error instanceof Error ? error.message : String(error),
          );
        }
      });
    }

    next.onerror = () => {
      setSyncWarning("Realtime sync unavailable, retrying");
      scheduleStreamReconnect();
    };

    stream = next;
  } catch (error) {
    setSyncWarning(error instanceof Error ? error.message : String(error));
    scheduleStreamReconnect();
  }
}

function disconnectStream(): void {
  if (streamReconnectTimer) {
    clearTimeout(streamReconnectTimer);
    streamReconnectTimer = null;
  }

  if (stream) {
    stream.close();
    stream = null;
  }
}

function selectCard(card: BoardCard): void {
  if (card.kind === "feature") {
    selectedFeatureId = card.id;
    selectedChildId = null;
    return;
  }

  selectedFeatureId = card.parentId;
  selectedChildId = card.id;
}

function focusChild(card: BoardCard, tab: InspectorTab): void {
  if (card.kind !== "child") {
    return;
  }

  selectedFeatureId = card.parentId;
  selectedChildId = card.id;
  activeInspectorTab = tab;
}

async function refreshInspectorContext(cardId: string | null): Promise<void> {
  inspectorContextCardId = cardId;

  if (!cardId) {
    inspectorContext = null;
    inspectorError = null;
    loadingInspectorContext = false;
    return;
  }

  const requestId = ++inspectorContextRequestId;
  loadingInspectorContext = true;
  inspectorError = null;

  try {
    const context = await fetchCardContext(cardId);
    if (requestId !== inspectorContextRequestId) {
      return;
    }

    inspectorContext = context;
  } catch (error) {
    if (requestId !== inspectorContextRequestId) {
      return;
    }

    inspectorContext = null;
    inspectorError = error instanceof Error ? error.message : String(error);
  } finally {
    if (requestId === inspectorContextRequestId) {
      loadingInspectorContext = false;
    }
  }
}

async function openActionDialog(
  card: BoardCard,
  initialAction = "apply",
): Promise<void> {
  activeCard = card;
  activeContext = null;
  selectedAction = initialAction;
  promptText = "";
  dialogError = null;
  dialogOpen = true;
  dialogLoadingContext = true;

  try {
    if (card.id === selectedChildId && inspectorContext) {
      activeContext = inspectorContext;
      return;
    }

    activeContext = await fetchCardContext(card.id);
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

async function executeAction(): Promise<void> {
  if (!activeCard) return;

  dialogError = null;
  executingAction = true;

  try {
    await executeCardAction({
      card: activeCard,
      action: selectedAction,
      payload:
        selectedAction === "custom-prompt"
          ? {
              prompt: promptText,
            }
          : undefined,
      requiredPrompt: selectedActionMeta?.needsPrompt ?? false,
      tabOnStart: selectedAction === "apply" ? "terminal" : null,
    });

    closeDialog();
  } catch (error) {
    dialogError = error instanceof Error ? error.message : String(error);
  } finally {
    executingAction = false;
  }
}

async function executeCardAction(input: {
  card: BoardCard;
  action: string;
  payload?: Record<string, unknown>;
  requiredPrompt?: boolean;
  tabOnStart?: InspectorTab | null;
}): Promise<ActionState> {
  const isGlobalAction = GLOBAL_ACTIONS.has(input.action);
  if (input.requiredPrompt && !String(input.payload?.prompt ?? "").trim()) {
    throw new Error("Please input a prompt for custom-prompt.");
  }

  if (input.card.kind === "child" && input.tabOnStart) {
    focusChild(input.card, input.tabOnStart);
    activeExecutionCardId = input.card.id;
  }

  const cardId = isGlobalAction ? "__global__" : input.card.id;
  const executeResult = await api.executeAction({
    action: input.action,
    cardId,
    payload: input.payload,
  });

  const queuedState: ActionState = {
    requestId: executeResult.requestId,
    action: input.action,
    cardId,
    worktreeKey: isGlobalAction ? "__global__" : input.card.id,
    status: executeResult.status,
    summary: "queued",
    startedAt: null,
    finishedAt: null,
    durationMs: null,
  };
  pushActionState(queuedState);
  return queuedState;
}

async function autoDispatchChild(card: BoardCard): Promise<void> {
  if (card.kind !== "child") {
    return;
  }

  inFlightAutoDispatchCardIds.add(card.id);
  try {
    await executeCardAction({
      card,
      action: "apply",
      tabOnStart: "terminal",
    });
  } catch (error) {
    runtimeError = error instanceof Error ? error.message : String(error);
    activeExecutionCardId = null;
    activeInspectorTab = "logs";
  } finally {
    inFlightAutoDispatchCardIds.delete(card.id);
  }
}

async function moveCardToLane(
  card: BoardCard,
  targetLane: BoardLane,
  focusTab: InspectorTab,
): Promise<void> {
  if (!board || card.lane === targetLane) {
    if (card.kind === "child") {
      focusChild(card, focusTab);
    }
    return;
  }

  runtimeError = null;
  if (card.kind === "child") {
    focusChild(card, focusTab);
  } else {
    selectCard(card);
    activeInspectorTab = focusTab;
  }

  try {
    const nextBoard = applyLaneTransition(board, {
      cardId: card.id,
      targetLane,
    });
    await api.patchBoard(serializeBoardSnapshot(nextBoard));
    await loadBoard();
  } catch (error) {
    runtimeError = error instanceof Error ? error.message : String(error);
  }
}

async function handleIncomingActionState(state: ActionState): Promise<void> {
  pushActionState(state);

  if (state.cardId === "__global__") {
    return;
  }

  const reaction = deriveAutomationReaction(board, state);
  if (reaction.focusChildId && reaction.nextTab && board) {
    const card = board.cards.find(
      (entry) => entry.id === reaction.focusChildId,
    );
    if (card && card.kind === "child") {
      focusChild(card, reaction.nextTab);
    }
  }

  if (state.status === "queued" || state.status === "running") {
    activeExecutionCardId = state.cardId;
  }

  if (state.status === "failed") {
    activeExecutionCardId = null;
  }
}

async function handleIncomingChildLifecycleEvent(
  event: ChildLifecycleEvent,
): Promise<void> {
  pushLifecycleEvent(event);

  const reaction = deriveChildLifecycleReaction(board, event);
  const card = getCardById(event.cardId);

  if (
    reaction.focusChildId &&
    card &&
    card.kind === "child" &&
    reaction.nextTab
  ) {
    focusChild(card, reaction.nextTab);
  }

  if (event.type === "child-running") {
    activeExecutionCardId = event.cardId;
    return;
  }

  activeExecutionCardId = null;

  if (event.type === "child-completed" && card && card.kind === "child") {
    await moveCardToLane(card, "Review", "handoff");
  }
}

function buildOverviewActions(targets: {
  runningChildId: string | null;
  reviewChildId: string | null;
  blockedChildId: string | null;
  dispatchChildId: string | null;
}): OverviewAction[] {
  return [
    {
      id: "resume-last-running",
      label: "Resume Last Running",
      disabled: !targets.runningChildId,
      hint: targets.runningChildId
        ? `Focus ${targets.runningChildId}`
        : "No child is currently running",
    },
    {
      id: "open-next-review",
      label: "Open Next Review",
      disabled: !targets.reviewChildId,
      hint: targets.reviewChildId
        ? `Open ${targets.reviewChildId}`
        : "No child is in review",
    },
    {
      id: "retry-blocked",
      label: "Retry Blocked",
      disabled: !targets.blockedChildId,
      hint: targets.blockedChildId
        ? `Retry ${targets.blockedChildId}`
        : "No blocked child detected from action events",
    },
    {
      id: "dispatch-next",
      label: "Dispatch Next",
      disabled: !targets.dispatchChildId,
      hint: targets.dispatchChildId
        ? `Move ${targets.dispatchChildId} to In Progress`
        : "No ready child available",
    },
  ];
}

function getCardById(cardId: string | null): BoardCard | null {
  if (!board || !cardId) {
    return null;
  }

  return board.cards.find((card) => card.id === cardId) ?? null;
}

function runOverviewAction(actionId: string): void {
  const runningChild = getCardById(overviewTargets.runningChildId);
  const reviewChild = getCardById(overviewTargets.reviewChildId);
  const blockedChild = getCardById(overviewTargets.blockedChildId);
  const readyChild = getCardById(overviewTargets.dispatchChildId);

  if (actionId === "resume-last-running" && runningChild) {
    focusChild(runningChild, "terminal");
    return;
  }

  if (actionId === "open-next-review" && reviewChild) {
    focusChild(reviewChild, "handoff");
    return;
  }

  if (actionId === "retry-blocked" && blockedChild) {
    void executeCardAction({
      card: blockedChild,
      action: "apply",
      tabOnStart: "terminal",
    }).catch((error: unknown) => {
      runtimeError = error instanceof Error ? error.message : String(error);
    });
    return;
  }

  if (actionId === "dispatch-next" && readyChild) {
    void moveCardToLane(readyChild, "In Progress", "terminal");
  }
}

function handleBoardStartCard(card: BoardCard): void {
  void moveCardToLane(card, "In Progress", "terminal");
}

function handleBoardFocusRun(card: BoardCard): void {
  focusChild(card, "terminal");
}

function handleBoardOpenReview(card: BoardCard): void {
  focusChild(card, "handoff");
}

function handleBoardRetryCard(card: BoardCard): void {
  void executeCardAction({
    card,
    action: "apply",
    tabOnStart: "terminal",
  }).catch((error: unknown) => {
    runtimeError = error instanceof Error ? error.message : String(error);
  });
}

async function initializeApp(): Promise<void> {
  appPhase = "initializing";
  bootstrapError = null;
  runtimeError = null;
  syncWarning = null;

  try {
    await waitForBootstrapReady({
      bootstrap: () => api.bootstrap(),
    });

    const boardLoaded = await loadBoard();
    if (!boardLoaded) {
      throw new Error(runtimeError ?? "Unable to load board");
    }

    appPhase = "ready";
    connectStream();
  } catch (error) {
    appPhase = "fatal-error";
    bootstrapError = error instanceof Error ? error.message : String(error);
  }
}

onMount(() => {
  void initializeApp();

  return () => {
    disconnectStream();
  };
});
</script>

<main class="app-shell">
  <section class="shell-panel connection-panel">
    <div class="panel-header">
      <div>
        <p class="eyebrow">Product UI</p>
        <h1>Kanban Drive Console</h1>
        <p class="subtle">
          {#if appPhase === "initializing"}
            Preparing kanban workspace…
          {:else if appPhase === "fatal-error"}
            Unable to prepare the kanban workspace.
          {:else}
            Runtime bootstrap and stream handling stay in the background.
          {/if}
        </p>
      </div>
      <div class="actions">
        <button on:click={() => void initializeApp()} disabled={appPhase === "initializing"}>
          {#if appPhase === "initializing"}Preparing…{:else}Retry Bootstrap{/if}
        </button>
        <button on:click={() => void loadBoard()} disabled={loadingBoard || appPhase === "fatal-error"}>
          {#if loadingBoard}Loading…{:else}Reload Board{/if}
        </button>
      </div>
    </div>

    {#if bootstrapError}
      <p class="error">{bootstrapError}</p>
    {/if}
    {#if syncWarning}
      <p class="subtle">{syncWarning}</p>
    {/if}
    {#if runtimeError}
      <p class="error">{runtimeError}</p>
    {/if}
  </section>

  {#if appPhase !== "fatal-error" && board}
    <FeatureOverview
      feature={featureOverview.feature}
      runningCount={featureOverview.runningCount}
      reviewCount={featureOverview.reviewCount}
      blockedCount={featureOverview.blockedCount}
      recentAction={featureOverview.recentAction}
      actions={overviewActions}
      onRunAction={runOverviewAction}
    />

    <section class="workspace-grid">
      <BoardPane
        {board}
        {latestStatusByCard}
        {selectedFeatureId}
        {selectedChildId}
        activeExecutionCardId={activeExecutionCardId}
        onSelectCard={selectCard}
        onOpenCardActions={openActionDialog}
        onStartCard={handleBoardStartCard}
        onFocusRun={handleBoardFocusRun}
        onOpenReview={handleBoardOpenReview}
        onRetryCard={handleBoardRetryCard}
      />

      <InspectorPane
        {selectedFeature}
        {selectedChild}
        activeExecutionCardId={activeExecutionCardId}
        activeTab={activeInspectorTab}
        context={inspectorContext}
        loadingContext={loadingInspectorContext}
        contextError={inspectorError}
        latestStatus={selectedChild ? latestStatusByCard[selectedChild.id] ?? null : null}
        latestLifecycle={selectedLifecycle}
        actionLog={visibleActionLog}
        onSelectTab={(tab) => {
          activeInspectorTab = tab;
        }}
        onOpenActionDialog={openActionDialog}
      />
    </section>
  {/if}
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
        <button on:click={() => void executeAction()} disabled={executingAction}>
          {#if executingAction}Executing…{:else}Confirm Execute{/if}
        </button>
      </div>
    </section>
  </div>
{/if}
