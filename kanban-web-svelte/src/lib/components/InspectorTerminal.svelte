<script lang="ts">
import { onDestroy } from "svelte";

import { KanbanRuntimeApi } from "../api";
import {
  canSendTerminalLineInput,
  submitTerminalLineInput,
} from "../terminal/line-input";
import { createWTermSurface } from "../terminal/wterm-surface";
import type { CardRuntimeDetail } from "../types";

export let cardId: string | null;
export let activeExecutionCardId: string | null;
export let unavailableMessage: string | null = null;

const api = new KanbanRuntimeApi();
const terminalSurface = createWTermSurface();

let runtimeDetail: CardRuntimeDetail | null = null;
// biome-ignore lint/correctness/noUnusedVariables: Svelte template consumes this state.
let loadingRuntime = false;
// biome-ignore lint/correctness/noUnusedVariables: Svelte template consumes this state.
let terminalError: string | null = null;
let connectionStatus: "idle" | "connecting" | "connected" | "done" | "error" =
  "idle";
let currentKey = "";
let currentRequestId = 0;
let stream: EventSource | null = null;
// biome-ignore lint/correctness/noUnusedVariables: Svelte template consumes this state.
let hasTerminalOutput = false;
let terminalInput = "";
let submittingInput = false;
// biome-ignore lint/correctness/noUnusedVariables: Svelte template consumes this state.
let inputError: string | null = null;

$: canSendInput = canSendTerminalLineInput({
  cardId,
  runtimeDetail,
  unavailableMessage,
  terminalInput,
  submittingInput,
});
$: terminalInputHint = runtimeDetail?.session
  ? "Send one line to the active session"
  : "Open a session before sending input";

$: nextKey = cardId ?? "";
$: if (nextKey !== currentKey) {
  currentKey = nextKey;
  void refreshTerminal();
}

function disconnectStream(): void {
  if (!stream) {
    return;
  }

  stream.close();
  stream = null;
}

// biome-ignore lint/correctness/noUnusedVariables: Svelte use: directive references this function.
function mountTerminalSurface(node: HTMLDivElement): { destroy: () => void } {
  void terminalSurface.mount(node).catch((error) => {
    terminalError = error instanceof Error ? error.message : String(error);
    connectionStatus = "error";
  });

  return {
    destroy: () => {
      terminalSurface.destroy();
    },
  };
}

// biome-ignore lint/correctness/noUnusedVariables: Svelte template submit handler references this function.
async function submitLineInput(): Promise<void> {
  if (submittingInput) {
    return;
  }

  inputError = null;
  submittingInput = true;
  const result = await submitTerminalLineInput({
    cardId,
    runtimeDetail,
    unavailableMessage,
    terminalInput,
    submittingInput: false,
    sendTerminalInput: (cardId, input) => api.sendTerminalInput(cardId, input),
  });
  terminalInput = result.nextValue;
  inputError = result.error;
  submittingInput = false;
}

async function refreshTerminal(): Promise<void> {
  disconnectStream();
  const requestId = ++currentRequestId;
  runtimeDetail = null;
  hasTerminalOutput = false;
  terminalInput = "";
  inputError = null;
  submittingInput = false;
  terminalError = null;
  connectionStatus = cardId && !unavailableMessage ? "connecting" : "idle";

  try {
    await terminalSurface.reset();
  } catch (error) {
    if (requestId !== currentRequestId) {
      return;
    }

    terminalError = error instanceof Error ? error.message : String(error);
    connectionStatus = "error";
    return;
  }

  if (!cardId || unavailableMessage) {
    return;
  }

  loadingRuntime = true;

  try {
    const detail = await api.getCardRuntime(cardId);
    if (requestId !== currentRequestId) {
      return;
    }

    runtimeDetail = detail;
    if (!detail.terminal.available) {
      connectionStatus = "idle";
      return;
    }

    const nextStream = api.createTerminalEventSource(detail.terminal.streamUrl);
    nextStream.addEventListener("ready", () => {
      connectionStatus = "connected";
    });
    nextStream.addEventListener("chunk", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as {
          chunk?: string;
        };
        const chunk = payload.chunk ?? "";
        if (chunk) {
          hasTerminalOutput = true;
        }
        terminalSurface.write(chunk);
      } catch (error) {
        terminalError = error instanceof Error ? error.message : String(error);
        connectionStatus = "error";
      }
    });
    nextStream.addEventListener("done", () => {
      connectionStatus = "done";
    });
    nextStream.addEventListener("error", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as {
          error?: string;
        };
        terminalError = payload.error ?? "Terminal stream unavailable";
      } catch {
        terminalError = "Terminal stream unavailable";
      }
      connectionStatus = "error";
    });
    nextStream.onerror = () => {
      if (connectionStatus === "connecting") {
        terminalError = "Terminal stream unavailable";
        connectionStatus = "error";
      }
    };

    stream = nextStream;
  } catch (error) {
    if (requestId !== currentRequestId) {
      return;
    }

    terminalError = error instanceof Error ? error.message : String(error);
    connectionStatus = "error";
  } finally {
    if (requestId === currentRequestId) {
      loadingRuntime = false;
    }
  }
}

onDestroy(() => {
  disconnectStream();
  terminalSurface.destroy();
});
</script>

<section class="terminal-host">
  <div class="terminal-status-row">
    <div class="summary-pill">
      <span class="pill-label">Connection</span>
      <strong>{connectionStatus}</strong>
    </div>
    <div class="summary-pill wide">
      <span class="pill-label">Runtime summary</span>
      <strong>{unavailableMessage ?? runtimeDetail?.execution.summary ?? "Waiting for runtime detail"}</strong>
    </div>
  </div>

  {#if loadingRuntime}
    <p class="subtle">Connecting to child runtime…</p>
  {:else if terminalError}
    <p class="error">{terminalError}</p>
  {:else if !cardId}
    <p class="empty-state">Select a child card to attach the terminal surface.</p>
  {:else if unavailableMessage}
    <p class="empty-state">{unavailableMessage}</p>
  {:else if !runtimeDetail?.terminal.available}
    <p class="empty-state">No live terminal available for this child yet.</p>
  {:else}
    <div class="terminal-meta-grid">
      <div>
        <dt>Card</dt>
        <dd>{cardId}</dd>
      </div>
      <div>
        <dt>Execution focus</dt>
        <dd>{activeExecutionCardId === cardId ? "active" : "standby"}</dd>
      </div>
      <div>
        <dt>Session</dt>
        <dd>{runtimeDetail?.session?.chatJid ?? "<none>"}</dd>
      </div>
      <div>
        <dt>Worktree</dt>
        <dd>{runtimeDetail?.session?.worktreePath ?? "<none>"}</dd>
      </div>
    </div>

    <div class="terminal-mode-row">
      <span class="badge">read-only</span>
      <p class="subtle">
        {#if hasTerminalOutput}
          Live daemon terminal output is streaming into this surface.
        {:else}
          Waiting for terminal output…
        {/if}
      </p>
    </div>

    <div class="terminal-surface wterm-host" use:mountTerminalSurface></div>

    <form class="terminal-input-form" on:submit|preventDefault={() => void submitLineInput()}>
      <span class="badge">line input</span>
      <input
        class="terminal-input-field"
        type="text"
        bind:value={terminalInput}
        placeholder={terminalInputHint}
        disabled={!runtimeDetail?.session || submittingInput}
      />
      <button type="submit" disabled={!canSendInput}>
        {submittingInput ? "Sending…" : "Send"}
      </button>
    </form>

    {#if inputError}
      <p class="error">{inputError}</p>
    {:else if !runtimeDetail?.session}
      <p class="subtle">{terminalInputHint}</p>
    {/if}
  {/if}
</section>
